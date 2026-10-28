package rw.oupay.checkout;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.test.context.TestPropertySource;
import tools.jackson.databind.JsonNode;

/**
 * R6c: real bank money against code sales, through the ACTUAL ledger paths (the signed provider webhook, the event processor, manual
 * reconciliation and the database triggers). A DEMONSTRATION sale never takes bank money, by any route. No CODE sale is matched
 * automatically until bank attribution (R6d) has real evidence. Ordinary invoices still reconcile exactly as before.
 */
@TestPropertySource(properties = {
        "oupay.collection-codes.approval-enabled=true",
        "oupay.code-checkout.live-enabled=true"})
class CodeSaleLedgerIsolationIT extends CodeCheckoutTestSupport {

    private JsonNode demoSale(long amount) {
        ensureProfile();
        JsonNode code = activeCode("Demo " + UUID.randomUUID().toString().substring(0, 6), "EQ-DEMO-" + amount);
        assertThat(assign(code, cashierMembership).status()).isEqualTo(201);
        var created = bill(w.cashier, "key-" + UUID.randomUUID(), body(amount, null, UUID.fromString(id(code)), UUID.randomUUID()));
        assertThat(created.status()).as(created.body()).isEqualTo(201);
        assertThat(created.json().path("code").path("mode").asString()).isEqualTo("DEMONSTRATION");
        return created.json();
    }

    private JsonNode liveSale(long amount) {
        makeAccountReal();
        ensureProfile();
        JsonNode code = activeCode("Live", "EQ-LIVE-77");
        assertThat(assign(code, cashierMembership).status()).isEqualTo(201);
        var created = bill(w.cashier, "key-" + UUID.randomUUID(), body(amount, null, null, UUID.randomUUID()));
        assertThat(created.status()).as(created.body()).isEqualTo(201);
        assertThat(created.json().path("code").path("mode").asString()).isEqualTo("LIVE");
        return created.json();
    }

    private String m(String path) {
        return "/api/v1/merchants/" + w.merchantId + path;
    }

    private int allocations() {
        return count("payment_allocations");
    }

    private Map<String, Object> txRow(String providerTransactionId) {
        return jdbc.queryForMap("select id, status, payment_request_id, review_state from bank_transactions where provider_transaction_id = ?",
                providerTransactionId);
    }

    private String invoiceNumber(JsonNode sale) {
        return jdbc.queryForObject("select invoice_number from invoices where id = ?::uuid", String.class, sale.path("invoiceId").asString());
    }

    private void assertNotPayable(JsonNode sale) {
        String reference = sale.path("saleReference").asString();
        var agent = w.cashier.get(sale() + "/" + sale.path("saleId").asString()).json();
        assertThat(agent.path("status").asString()).isEqualTo("AWAITING_PAYMENT");
        assertThat(agent.path("confirmedAmount").asLong()).isZero();
        assertThat(agent.path("amountDue").asLong()).isEqualTo(sale.path("amountRwf").asLong());
        var customer = publicSale(reference).json();
        assertThat(customer.path("status").asString()).isEqualTo("AWAITING_PAYMENT");
        assertThat(customer.path("confirmedAmount").asLong()).isZero();
        var invoice = w.owner.get(m("/invoices/" + sale.path("invoiceId").asString())).json();
        assertThat(invoice.path("paymentStatus").asString()).isEqualTo("UNPAID");
    }

    // ---- demonstration sales: bank money never applies, by any route ---------------------------

    @Test
    void realMoneyNamingADemoSalesReferenceIsNeverAppliedToIt() {
        JsonNode sale = demoSale(10_000);
        String reference = sale.path("saleReference").asString();

        var delivery = w.bank.pay("POSTED", 10_000, reference);
        assertThat(delivery.outcome()).isEqualTo("APPLIED");
        var tx = txRow(delivery.transactionId());
        // The money is verified (CONFIRMED) and stays unmatched: never linked to the sale, never allocated, flagged for a person to review.
        assertThat(tx.get("status")).isEqualTo("CONFIRMED");
        assertThat(tx.get("payment_request_id")).isNull();
        assertThat(tx.get("review_state")).isEqualTo("NEEDS_REVIEW");
        assertThat(allocations()).isZero();
        assertNotPayable(sale);
    }

