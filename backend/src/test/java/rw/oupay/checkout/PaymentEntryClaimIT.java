package rw.oupay.checkout;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Callable;
import org.junit.jupiter.api.Test;
import rw.oupay.support.TestApi;
import tools.jackson.databind.JsonNode;

/**
 * R8a: the customer side. A stable QR or NFC URL must never show a customer a different bill part-way through, two customers can never share
 * one device, opening the URL never takes it, a timeout is never read as a failed payment, and nothing here ever says money arrived.
 */
class PaymentEntryClaimIT extends PaymentEntryTestSupport {

    private JsonNode readyDevice(JsonNode sale) {
        JsonNode d = device("STATIC_QR", "Counter", null);
        bound(d, sale);
        return d;
    }

    private int openClaims() {
        return jdbc.queryForObject("select count(*) from payment_entry_claims where ended_at is null", Integer.class);
    }

    // ---- opening the URL is read-only ------------------------------------------------------------

    @Test
    void openingTheUrlNeverTakesTheDeviceSoAPrefetcherCannotLockOutCustomers() {
        JsonNode sale = liveSale();
        JsonNode d = readyDevice(sale);
        String token = token(d);
        for (int i = 0; i < 5; i++) {
            var view = viewAs(token, null);
            assertThat(state(view)).isEqualTo("READY");
            // A pre-fetch learns that a bill is ready, and nothing of it: no amount, no reference, no code.
            assertThat(view.body()).doesNotContain(reference(sale)).doesNotContain("EQ-LIVE-77").doesNotContain(String.valueOf(amount(sale)));
        }
        assertThat(count("payment_entry_claims")).isZero();
        assertThat(state(claimAs(token, null))).isEqualTo("CLAIMED");
    }

    // ---- two customers ------------------------------------------------------------------------------

    @Test
    void theFirstCustomerHoldsTheBillAndTheSecondOneSeesOnlyPaymentInProgress() {
        JsonNode sale = liveSale();
        String token = token(readyDevice(sale));
        var first = claimAs(token, null);
        assertThat(state(first)).isEqualTo("CLAIMED");
        String claim = first.json().path("claim").path("claimToken").asString();
        assertThat(first.json().path("sale").path("saleReference").asString()).isEqualTo(reference(sale));
        assertThat(first.json().path("sale").path("amountRwf").asLong()).isEqualTo(amount(sale));
        assertThat(first.json().path("sale").path("code").path("bankCode").asString()).isEqualTo("EQ-LIVE-77");
        assertThat(first.json().path("sale").path("instructions")).hasSize(2);

        // A second customer, scanning at the same moment, or looking again: payment in progress, and not one detail of the first customer's bill.
        for (TestApi.Response stranger : List.of(claimAs(token, null), viewAs(token, null), claimAs(token, "A".repeat(43)), viewAs(token, "not-a-token"))) {
            assertThat(state(stranger)).isEqualTo("BUSY");
            assertThat(stranger.body()).doesNotContain(reference(sale)).doesNotContain("EQ-LIVE-77").doesNotContain(String.valueOf(amount(sale))).doesNotContain(claim);
            assertThat(absent(stranger.json().path("sale"))).isTrue();
        }
        assertThat(openClaims()).isEqualTo(1);

        // The holder keeps seeing the very same bill, and asking again renews only their own session (no new token is minted).
        var again = claimAs(token, claim);
        assertThat(state(again)).isEqualTo("CLAIMED");
        assertThat(absent(again.json().path("claim").path("claimToken"))).isTrue();
        assertThat(again.json().path("sale").path("saleReference").asString()).isEqualTo(reference(sale));
        assertThat(state(viewAs(token, claim))).isEqualTo("CLAIMED");
        assertThat(count("payment_entry_claims")).isEqualTo(1);
    }

    @Test
    void manyCustomersScanningAtTheSameMomentProduceExactlyOneHolder() throws Exception {
        String token = token(readyDevice(liveSale()));
        List<Callable<TestApi.Response>> tasks = new ArrayList<>();
        for (int i = 0; i < 8; i++) {
            tasks.add(() -> claimAs(token, null));
        }
        List<TestApi.Response> answers = concurrently(tasks);
        long holders = answers.stream().filter(r -> "CLAIMED".equals(r.json().path("state").asString())).count();
        long busy = answers.stream().filter(r -> "BUSY".equals(r.json().path("state").asString())).count();
        assertThat(holders).isEqualTo(1);
        assertThat(busy).isEqualTo(7);
        assertThat(count("payment_entry_claims")).isEqualTo(1);
        assertThat(openClaims()).isEqualTo(1);
    }

