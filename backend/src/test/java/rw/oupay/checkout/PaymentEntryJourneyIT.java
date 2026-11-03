package rw.oupay.checkout;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;

/**
 * R8b: the whole customer journey of ONE printed device, in order, through the real HTTP API: the same QR or tag serves sale after sale without
 * being regenerated, a second customer never sees the first one's bill, finishing a bill lets the next one be bound safely, a demonstration
 * journey changes no money and no stock, and revoking one device never affects another. This is software validation: it proves nothing about a
 * phone camera or an NFC reader (see docs/payment-entry-field-test.md).
 */
class PaymentEntryJourneyIT extends PaymentEntryTestSupport {

    private String claimed(String token, String proposal) {
        var response = claimAs(token, proposal);
        assertThat(state(response)).isEqualTo("CLAIMED");
        return proposal;
    }

    @Test
    void theSamePrintedDeviceServesSaleAfterSaleWithoutBeingRegeneratedAndNeverMixesCustomers() {
        // 1-2. The merchant registers a static QR: one permanent, opaque path.
        JsonNode d = device("STATIC_QR", "Counter 1", w.cashierPerson.userId());
        String permanent = d.path("entryPath").asString();
        String token = token(d);
        assertThat(permanent).matches("^/e/[A-Za-z0-9_-]{22}$");

        // 5. The cashier explicitly binds a prepared bill (nothing is shown to customers before that).
        assertThat(state(viewAs(token, null))).isEqualTo("IDLE");
        JsonNode first = liveSale();
        bound(d, first);
        assertThat(state(viewAs(token, null))).isEqualTo("READY");

        // 6-7. Customer A claims and sees the correct bill: exact amount and sale reference, the bank code, and no payment claim.
        String a = claimed(token, "A".repeat(43));
        var viewA = viewAs(token, a);
        assertThat(viewA.json().path("sale").path("amountRwf").asLong()).isEqualTo(amount(first));
        assertThat(viewA.json().path("sale").path("saleReference").asString()).isEqualTo(reference(first));
        assertThat(viewA.json().path("sale").path("status").asString()).isEqualTo("AWAITING_PAYMENT");

        // 8. Customer B, scanning the same code meanwhile, sees only "payment in progress"; the cashier sees the device is busy.
        var viewB = viewAs(token, null);
        assertThat(state(viewB)).isEqualTo("BUSY");
        assertThat(viewB.body()).doesNotContain(reference(first)).doesNotContain(String.valueOf(amount(first))).doesNotContain("EQ-LIVE-77");
        assertThat(fresh(d).path("binding").path("customerSessionActive").asBoolean()).isTrue();

        // Customer A pays through the (simulated) bank evidence; only the bank decides, and A sees it.
        pay(first);
        assertThat(viewAs(token, a).json().path("sale").path("status").asString()).isEqualTo("PAID");
        // A finished bill is never shown to anybody new: the device is idle again.
        assertThat(state(releaseAs(token, a))).isEqualTo("SESSION_ENDED");
        assertThat(state(viewAs(token, null))).isEqualTo("IDLE");

        // 9-10. Ending the claim lets the next bill be bound safely, on the SAME printed code (the path never changed).
        JsonNode second = liveSale();
        JsonNode rebound = bound(d, second);
        assertThat(rebound.path("entryPath").asString()).isEqualTo(permanent);
        assertThat(jdbc.queryForList("select end_reason from payment_entry_bindings where ended_at is not null", String.class)).containsExactly("SALE_PAID");
        String b = claimed(token, "B".repeat(43));
        assertThat(viewAs(token, b).json().path("sale").path("saleReference").asString()).isEqualTo(reference(second));
        // A, returning with their own token, still sees THEIR paid bill and never B's.
        var back = viewAs(token, a);
        assertThat(back.json().path("sale").path("saleReference").asString()).isEqualTo(reference(first));
        assertThat(back.body()).doesNotContain(reference(second));
        // Nothing about the device identity changed across the whole journey.
        assertThat(fresh(d).path("entryPath").asString()).isEqualTo(permanent);
        assertThat(count("payment_entry_devices")).isEqualTo(1);
    }

    @Test
    void aTimeoutIsNeverProofOfFailureAndAnExplicitCloseNeedsConfirmationAndKeepsTheCustomerOnTheirBill() {
        JsonNode sale = liveSale();
        JsonNode d = device("STATIC_QR", "Counter 1", null);
        bound(d, sale);
        String token = token(d);
        String claim = claimed(token, "C".repeat(43));
        // Explicit closing: refused without confirmation, allowed with it, and the customer still sees their own bill, never "failed".
        assertThat(unbind(w.owner, d, false).code()).isEqualTo("customer_session_active");
        assertThat(unbind(w.owner, d, true).status()).isEqualTo(200);
        var ended = viewAs(token, claim);
        assertThat(state(ended)).isEqualTo("SESSION_ENDED");
        assertThat(ended.json().path("claim").path("endReason").asString()).isEqualTo("BINDING_ENDED");
        assertThat(ended.json().path("sale").path("status").asString()).isEqualTo("AWAITING_PAYMENT");
        assertThat(ended.body()).doesNotContainIgnoringCase("failed");
        // The bill is unchanged and can still be paid with its code; the evidence is applied as usual.
        pay(sale);
        assertThat(viewAs(token, claim).json().path("sale").path("status").asString()).isEqualTo("PAID");
        assertThat(count("payment_allocations")).isEqualTo(1);
    }

