package rw.oupay.auth;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.Executors;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpMethod;
import rw.oupay.support.Fixtures;
import rw.oupay.support.IntegrationTest;
import rw.oupay.support.TestApi;

/** Password reset, password change and e-mail verification: tokens, enumeration, sessions, abuse limits. */
class AccountRecoveryIT extends IntegrationTest {

    private static final String RESET = "/api/v1/auth/password-reset/";
    private static final String NEW_PASSWORD = "Brand-new-pass-42";

    private TestApi anonymous() {
        return new TestApi(mvc);
    }

    private void requestReset(String email) {
        assertThat(anonymous().post(RESET + "request", Map.of("email", email)).status()).isEqualTo(204);
    }

    // ---- no account enumeration ----------------------------------------------------------------

    @Test
    void requestingAResetAnswersIdenticallyForKnownAndUnknownAddresses() {
        fixtures.user("known@shop.rw", "Known Person");
        var known = anonymous().post(RESET + "request", Map.of("email", "known@shop.rw"));
        var unknown = anonymous().post(RESET + "request", Map.of("email", "nobody@shop.rw"));
        var differentCase = anonymous().post(RESET + "request", Map.of("email", "KNOWN@shop.rw"));
        assertThat(known.status()).isEqualTo(204).isEqualTo(unknown.status()).isEqualTo(differentCase.status());
        assertThat(known.body()).isEqualTo(unknown.body());
        assertThat(known.raw().getHeaderNames()).isEqualTo(unknown.raw().getHeaderNames());
        // The only difference is invisible to the caller: whether a message was queued.
        assertThat(outbox("known@shop.rw", "PASSWORD_RESET")).isEqualTo(2);   // both spellings reach the same account
        assertThat(jdbc.queryForObject("select count(*) from email_outbox where recipient = 'nobody@shop.rw'", Long.class)).isZero();
    }

    @Test
    void invalidAddressesAreValidationErrorsNotAccountProbes() {
        assertThat(anonymous().post(RESET + "request", Map.of("email", "not-an-email")).status()).isEqualTo(422);
        assertThat(anonymous().post(RESET + "request", Map.of()).status()).isEqualTo(422);
    }

    @Test
    void invitedPlaceholdersAndSuspendedAccountsGetNoResetMail() {
        var person = fixtures.user("susp@shop.rw", "Suspended");
        jdbc.update("update users set status = 'SUSPENDED' where id = ?", person.userId());
        jdbc.update("insert into users (id, email, full_name, phone_number, status, created_at, updated_at) values (gen_random_uuid(), 'pending@shop.rw', 'p', '', 'PENDING', now(), now())");
        requestReset("susp@shop.rw");
        requestReset("pending@shop.rw");
        assertThat(jdbc.queryForObject("select count(*) from email_outbox", Long.class)).isZero();
    }

    @Test
    void aSingleAccountCannotBeMailBombed() {
        fixtures.user("bomb@shop.rw", "Target");
        for (int i = 0; i < 8; i++) {
            requestReset("bomb@shop.rw");
        }
        assertThat(outbox("bomb@shop.rw", "PASSWORD_RESET")).isEqualTo(3);   // max-links-per-hour
    }

    // ---- the token -----------------------------------------------------------------------------

    @Test
    void theResetLinkWorksOnceChangesThePasswordAndSignsEveryDeviceOut() {
        var person = fixtures.user("reset@shop.rw", "Reset Me");
        TestApi laptop = fixtures.signIn(mvc, person);
        TestApi phone = fixtures.signIn(mvc, person);
        assertThat(laptop.get("/api/v1/auth/session").status()).isEqualTo(200);

        requestReset("reset@shop.rw");
        String token = tokenFrom("reset@shop.rw", "/reset-password/");
        assertThat(anonymous().post(RESET + "verify", Map.of("token", token)).status()).isEqualTo(204);

        var done = anonymous().post(RESET + "confirm", Map.of("token", token, "newPassword", NEW_PASSWORD));
        assertThat(done.status()).isEqualTo(204);

        // Single use.
        var again = anonymous().post(RESET + "confirm", Map.of("token", token, "newPassword", "Another-pass-77"));
        assertThat(again.status()).isEqualTo(400);
        assertThat(again.code()).isEqualTo("invalid_token");
        assertThat(anonymous().post(RESET + "verify", Map.of("token", token)).code()).isEqualTo("invalid_token");

        // Old sessions are dead; the old password no longer works; the new one does.
        assertThat(laptop.get("/api/v1/auth/session").status()).isEqualTo(204);
        assertThat(phone.get("/api/v1/auth/session").status()).isEqualTo(204);
        assertThat(anonymous().post("/api/v1/auth/login", Map.of("email", "reset@shop.rw", "password", Fixtures.PASSWORD)).status()).isEqualTo(401);
        assertThat(anonymous().post("/api/v1/auth/login", Map.of("email", "reset@shop.rw", "password", NEW_PASSWORD)).status()).isEqualTo(200);

        // The owner of the mailbox is told, and the address is now known to be theirs.
        assertThat(outbox("reset@shop.rw", "PASSWORD_CHANGED")).isEqualTo(1);
        assertThat(jdbc.queryForObject("select email_verified_at is not null from users where lower(email) = 'reset@shop.rw'", Boolean.class)).isTrue();
    }