    @Test
    void theClaimSecretIsNeverStoredAndBelongsToOneDeviceOnly() {
        JsonNode sale = liveSale();
        JsonNode d = readyDevice(sale);
        String token = token(d);
        String claim = claimToken(token);
        assertThat(jdbc.queryForObject("select count(*) from payment_entry_claims where claim_token_hash = ?", Integer.class, claim)).isZero();
        assertThat(jdbc.queryForObject("select claim_token_hash from payment_entry_claims", String.class)).isEqualTo(sha256(claim)).hasSize(64);
        // The secret of device A opens nothing at device B, even where B is also busy with a bill.
        JsonNode other = device("NFC_TAG", "Other tag", null);
        bound(other, liveSale());
        assertThat(state(viewAs(token(other), claim))).isEqualTo("READY");
        assertThat(viewAs(token(other), claim).body()).doesNotContain(reference(sale));
    }

    // ---- time, expiry and late payment ---------------------------------------------------------------

    @Test
    void aReturningCustomerKeepsTheirOriginalBillAfterTheirSessionEndsAndTheDeviceFreesForTheNext() {
        JsonNode sale = liveSale();
        JsonNode d = readyDevice(sale);
        String token = token(d);
        String claim = claimToken(token);
        expireClaims(d);
        // A timeout only frees the doorway. The holder, returning, still sees THEIR bill with its real status; it is not called failed.
        var back = viewAs(token, claim);
        assertThat(state(back)).isEqualTo("SESSION_ENDED");
        assertThat(back.json().path("claim").path("endReason").asString()).isEqualTo("EXPIRED");
        assertThat(back.json().path("sale").path("saleReference").asString()).isEqualTo(reference(sale));
        assertThat(back.json().path("sale").path("status").asString()).isEqualTo("AWAITING_PAYMENT");
        assertThat(back.json().path("message").asString()).doesNotContainIgnoringCase("failed");
        // Someone else may now take the doorway for the bill that is still the device's current bill.
        assertThat(state(claimAs(token, null))).isEqualTo("CLAIMED");
        assertThat(openClaims()).isEqualTo(1);
        assertThat(jdbc.queryForObject("select count(*) from payment_entry_claims where end_reason = 'EXPIRED'", Integer.class)).isEqualTo(1);
    }

    @Test
    void aLateBankConfirmationReachesTheCustomerWhoseSessionHadAlreadyEnded() {
        JsonNode sale = liveSale();
        JsonNode d = readyDevice(sale);
        String token = token(d);
        String claim = claimToken(token);
        expireClaims(d);
        assertThat(viewAs(token, claim).json().path("sale").path("status").asString()).isEqualTo("AWAITING_PAYMENT");
        pay(sale);
        // Reconciliation, not the session, decides: the same customer, with their earlier claim, now sees the bill as paid.
        var paid = viewAs(token, claim);
        assertThat(state(paid)).isEqualTo("SESSION_ENDED");
        assertThat(paid.json().path("sale").path("status").asString()).isEqualTo("PAID");
        // A stranger is not shown a finished bill: the device is simply idle again.
        var stranger = viewAs(token, null);
        assertThat(state(stranger)).isEqualTo("IDLE");
        assertThat(stranger.body()).doesNotContain(reference(sale));
        assertThat(state(claimAs(token, null))).isEqualTo("IDLE");
    }

    @Test
    void aBillThatExpiresWhileClaimedIsShownAsExpiredToItsHolderAndTheDeviceFreesUp() {
        JsonNode sale = liveSale();
        JsonNode d = readyDevice(sale);
        String token = token(d);
        String claim = claimToken(token);
        expireSale(sale);
        var holder = viewAs(token, claim);
        assertThat(holder.json().path("sale").path("status").asString()).isEqualTo("EXPIRED");
        assertThat(holder.json().path("sale").path("statusNote").asString()).contains("If you already paid");
        // Strangers see nothing of it, and the cashier can prepare the next bill.
        assertThat(state(viewAs(token, null))).isIn("BUSY", "IDLE");
        expireClaims(d);
        assertThat(state(viewAs(token, null))).isEqualTo("IDLE");
        JsonNode next = liveSale();
        bound(d, next);
        assertThat(jdbc.queryForObject("select end_reason from payment_entry_bindings where ended_at is not null", String.class)).isEqualTo("SALE_EXPIRED");
    }

    @Test
    void theCustomerCanGiveTheDeviceBackAndTheCashierCannotSilentlyCutASessionOff() {
        JsonNode sale = liveSale();
        JsonNode d = readyDevice(sale);
        String token = token(d);
        String claim = claimToken(token);
        // The counter is warned: closing a bill someone is looking at needs an explicit confirmation.
        var warned = unbind(w.owner, d, false);
        assertThat(warned.status()).isEqualTo(409);
        assertThat(warned.code()).isEqualTo("customer_session_active");
        assertThat(fresh(d).path("binding").path("customerSessionActive").asBoolean()).isTrue();
        // The customer finishes: the device is free again, and the bill is still the device's.
        var released = releaseAs(token, claim);
        assertThat(state(released)).isEqualTo("SESSION_ENDED");
        assertThat(released.json().path("claim").path("endReason").asString()).isEqualTo("RELEASED");
        assertThat(state(viewAs(token, null))).isEqualTo("READY");
        assertThat(unbind(w.owner, d, false).status()).isEqualTo(200);
    }