    @Test
    void twoSeparatelyRegisteredDevicesAreIndependentAndRevokingOneLeavesTheOtherWorking() {
        JsonNode qr = device("STATIC_QR", "Counter 1", null);
        JsonNode tag = device("NFC_TAG", "Door tag", null);
        assertThat(token(qr)).isNotEqualTo(token(tag));
        JsonNode one = liveSale();
        JsonNode two = liveSale();
        bound(qr, one);
        bound(tag, two);
        String claimQr = claimed(token(qr), "Q".repeat(43));
        String claimTag = claimed(token(tag), "T".repeat(43));
        // Each device leads to its own bill; one's claim opens nothing at the other.
        assertThat(viewAs(token(qr), claimQr).json().path("sale").path("saleReference").asString()).isEqualTo(reference(one));
        assertThat(viewAs(token(tag), claimQr).json().path("sale").path("saleReference").isMissingNode()).isTrue();
        assertThat(lifecycle(w.owner, qr, "revoke", "QR sticker lost").status()).isEqualTo(200);
        // The revoked device's URL (every copy of it) is dead for newcomers; the other device is untouched.
        assertThat(state(viewAs(token(qr), null))).isEqualTo("UNAVAILABLE");
        assertThat(state(claimAs(token(qr), "N".repeat(43)))).isEqualTo("UNAVAILABLE");
        assertThat(state(viewAs(token(tag), claimTag))).isEqualTo("CLAIMED");
        assertThat(state(unbindThenView(tag, token(tag)))).isEqualTo("IDLE");
    }

    private rw.oupay.support.TestApi.Response unbindThenView(JsonNode device, String token) {
        assertThat(unbind(w.owner, device, true).status()).isEqualTo(200);
        return viewAs(token, null);
    }

    @Test
    void aDemonstrationJourneyOffersNoRealCodeAndChangesNoMoneyAndNoStock() {
        demo();
        JsonNode sale = billed(saveDraft(line(rice, "1", "kg")));
        assertThat(sale.path("mode").asString()).isEqualTo("DEMONSTRATION");
        Map<String, Integer> before = snapshot();
        JsonNode d = device("STATIC_QR", "Counter 1", null);
        bound(d, sale);
        String token = token(d);
        var claimed = claimAs(token, "D".repeat(43));
        JsonNode view = claimed.json().path("sale");
        assertThat(state(claimed)).isEqualTo("CLAIMED");
        assertThat(view.path("code").path("mode").asString()).isEqualTo("DEMONSTRATION");
        assertThat(absent(view.path("code").path("bankCode"))).isTrue();
        assertThat(view.path("instructions")).isEmpty();
        assertThat(view.path("statusNote").asString()).contains("demonstration");
        assertThat(claimed.body()).doesNotContain("EQ-DEMO-1");
        assertThat(state(releaseAs(token, "D".repeat(43)))).isEqualTo("SESSION_ENDED");
        assertThat(unbind(w.owner, d, false).status()).isEqualTo(200);
        // Scanning, claiming, releasing and closing created no bank transaction, no allocation, no stock movement, no reservation, no invoice.
        Map<String, Integer> after = snapshot();
        after.keySet().removeAll(List.of("claims", "bindings", "devices", "assignments"));
        before.keySet().removeAll(List.of("claims", "bindings", "devices", "assignments"));
        assertThat(after).isEqualTo(before);
        // The demonstration stays out of the business's real invoice list.
        var invoices = w.owner.get("/api/v1/merchants/" + w.merchantId + "/invoices").json();
        assertThat(invoices.toString()).doesNotContain(sale.path("sale").path("invoiceNumber").asString());
    }

    private Map<String, Integer> snapshot() {
        Map<String, Integer> counts = new HashMap<>();
        for (String table : List.of("bank_transactions", "payment_allocations", "stock_movements", "stock_reservations", "invoices", "payment_requests", "code_sales",
                "payment_entry_claims", "payment_entry_bindings", "payment_entry_devices", "payment_entry_device_assignments")) {
            String key = table.startsWith("payment_entry_") ? table.substring("payment_entry_".length()).replace("device_assignments", "assignments") : table;
            counts.put(key, count(table));
        }
        return counts;
    }
}