    @Test
    void aWeakNewPasswordDoesNotBurnTheLink() {
        fixtures.user("typo@shop.rw", "Typo");
        requestReset("typo@shop.rw");
        String token = tokenFrom("typo@shop.rw", "/reset-password/");
        var weak = anonymous().post(RESET + "confirm", Map.of("token", token, "newPassword", "short"));
        assertThat(weak.status()).isEqualTo(422);
        assertThat(anonymous().post(RESET + "verify", Map.of("token", token)).status()).isEqualTo(204);
        assertThat(anonymous().post(RESET + "confirm", Map.of("token", token, "newPassword", NEW_PASSWORD)).status()).isEqualTo(204);
    }

    @Test
    void expiredUnknownAndMalformedTokensAreRefusedDistinctlyFromNothingElse() {
        fixtures.user("late@shop.rw", "Late");
        requestReset("late@shop.rw");
        String token = tokenFrom("late@shop.rw", "/reset-password/");
        jdbc.update("update account_tokens set expires_at = ?", java.sql.Timestamp.from(Instant.now().minusSeconds(5)));
        var expired = anonymous().post(RESET + "confirm", Map.of("token", token, "newPassword", NEW_PASSWORD));
        assertThat(expired.status()).isEqualTo(400);
        assertThat(expired.code()).isEqualTo("expired_token");
        assertThat(anonymous().post(RESET + "verify", Map.of("token", "x".repeat(43))).code()).isEqualTo("invalid_token");
        assertThat(anonymous().post(RESET + "verify", Map.of("token", "x".repeat(500))).status()).isEqualTo(422);
        // The password was never changed.
        assertThat(anonymous().post("/api/v1/auth/login", Map.of("email", "late@shop.rw", "password", Fixtures.PASSWORD)).status()).isEqualTo(200);
    }

    @Test
    void aNewRequestRetiresTheEarlierLink() {
        fixtures.user("two@shop.rw", "Two");
        requestReset("two@shop.rw");
        String first = tokenFrom("two@shop.rw", "/reset-password/");
        requestReset("two@shop.rw");
        String second = tokenFrom("two@shop.rw", "/reset-password/");
        assertThat(first).isNotEqualTo(second);
        assertThat(anonymous().post(RESET + "verify", Map.of("token", first)).code()).isEqualTo("invalid_token");
        assertThat(anonymous().post(RESET + "verify", Map.of("token", second)).status()).isEqualTo(204);
    }

    @Test
    void aVerificationLinkCannotResetAPasswordAndViceVersa() {
        var person = fixtures.user("kinds@shop.rw", "Kinds");
        TestApi api = fixtures.signIn(mvc, person);
        assertThat(api.post("/api/v1/auth/email-verification/request", null).status()).isEqualTo(204);
        String verification = tokenFrom("kinds@shop.rw", "/verify-email/");
        assertThat(anonymous().post(RESET + "verify", Map.of("token", verification)).code()).isEqualTo("invalid_token");
        assertThat(anonymous().post(RESET + "confirm", Map.of("token", verification, "newPassword", NEW_PASSWORD)).code()).isEqualTo("invalid_token");
    }

