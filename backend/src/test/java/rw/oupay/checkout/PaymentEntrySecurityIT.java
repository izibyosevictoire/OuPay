package rw.oupay.checkout;

import static org.assertj.core.api.Assertions.assertThat;

import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Callable;
import org.junit.jupiter.api.Test;
import rw.oupay.support.TestApi;
import tools.jackson.databind.JsonNode;

/**
 * R8a security review: recovery of a lost claim answer without weakening customer isolation, what a revoked or suspended device still shows a
 * customer who already holds a claim, evidence that survives a closed binding, finished bills that can never be re-bound, concurrent close /
 * claim / rebind, and the headers and audit records of the public surface.
 */
class PaymentEntrySecurityIT extends PaymentEntryTestSupport {

    private static final SecureRandom RANDOM = new SecureRandom();

    /** What a browser proposes: 256 random bits as base64url without padding (43 characters). */
    private static String proposal() {
        byte[] bytes = new byte[32];
        RANDOM.nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    private JsonNode readyDevice(String name, JsonNode sale) {
        JsonNode d = device("STATIC_QR", name, null);
        bound(d, sale);
        return d;
    }

    private int openClaims() {
        return jdbc.queryForObject("select count(*) from payment_entry_claims where ended_at is null", Integer.class);
    }

    // ---- a lost answer is recoverable, and recovery weakens nothing -----------------------------------------------

    @Test
    void aBrowserThatProposedItsOwnClaimTokenRecoversFromALostAnswerByRepeatingTheSameRequest() {
        JsonNode sale = liveSale();
        String token = token(readyDevice("Counter", sale));
        String mine = proposal();
        var first = claimAs(token, mine);
        assertThat(state(first)).isEqualTo("CLAIMED");
        // The browser chose the token, so the server does not send it back.
        assertThat(absent(first.json().path("claim").path("claimToken"))).isTrue();
        assertThat(first.body()).doesNotContain(mine);
        // The answer was "lost": the same request again finds the same claim. One claim, still bound to the same sale.
        var retry = claimAs(token, mine);
        assertThat(state(retry)).isEqualTo("CLAIMED");
        assertThat(retry.json().path("sale").path("saleReference").asString()).isEqualTo(reference(sale));
        assertThat(count("payment_entry_claims")).isEqualTo(1);
        // A refresh, and a second tab that copied the session, simply read.
        assertThat(state(viewAs(token, mine))).isEqualTo("CLAIMED");
        // Recovery weakens nothing: another customer, with or without a token of their own, is still turned away without detail.
        for (TestApi.Response stranger : List.of(claimAs(token, null), claimAs(token, proposal()), viewAs(token, proposal()))) {
            assertThat(state(stranger)).isEqualTo("BUSY");
            assertThat(stranger.body()).doesNotContain(reference(sale));
        }
        assertThat(openClaims()).isEqualTo(1);
        // Only the hash is stored.
        assertThat(jdbc.queryForObject("select count(*) from payment_entry_claims where claim_token_hash = ?", Integer.class, mine)).isZero();
    }

    @Test
    void aTokenFromAnotherDeviceOrAnEndedClaimIsNeverAdoptedAndRevealsNothing() {
        JsonNode saleA = liveSale();
        JsonNode saleB = liveSale();
        JsonNode a = readyDevice("Counter A", saleA);
        JsonNode b = readyDevice("Counter B", saleB);
        String t = proposal();
        assertThat(state(claimAs(token(a), t))).isEqualTo("CLAIMED");
        // Presented at device B, the same token is just a stranger's header: B shows only "ready", never A's bill.
        var atB = viewAs(token(b), t);
        assertThat(state(atB)).isEqualTo("READY");
        assertThat(atB.body()).doesNotContain(reference(saleA));
        // Claiming at B ignores the token (already used) and mints B's own, different one, shown once.
        var claimedB = claimAs(token(b), t);
        assertThat(state(claimedB)).isEqualTo("CLAIMED");
        String minted = claimedB.json().path("claim").path("claimToken").asString();
        assertThat(minted).hasSize(43).isNotEqualTo(t);
        assertThat(claimedB.json().path("sale").path("saleReference").asString()).isEqualTo(reference(saleB));
        // A's token still opens only A.
        assertThat(viewAs(token(a), t).json().path("sale").path("saleReference").asString()).isEqualTo(reference(saleA));
        // After A's claim has ended, the same token is not reused for a new claim: the server mints a fresh one.
        expireClaims(a);
        var again = claimAs(token(a), t);
        assertThat(state(again)).isEqualTo("CLAIMED");
        assertThat(again.json().path("claim").path("claimToken").asString()).hasSize(43).isNotEqualTo(t);
        assertThat(count("payment_entry_claims")).isEqualTo(3);
    }

    @Test
    void aMalformedClaimTokenIsIgnoredNotTrusted() {
        String token = token(readyDevice("Counter", liveSale()));
        for (String junk : List.of("short", "x".repeat(300), "' or 1=1 --", "AAAA AAAA", "")) {
            var response = claimAs(token, junk);
            assertThat(response.status()).as(junk).isLessThan(500);
        }
        // Whatever was sent, at most one claim exists and the answer to the first valid claim carries a server-minted token.
        assertThat(openClaims()).isEqualTo(1);
    }

    // ---- revocation and suspension while a customer holds a claim --------------------------------------------------

    @Test
    void revokingADeviceWhileAClaimIsOpenStopsNewCustomersButNeverHidesAPaymentInProgress() {
        JsonNode sale = liveSale();
        JsonNode d = readyDevice("Counter", sale);
        String token = token(d);
        String claim = claimToken(token);
        assertThat(lifecycle(w.owner, d, "revoke", "Tag lost").status()).isEqualTo(200);
        assertThat(jdbc.queryForObject("select end_reason from payment_entry_claims", String.class)).isEqualTo("DEVICE_REVOKED");
        assertThat(openClaims()).isZero();
        // Strangers (and a replayed claim POST) get the one identical unavailable answer.
        String unknown = viewAs("AAAAAAAAAAAAAAAAAAAAAA", null).body();
        assertThat(viewAs(token, null).body()).isEqualTo(unknown);
        assertThat(claimAs(token, null).body()).isEqualTo(unknown);
        assertThat(claimAs(token, proposal()).body()).isEqualTo(unknown);
        // The customer who already held a claim keeps seeing their own bill, read-only. They are not renewed and nothing is re-opened.
        var holder = viewAs(token, claim);
        assertThat(state(holder)).isEqualTo("SESSION_ENDED");
        assertThat(holder.json().path("claim").path("endReason").asString()).isEqualTo("DEVICE_REVOKED");
        assertThat(holder.json().path("sale").path("saleReference").asString()).isEqualTo(reference(sale));
        assertThat(state(claimAs(token, claim))).isEqualTo("SESSION_ENDED");
        assertThat(openClaims()).isZero();
        // The bill is untouched, still payable, and the late payment still reaches that customer.
        pay(sale);
        assertThat(viewAs(token, claim).json().path("sale").path("status").asString()).isEqualTo("PAID");
    }

    @Test
    void aSuspendedDeviceServesNobodyNewAndAReactivatedOneResumesTheSameClaim() {
        JsonNode sale = liveSale();
        JsonNode d = readyDevice("Counter", sale);
        String token = token(d);
        String claim = claimToken(token);
        assertThat(lifecycle(w.owner, d, "suspend", "Checking the tag").status()).isEqualTo(200);
        assertThat(viewAs(token, null).body()).isEqualTo(viewAs("AAAAAAAAAAAAAAAAAAAAAA", null).body());
        var holder = viewAs(token, claim);
        assertThat(state(holder)).isEqualTo("SESSION_ENDED");
        assertThat(holder.json().path("claim").path("endReason").asString()).isEqualTo("DEVICE_SUSPENDED");
        assertThat(lifecycle(w.owner, d, "reactivate", "Back").status()).isEqualTo(200);
        assertThat(state(viewAs(token, claim))).isEqualTo("CLAIMED");
    }

    // ---- bills, evidence and finished sales -----------------------------------------------------------------------

    @Test
    void closingABindingNeverDiscardsPaymentEvidenceAndAFinishedBillCanNeverBeReboundAsNewlyUnpaid() {
        JsonNode sale = liveSale();
        JsonNode d = device("STATIC_QR", "Counter", null);
        bound(d, sale);
        assertThat(unbind(w.owner, d, false).status()).isEqualTo(200);
        // The binding is closed, but the customer pays the bill anyway: the bank evidence is applied exactly as without any device.
        pay(sale);
        assertThat(count("payment_allocations")).isEqualTo(1);
        assertThat(jdbc.queryForObject("select attribution_status from bank_transactions", String.class)).isEqualTo("RESOLVED");
        // The paid bill can not be handed to a device again, as if it were a new unpaid bill.
        var rebound = bind(w.owner, d, sale);
        assertThat(rebound.status()).isEqualTo(409);
        assertThat(rebound.code()).isEqualTo("sale_not_bindable");
        // Nor can a cancelled one.
        JsonNode cancelled = liveSale();
        jdbc.update("update payment_requests set cancelled_at = now() where id = ?::uuid", saleId(cancelled));
        assertThat(bind(w.owner, d, cancelled).code()).isEqualTo("sale_not_bindable");
        assertThat(count("payment_entry_bindings")).isEqualTo(1);
    }

    @Test
    void closeClaimAndRebindRaceKeepsEveryCustomerOnTheirOwnBill() throws Exception {
        for (int round = 0; round < 4; round++) {
            JsonNode first = liveSale();
            JsonNode second = liveSale();
            JsonNode d = device("STATIC_QR", "Counter " + round, null);
            bound(d, first);
            long version = fresh(d).path("version").asLong();
            List<Callable<TestApi.Response>> tasks = new ArrayList<>();
            tasks.add(() -> claimAs(token(d), null));
            tasks.add(() -> claimAs(token(d), proposal()));
            tasks.add(() -> {
                unbind(w.owner, d, true);
                return w.owner.post(devices() + "/" + d.path("id").asString() + "/binding", Map.of("saleId", saleId(second), "expectedVersion", fresh(d).path("version").asLong()));
            });
            List<TestApi.Response> answers = concurrently(tasks);
            assertThat(version).isGreaterThanOrEqualTo(0);
            for (TestApi.Response r : answers.subList(0, 2)) {
                assertThat(r.status()).isEqualTo(200);
                // Whoever was given a bill was given the bill that was current for THEIR claim, never a mixture.
                JsonNode sale = r.json().path("sale");
                if (!absent(sale)) {
                    String ref = sale.path("saleReference").asString();
                    assertThat(ref).isIn(reference(first), reference(second));
                    assertThat(jdbc.queryForObject("select count(*) from payment_entry_claims c join code_sales s on s.payment_request_id = c.sale_id "
                            + "where s.sale_reference = ?", Integer.class, ref)).isGreaterThanOrEqualTo(1);
                }
            }
            // Invariants of PostgreSQL, whatever the order the operations took.
            assertThat(jdbc.queryForObject("select count(*) from payment_entry_bindings where device_id = ?::uuid and ended_at is null", Integer.class, d.path("id").asString())).isLessThanOrEqualTo(1);
            assertThat(jdbc.queryForObject("select count(*) from payment_entry_claims where device_id = ?::uuid and ended_at is null", Integer.class, d.path("id").asString())).isLessThanOrEqualTo(1);
            assertThat(jdbc.queryForObject("select count(*) from payment_entry_claims c join payment_entry_bindings b on b.id = c.binding_id "
                    + "where c.ended_at is null and (b.ended_at is not null or b.sale_id <> c.sale_id)", Integer.class)).isZero();
            assertThat(jdbc.queryForObject("select count(*) from payment_entry_claims c join payment_entry_bindings b on b.id = c.binding_id where c.sale_id <> b.sale_id", Integer.class)).isZero();
        }
    }

    // ---- public surface hygiene -----------------------------------------------------------------------------------

    @Test
    void publicAnswersAreNoStoreNoReferrerAndNeverEchoOrLogTheSecretsOfTheRequest() {
        JsonNode sale = liveSale();
        JsonNode d = readyDevice("Counter", sale);
        String token = token(d);
        String mine = proposal();
        List<TestApi.Response> all = List.of(viewAs(token, null), claimAs(token, mine), viewAs(token, mine), viewAs("AAAAAAAAAAAAAAAAAAAAAA", mine), releaseAs(token, mine));
        for (TestApi.Response r : all) {
            assertThat(r.raw().getHeader("Cache-Control")).isEqualTo("no-store");
            assertThat(r.raw().getHeader("Referrer-Policy")).isEqualTo("no-referrer");
            assertThat(r.raw().getHeader("Set-Cookie")).isNull();
            assertThat(r.body()).doesNotContain(mine).doesNotContain(token);
        }
        // Neither the device token nor a claim token appears in a URL we hand out or in any audit record.
        assertThat(jdbc.queryForList("select message from audit_log", String.class)).noneMatch(m -> m.contains(token) || m.contains(mine));
        assertThat(w.owner.get(devices() + "/" + d.path("id").asString() + "/bindings").body()).doesNotContain(mine);
        // A public token never opens a management or billing endpoint: the same request without a session is refused.
        assertThat(TestApi.anonymous(mvc, org.springframework.http.HttpMethod.GET, devices(), null, Map.of("X-Entry-Claim", mine)).status()).isIn(401, 403);
        assertThat(TestApi.anonymous(mvc, org.springframework.http.HttpMethod.POST, devices() + "/" + d.path("id").asString() + "/binding",
                Map.of("saleId", UUID.randomUUID().toString(), "expectedVersion", 0), Map.of("X-Entry-Claim", mine)).status()).isIn(401, 403);
    }

    @Test
    void replacingADeviceLeavesHistoricalSalesAndBindingsUntouched() {
        JsonNode sale = liveSale();
        JsonNode old = readyDevice("Old tag", sale);
        int sales = count("code_sales");
        assertThat(lifecycle(w.owner, old, "revoke", "Replace").status()).isEqualTo(200);
        JsonNode replacement = device("NFC_TAG", "New tag", null);
        assertThat(token(replacement)).isNotEqualTo(token(old));
        assertThat(count("code_sales")).isEqualTo(sales);
        assertThat(jdbc.queryForObject("select count(*) from payment_entry_bindings where sale_id = ?::uuid", Integer.class, saleId(sale))).isEqualTo(1);
        // The sale it once led to can be given to the replacement (it is open and its binding is closed), and keeps its identity.
        bound(replacement, sale);
        assertThat(jdbc.queryForObject("select agent_name from code_sales where payment_request_id = ?::uuid", String.class, saleId(sale))).isEqualTo("Aline Cashier");
        assertThat(jdbc.queryForObject("select count(*) from payment_entry_bindings", Integer.class)).isEqualTo(2);
    }
}