    @Test
    void theInvoiceNumberOfADemoSaleIsNotAMatchEither() {
        JsonNode sale = demoSale(10_000);
        var delivery = w.bank.pay("POSTED", 10_000, invoiceNumber(sale));
        var tx = txRow(delivery.transactionId());
        assertThat(tx.get("status")).isEqualTo("CONFIRMED");
        assertThat(tx.get("review_state")).isEqualTo("NEEDS_REVIEW");
        assertThat(allocations()).isZero();
        assertNotPayable(sale);
    }

    @Test
    void anExactAmountAtTheRightTimeFromTheRightAgentIsNotEvidence() {
        JsonNode sale = demoSale(7_500);
        // No reference at all: amount, time and merchant match, and that is all.
        var delivery = w.bank.pay("POSTED", 7_500, null);
        assertThat(txRow(delivery.transactionId()).get("payment_request_id")).isNull();
        assertThat(allocations()).isZero();
        assertNotPayable(sale);
    }

    @Test
    void duplicateLateAndReversedEventsCannotBypassIt() {
        JsonNode sale = demoSale(10_000);
        String reference = sale.path("saleReference").asString();

        // Pending is not money; it becomes confirmed, then a duplicate and a replay under a new event id; then a second payment.
        var pending = w.bank.pay("PENDING", 10_000, reference);
        assertThat(allocations()).isZero();
        w.bank.update(pending.transactionId(), "POSTED", 10_000, reference);
        w.bank.update(pending.transactionId(), "POSTED", 10_000, reference);
        w.bank.update(pending.transactionId(), "POSTED", 10_000, reference);
        w.bank.pay("POSTED", 4_000, reference);
        assertThat(allocations()).isZero();
        assertNotPayable(sale);

        // A bank reversal of money that was never applied leaves the books exactly as they were.
        var reversal = w.bank.update(pending.transactionId(), "REVERSED", 10_000, reference);
        assertThat(reversal.outcome()).isEqualTo("APPLIED");
        assertThat(allocations()).isZero();
        assertNotPayable(sale);
        // A late event for the same transaction, even a confirmation, cannot move it back.
        w.bank.update(pending.transactionId(), "POSTED", 10_000, reference);
        assertThat(allocations()).isZero();
        assertNotPayable(sale);
    }

    @Test
    void manualReconciliationCannotApplyBankMoneyToADemoSaleAndItIsNotOffered() {
        JsonNode sale = demoSale(10_000);
        UUID demoInvoice = UUID.fromString(sale.path("invoiceId").asString());
        UUID ordinary = w.issuedInvoice(5_000);
        var delivery = w.bank.pay("POSTED", 20_000, null);
        var tx = w.owner.get(m("/bank-transactions")).json().path("items").get(0);
        String txId = tx.path("id").asString();
        long version = tx.path("version").asLong();

        // The picker never offers a demonstration sale...
        var payable = w.owner.get(m("/payable-invoices")).json();
        List<String> offered = new java.util.ArrayList<>();
        payable.forEach(p -> offered.add(p.path("invoiceId").asString()));
        assertThat(offered).contains(ordinary.toString()).doesNotContain(demoInvoice.toString());

        // ... and a crafted request is refused at the allocation boundary, with nothing applied, not even to the ordinary invoice beside it.
        var refused = w.owner.post(m("/reconciliation/allocations"), Map.of("bankTransactionId", txId, "expectedTransactionVersion", version,
                "allocations", List.of(
                        Map.of("invoiceId", ordinary.toString(), "amount", 5_000, "expectedRemainingBalance", 5_000),
                        Map.of("invoiceId", demoInvoice.toString(), "amount", 10_000, "expectedRemainingBalance", 10_000)),
                "note", "crafted"));
        assertThat(refused.status()).as(refused.body()).isEqualTo(409);
        assertThat(refused.code()).isEqualTo("code_sale_not_payable");
        assertThat(allocations()).isZero();
        assertThat(delivery.outcome()).isEqualTo("APPLIED");
        assertNotPayable(sale);
    }