    @Test
    void tokensAreStoredHashedAndTheMessageBodyIsErasedOnceSent() {
        fixtures.user("hash@shop.rw", "Hash");
        requestReset("hash@shop.rw");
        assertThat(jdbc.queryForObject("select body_text is not null from email_outbox", Boolean.class)).isTrue();
        String token = tokenFrom("hash@shop.rw", "/reset-password/");
        assertThat(jdbc.queryForList("select encode(token_hash, 'hex') from account_tokens", String.class)).doesNotContain(token);
        assertThat(jdbc.queryForObject("select length(token_hash) from account_tokens", Integer.class)).isEqualTo(32);
        assertThat(jdbc.queryForObject("select status from email_outbox", String.class)).isEqualTo("SENT");
        assertThat(jdbc.queryForObject("select body_text is null and body_html is null from email_outbox", Boolean.class)).isTrue();
    }

    @Test
    void twoSimultaneousUsesOfOneLinkCannotBothSucceed() throws Exception {
        fixtures.user("race@shop.rw", "Race");
        requestReset("race@shop.rw");
        String token = tokenFrom("race@shop.rw", "/reset-password/");
        var pool = Executors.newFixedThreadPool(4);
        try {
            List<Callable<Integer>> calls = new java.util.ArrayList<>();
            for (int i = 0; i < 4; i++) {
                String password = "Racing-pass-" + i + "9";
                calls.add(() -> anonymous().post(RESET + "confirm", Map.of("token", token, "newPassword", password)).status());
            }
            var statuses = new java.util.ArrayList<Integer>();
            for (var future : pool.invokeAll(calls)) {
                statuses.add(future.get());
            }
            assertThat(statuses.stream().filter(s -> s == 204).count()).isEqualTo(1);
            assertThat(statuses.stream().filter(s -> s == 400).count()).isEqualTo(3);
        } finally {
            pool.shutdownNow();
        }
    }

    @Test
    void aResetLiftsALockout() {
        fixtures.user("locked@shop.rw", "Locked");
        for (int i = 0; i < 5; i++) {
            anonymous().post("/api/v1/auth/login", Map.of("email", "locked@shop.rw", "password", "wrong-password-1"));
        }
        assertThat(anonymous().post("/api/v1/auth/login", Map.of("email", "locked@shop.rw", "password", Fixtures.PASSWORD)).status()).isEqualTo(403);
        requestReset("locked@shop.rw");
        String token = tokenFrom("locked@shop.rw", "/reset-password/");
        assertThat(anonymous().post(RESET + "confirm", Map.of("token", token, "newPassword", NEW_PASSWORD)).status()).isEqualTo(204);
        assertThat(anonymous().post("/api/v1/auth/login", Map.of("email", "locked@shop.rw", "password", NEW_PASSWORD)).status()).isEqualTo(200);
    }

    // ---- change password -----------------------------------------------------------------------

    @Test
    void changingThePasswordKeepsThisDeviceAndSignsTheOthersOut() {
        var person = fixtures.user("change@shop.rw", "Changer");
        TestApi here = fixtures.signIn(mvc, person);
        TestApi elsewhere = fixtures.signIn(mvc, person);
        var done = here.post("/api/v1/auth/password/change", Map.of("currentPassword", Fixtures.PASSWORD, "newPassword", NEW_PASSWORD));
        assertThat(done.status()).isEqualTo(204);
        assertThat(here.get("/api/v1/auth/session").status()).isEqualTo(200);
        assertThat(elsewhere.get("/api/v1/auth/session").status()).isEqualTo(204);
        assertThat(anonymous().post("/api/v1/auth/login", Map.of("email", "change@shop.rw", "password", NEW_PASSWORD)).status()).isEqualTo(200);
        assertThat(outbox("change@shop.rw", "PASSWORD_CHANGED")).isEqualTo(1);
    }

    @Test
    void changingThePasswordNeedsTheCurrentOneAndCountsMistakesTowardLockout() {
        var person = fixtures.user("guess@shop.rw", "Guesser");
        TestApi api = fixtures.signIn(mvc, person);
        for (int i = 0; i < 5; i++) {
            var wrong = api.post("/api/v1/auth/password/change", Map.of("currentPassword", "not-it-at-all-1", "newPassword", NEW_PASSWORD));
            assertThat(wrong.status()).isEqualTo(i < 5 ? 422 : 403);
            assertThat(wrong.code()).isEqualTo("invalid_credentials");   // 422, so the SPA does not treat it as a lost session
        }
        var locked = api.post("/api/v1/auth/password/change", Map.of("currentPassword", Fixtures.PASSWORD, "newPassword", NEW_PASSWORD));
        assertThat(locked.status()).isEqualTo(403);
        assertThat(anonymous().post("/api/v1/auth/login", Map.of("email", "guess@shop.rw", "password", Fixtures.PASSWORD)).status()).isEqualTo(403);
    }

