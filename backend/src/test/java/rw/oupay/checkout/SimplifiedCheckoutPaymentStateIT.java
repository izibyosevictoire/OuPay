package rw.oupay.checkout;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpMethod;
import rw.oupay.support.TestApi;

/**
 * What the cashier's page reads for a checkout sale (the invoice and its payment request) in every payment situation, against the
 * real bank-event processor. Nothing but a verified, matched bank event ever makes a sale paid.
 */
class SimplifiedCheckoutPaymentStateIT extends CheckoutTestSupport {

    private JsonView billSale(long amount) {
        var response = bill(w.cashier, "key-" + UUID.randomUUID(), sale(amount, "Moto ride", UUID.randomUUID()));
        assertThat(response.status()).as(response.body()).isEqualTo(201);
        return new JsonView(response);
    }

    private record JsonView(TestApi.Response response) {
        UUID invoiceId() {
            return UUID.fromString(response.json().path("invoiceId").asString());
        }

        String reference() {
            return response.json().path("publicReference").asString();
        }

        String token() {
            return response.json().path("profileToken").asString();
        }
    }

    private String paymentStatus(JsonView sale) {
        return invoice(sale.invoiceId()).json().path("paymentStatus").asString();
    }

    private String requestStatus(JsonView sale) {
        return w.cashier.get("/api/v1/merchants/" + w.merchantId + "/invoices/" + sale.invoiceId() + "/payment-requests")
                .json().get(0).path("status").asString();
    }

    @Test
    void aCustomersClaimAndAPendingBankEventNeverMakeASalePaid() {
        ensureProfile();
        var sale = billSale(20_000);
        // The customer says they paid.
        var claim = TestApi.anonymous(mvc, HttpMethod.POST, "/api/v1/public/payment-profiles/" + sale.token() + "/requests/"
                + sale.reference() + "/claim", null, java.util.Map.of());
        assertThat(claim.status()).isEqualTo(204);
        assertThat(paymentStatus(sale)).isEqualTo("UNPAID");
        assertThat(requestStatus(sale)).isNotEqualTo("SETTLED");
        // The bank says it is pending.
        assertThat(w.bank.send("PENDING", 20_000, sale.reference(), "tx-pending-1", "evt-p1", w.bank.at(1)).outcome()).isEqualTo("APPLIED");
        assertThat(paymentStatus(sale)).isEqualTo("UNPAID");
        assertThat(requestStatus(sale)).isIn("CREATED", "AWAITING_PAYMENT");
        assertThat(count("payment_allocations")).isZero();
    }

    @Test
    void aVerifiedMatchedPaymentIsPaidAndAPartialOneReportsTheExactRemainder() {
        ensureProfile();
        var partial = billSale(20_000);
        assertThat(w.bank.send("POSTED", 8_000, partial.reference(), "tx-part-1", "evt-part1", w.bank.at(1)).outcome()).isEqualTo("APPLIED");
        var invoice = invoice(partial.invoiceId()).json();
        assertThat(invoice.path("paymentStatus").asString()).isEqualTo("PARTIALLY_PAID");
        assertThat(invoice.path("payment").path("allocatedAmount").asLong()).isEqualTo(8_000);
        assertThat(invoice.path("payment").path("remainingBalance").asLong()).isEqualTo(12_000);
        assertThat(requestStatus(partial)).isEqualTo("PARTIALLY_SETTLED");

        assertThat(w.bank.send("POSTED", 12_000, partial.reference(), "tx-part-2", "evt-part2", w.bank.at(2)).outcome()).isEqualTo("APPLIED");
        assertThat(paymentStatus(partial)).isEqualTo("PAID");
        assertThat(requestStatus(partial)).isEqualTo("SETTLED");
        assertThat(invoice(partial.invoiceId()).json().path("payment").path("remainingBalance").asLong()).isZero();
    }

    @Test
    void moneyConfirmedAfterExpiryIsReconciledAndAReversalTakesThePaidStateAway() {
        ensureProfile();
        var sale = billSale(20_000);
        jdbc.update("update payment_requests set expires_at = now() - interval '1 minute'");
        assertThat(requestStatus(sale)).isEqualTo("EXPIRED");
        assertThat(paymentStatus(sale)).isEqualTo("UNPAID");

        assertThat(w.bank.send("POSTED", 20_000, sale.reference(), "tx-late-1", "evt-late1", w.bank.at(1)).outcome()).isEqualTo("APPLIED");
        assertThat(paymentStatus(sale)).isEqualTo("PAID");
        assertThat(requestStatus(sale)).isEqualTo("SETTLED");

        // The bank later reverses it: the sale is no longer paid.
        assertThat(w.bank.update("tx-late-1", "REVERSED", 20_000, sale.reference()).outcome()).isEqualTo("APPLIED");
        assertThat(paymentStatus(sale)).isNotEqualTo("PAID");
        assertThat(invoice(sale.invoiceId()).json().path("payment").path("remainingBalance").asLong()).isEqualTo(20_000);
        assertThat(requestStatus(sale)).isNotEqualTo("SETTLED");
    }

    @Test
    void aConfirmedPaymentThatMatchesNoSaleIsNotReportedAsReconciled() {
        ensureProfile();
        var sale = billSale(20_000);
        // Confirmed by the bank, but with no reference to this sale: it is money received, not this sale paid.
        assertThat(w.bank.send("POSTED", 20_000, null, "tx-unmatched-1", "evt-un1", w.bank.at(1)).outcome()).isEqualTo("APPLIED");
        assertThat(paymentStatus(sale)).isEqualTo("UNPAID");
        assertThat(requestStatus(sale)).isNotEqualTo("SETTLED");
        assertThat(count("payment_allocations")).isZero();
        assertThat(count("bank_transactions")).isEqualTo(1);
    }

    @Test
    void theCustomerLinkIsTheLockedAmountRequestNeverTheOpenAmountPage() {
        ensureProfile();
        var sale = billSale(20_000);
        String path = sale.response().json().path("paymentPath").asString();
        assertThat(path).isEqualTo("/p/" + sale.token() + "/r/" + sale.reference());
        // The page that path serves is the fixed-amount request tied to the invoice.
        var page = TestApi.anonymous(mvc, HttpMethod.GET, "/api/v1/public/payment-profiles/" + sale.token() + "/requests/" + sale.reference(),
                null, java.util.Map.of());
        assertThat(page.status()).isEqualTo(200);
        assertThat(page.json().path("isAmountFixed").asBoolean()).isTrue();
        assertThat(page.json().path("requestedAmount").asLong()).isEqualTo(20_000);
        assertThat(page.json().path("invoiceReference").asString()).isEqualTo(sale.response().json().path("invoiceNumber").asString());
        // The request really is the invoice's, with the invoice's amount, on the business's own link.
        var row = jdbc.queryForMap("select invoice_id, requested_amount_rwf, merchant_id from payment_requests where public_reference = ?", sale.reference());
        assertThat(row.get("invoice_id")).isEqualTo(sale.invoiceId());
        assertThat(((Number) row.get("requested_amount_rwf")).longValue()).isEqualTo(20_000);
        assertThat(row.get("merchant_id")).isEqualTo(w.merchantId);
    }
}