    @Test
    void theDatabaseItselfRefusesAnAllocationToADemoSale() {
        JsonNode sale = demoSale(10_000);
        w.bank.pay("POSTED", 10_000, null);
        UUID transaction = jdbc.queryForObject("select id from bank_transactions", UUID.class);
        UUID invoice = UUID.fromString(sale.path("invoiceId").asString());
        for (String origin : List.of("MANUAL", "AUTO_REFERENCE")) {
            assertThatThrownBy(() -> jdbc.update("insert into payment_allocations (id, merchant_id, bank_transaction_id, invoice_id, amount_rwf, status, origin, "
                            + "created_by_user_id, created_at) values (?, ?, ?, ?, 10000, 'ACTIVE', ?, ?, now())",
                    UUID.randomUUID(), w.merchantId, transaction, invoice, origin, w.ownerPerson.userId()))
                    .hasMessageContaining("demonstration code sale");
        }
        assertThat(allocations()).isZero();
    }

    // ---- code sales are not matched automatically, live or not ----------------------------------

    @Test
    void aLiveCodeSaleIsNotMatchedAutomaticallyButAnAuthorisedPersonMayApplyTheMoney() {
        JsonNode sale = liveSale(10_000);
        String reference = sale.path("saleReference").asString();
        UUID invoice = UUID.fromString(sale.path("invoiceId").asString());

        var delivery = w.bank.pay("POSTED", 10_000, reference);
        var tx = txRow(delivery.transactionId());
        assertThat(tx.get("status")).isEqualTo("CONFIRMED");
        assertThat(tx.get("payment_request_id")).isNull();
        assertThat(tx.get("review_state")).isEqualTo("NEEDS_REVIEW");
        assertThat(allocations()).isZero();
        // The customer is told the truth: the bank reported money that is not matched to the sale yet. Never "paid".
        assertThat(publicSale(reference).json().path("status").asString()).isEqualTo("REQUIRES_RECONCILIATION");
        assertThat(w.owner.get(m("/invoices/" + invoice)).json().path("paymentStatus").asString()).isEqualTo("UNPAID");

        // The invoice number is not a match either.
        w.bank.pay("POSTED", 10_000, invoiceNumber(sale));
        assertThat(allocations()).isZero();

        // A person with the authority and the evidence may apply it by hand (the existing, audited manual path).
        var row = w.owner.get(m("/bank-transactions/" + tx.get("id"))).json().path("transaction");
        var applied = w.owner.post(m("/reconciliation/allocations"), Map.of("bankTransactionId", tx.get("id").toString(),
                "expectedTransactionVersion", row.path("version").asLong(),
                "allocations", List.of(Map.of("invoiceId", invoice.toString(), "amount", 10_000, "expectedRemainingBalance", 10_000)),
                "note", "Customer showed the bank receipt"));
        assertThat(applied.status()).as(applied.body()).isEqualTo(200);
        assertThat(allocations()).isEqualTo(1);
        assertThat(jdbc.queryForObject("select origin from payment_allocations", String.class)).isEqualTo("MANUAL");
        assertThat(publicSale(reference).json().path("status").asString()).isEqualTo("PAID");
    }

    @Test
    void theDatabaseRefusesAnAutomaticAllocationToALiveCodeSale() {
        JsonNode sale = liveSale(10_000);
        w.bank.pay("POSTED", 10_000, null);
        UUID transaction = jdbc.queryForObject("select id from bank_transactions", UUID.class);
        assertThatThrownBy(() -> jdbc.update("insert into payment_allocations (id, merchant_id, bank_transaction_id, invoice_id, amount_rwf, status, origin, "
                        + "created_at) values (?, ?, ?, ?, 10000, 'ACTIVE', 'AUTO_REFERENCE', now())",
                UUID.randomUUID(), w.merchantId, transaction, UUID.fromString(sale.path("invoiceId").asString())))
                .hasMessageContaining("not matched to bank money automatically");
        assertThat(allocations()).isZero();
    }

    // ---- everything else keeps working -----------------------------------------------------------

    @Test
    void anOrdinaryInvoiceStillReconcilesAutomaticallyByItsNumberNextToACodeSale() {
        demoSale(10_000);
        UUID invoice = w.issuedInvoice(30_000);
        String number = jdbc.queryForObject("select invoice_number from invoices where id = ?", String.class, invoice);
        w.bank.pay("POSTED", 30_000, number);
        assertThat(allocations()).isEqualTo(1);
        assertThat(jdbc.queryForObject("select origin from payment_allocations", String.class)).isEqualTo("AUTO_REFERENCE");
        assertThat(w.owner.get(m("/invoices/" + invoice)).json().path("paymentStatus").asString()).isEqualTo("PAID");
    }
}