    @Test
    void passwordChangeRejectsWeakAndUnchangedPasswordsAndAnonymousCallers() {
        var person = fixtures.user("weak@shop.rw", "Weak");
        TestApi api = fixtures.signIn(mvc, person);
        assertThat(api.post("/api/v1/auth/password/change", Map.of("currentPassword", Fixtures.PASSWORD, "newPassword", "short1")).status()).isEqualTo(422);
        assertThat(api.post("/api/v1/auth/password/change", Map.of("currentPassword", Fixtures.PASSWORD, "newPassword", Fixtures.PASSWORD)).status()).isEqualTo(422);
        assertThat(anonymous().post("/api/v1/auth/password/change", Map.of("currentPassword", Fixtures.PASSWORD, "newPassword", NEW_PASSWORD)).status()).isIn(401, 403);
    }

    // ---- e-mail verification -------------------------------------------------------------------

    @Test
    void registeringQueuesAVerificationLinkAndConfirmingItMarksTheAddress() {
        TestApi api = anonymous();
        var registered = api.post("/api/v1/auth/register", Map.of("fullName", "New Person", "email", "new@shop.rw", "password", NEW_PASSWORD));
        assertThat(registered.status()).isEqualTo(200);
        assertThat(registered.json().path("user").path("emailVerified").asBoolean()).isFalse();
        String token = tokenFrom("new@shop.rw", "/verify-email/");

        assertThat(anonymous().post("/api/v1/auth/email-verification/confirm", Map.of("token", token)).status()).isEqualTo(204);
        assertThat(api.get("/api/v1/auth/session").json().path("user").path("emailVerified").asBoolean()).isTrue();
        // Single use, and a verified account is not nagged again.
        assertThat(anonymous().post("/api/v1/auth/email-verification/confirm", Map.of("token", token)).code()).isEqualTo("invalid_token");
        assertThat(api.post("/api/v1/auth/email-verification/request", null).status()).isEqualTo(204);
        assertThat(outbox("new@shop.rw", "EMAIL_VERIFICATION")).isEqualTo(1);
    }

    @Test
    void resendingIsRateLimitedPerAccount() {
        var person = fixtures.user("resend@shop.rw", "Resend");
        TestApi api = fixtures.signIn(mvc, person);
        for (int i = 0; i < 6; i++) {
            assertThat(api.post("/api/v1/auth/email-verification/request", null).status()).isEqualTo(204);
        }
        assertThat(outbox("resend@shop.rw", "EMAIL_VERIFICATION")).isEqualTo(3);
    }

    @Test
    void aVerificationLinkOnlyVerifiesTheAddressItWasSentTo() {
        var person = fixtures.user("old@shop.rw", "Mover");
        TestApi api = fixtures.signIn(mvc, person);
        api.post("/api/v1/auth/email-verification/request", null);
        String token = tokenFrom("old@shop.rw", "/verify-email/");
        jdbc.update("update users set email = 'moved@shop.rw'");
        assertThat(anonymous().post("/api/v1/auth/email-verification/confirm", Map.of("token", token)).code()).isEqualTo("invalid_token");
        assertThat(jdbc.queryForObject("select email_verified_at is null from users", Boolean.class)).isTrue();
    }

    @Test
    void publicRecoveryEndpointsNeedNoSessionButStillRefuseCrossSiteOrigins() {
        fixtures.user("origin@shop.rw", "Origin");
        var response = TestApi.anonymous(mvc, HttpMethod.POST, RESET + "request", Map.of("email", "origin@shop.rw"),
                Map.of("Origin", "https://evil.example", "Host", "api.oupay.test"));
        // No CSRF token either, so it is refused before anything happens.
        assertThat(response.status()).isEqualTo(403);
        assertThat(outbox("origin@shop.rw", "PASSWORD_RESET")).isZero();
    }
}