    @Test
    void aHolderStaysTiedToTheirBillWhenTheCounterMovesOnToAnother() {
        JsonNode first = liveSale();
        JsonNode d = readyDevice(first);
        String token = token(d);
        String claim = claimToken(token);
        JsonNode second = liveSale();
        // Moving on is an explicit, confirmed act...
        assertThat(unbind(w.owner, d, true).status()).isEqualTo(200);
        assertThat(jdbc.queryForObject("select end_reason from payment_entry_claims", String.class)).isEqualTo("BINDING_ENDED");
        bound(d, second);
        // ...and the earlier customer is still shown THEIR bill, never the new one.
        var old = viewAs(token, claim);
        assertThat(old.json().path("sale").path("saleReference").asString()).isEqualTo(reference(first));
        assertThat(old.body()).doesNotContain(reference(second));
        // The next customer gets the new bill, and neither sees the other's.
        var next = claimAs(token, null);
        assertThat(next.json().path("sale").path("saleReference").asString()).isEqualTo(reference(second));
        assertThat(next.body()).doesNotContain(reference(first));
    }

    // ---- demonstration isolation and the code-only policy -------------------------------------------

    @Test
    void aDemonstrationBillOffersNoRealCodeAndSaysNothingCanBePaid() {
        demo();
        JsonNode sale = billed(saveDraft(line(rice, "1", "kg")));
        assertThat(sale.path("mode").asString()).isEqualTo("DEMONSTRATION");
        JsonNode d = readyDevice(sale);
        var claimed = claimAs(token(d), null);
        assertThat(state(claimed)).isEqualTo("CLAIMED");
        JsonNode view = claimed.json().path("sale");
        assertThat(view.path("code").path("mode").asString()).isEqualTo("DEMONSTRATION");
        assertThat(absent(view.path("code").path("bankCode"))).isTrue();
        assertThat(view.path("instructions")).isEmpty();
        assertThat(view.path("statusNote").asString()).contains("demonstration");
        assertThat(claimed.body()).doesNotContain("EQ-DEMO-1");
    }

    @Test
    void theCustomerPageNeverClaimsPaymentNorLeaksInternalDataNorSetsCookiesOrCaches() {
        JsonNode sale = liveSale();
        JsonNode d = readyDevice(sale);
        String token = token(d);
        TestApi.Response ready = viewAs(token, null);
        TestApi.Response claimed = claimAs(token, null);
        String claim = claimed.json().path("claim").path("claimToken").asString();
        List<TestApi.Response> all = List.of(ready, claimed, viewAs(token, claim), viewAs(token, null));
        for (TestApi.Response r : all) {
            assertThat(r.raw().getHeader("Cache-Control")).isEqualTo("no-store");
            assertThat(r.raw().getCookies()).isEmpty();
            assertThat(r.raw().getHeader("Set-Cookie")).isNull();
            String body = r.body();
            // Nothing private: no agent, no internal ids, no account, no OuPay code reference, no other business.
            assertThat(body).doesNotContain("Aline").doesNotContain(w.merchantId.toString()).doesNotContain(w.branchId.toString())
                    .doesNotContain(w.cashierPerson.userId().toString()).doesNotContain(d.path("id").asString()).doesNotContainIgnoringCase("settlement")
                    .doesNotContainIgnoringCase("maskedAccount").doesNotContain("Sample Cafe").doesNotContain("CC-");
        }
        // The resolver never says a payment happened: nothing is PAID until the bank's confirmation has been applied.
        assertThat(claimed.json().path("sale").path("status").asString()).isEqualTo("AWAITING_PAYMENT");
        assertThat(claimed.body()).doesNotContainIgnoringCase("\"PAID\"");
        assertThat(state(all.get(3))).isEqualTo("BUSY");
    }

    // ---- the existing financial infrastructure is unchanged ---------------------------------------

    @Test
    void bankReconciliationOfABoundBillIsUnchangedAndStillTheOnlyAuthority() {
        JsonNode sale = liveSale();
        JsonNode d = readyDevice(sale);
        String claim = claimToken(token(d));
        assertThat(viewAs(token(d), claim).json().path("sale").path("status").asString()).isEqualTo("AWAITING_PAYMENT");
        var delivery = w.bank.payWithCode("POSTED", amount(sale), reference(sale), "EQ-LIVE-77");
        assertThat(delivery.outcome()).isEqualTo("APPLIED");
        assertThat(jdbc.queryForObject("select attribution_status from bank_transactions", String.class)).isEqualTo("RESOLVED");
        assertThat(jdbc.queryForObject("select agent_attribution from bank_transactions", String.class)).isEqualTo("CONFIRMED_FROM_SALE_SNAPSHOT");
        // The customer's page now reflects the bank-verified, applied payment (and only that).
        var after = viewAs(token(d), claim);
        assertThat(after.json().path("sale").path("status").asString()).isEqualTo("PAID");
        assertThat(count("payment_allocations")).isEqualTo(1);
    }

    private static String sha256(String text) {
        try {
            return java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8)));
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
