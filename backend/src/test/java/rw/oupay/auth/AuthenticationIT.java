package rw.oupay.auth;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpMethod;
import rw.oupay.support.IntegrationTest;
import rw.oupay.support.TestApi;

class AuthenticationIT extends IntegrationTest {

    @Autowired
    SecurityProperties properties;

    private Map<String, Object> registration(String email) {
        return Map.of("fullName", "Test Person", "email", email, "phoneNumber", "+250788123456", "password", "Correct-horse-9");
    }

    @Test
    void registrationSignsInAndSetsAnHttpOnlySessionCookie() {
        var api = new TestApi(mvc);
        var response = api.post("/api/v1/auth/register", registration("a@example.rw"));

        assertThat(response.status()).isEqualTo(200);
        assertThat(response.json().path("user").path("email").asString()).isEqualTo("a@example.rw");
        // Never any credential in the body.
        assertThat(response.body()).doesNotContainIgnoringCase("password").doesNotContain("passwordHash");
        String setCookie = response.raw().getHeaders("Set-Cookie").stream()
                .filter(h -> h.startsWith(properties.session().cookieName() + "=")).findFirst().orElseThrow();
        assertThat(setCookie).contains("HttpOnly").contains("SameSite=Lax");
        assertThat(api.get("/api/v1/auth/session").status()).isEqualTo(200);
    }

    @Test
    void passwordsAreStoredAsArgon2idHashesNeverPlaintext() {
        new TestApi(mvc).post("/api/v1/auth/register", registration("hash@example.rw"));
        String hash = jdbc.queryForObject("select password_hash from users where email = 'hash@example.rw'", String.class);
        assertThat(hash).startsWith("{argon2}").doesNotContain("Correct-horse-9");
    }

    @Test
    void sessionTokensAreStoredOnlyAsHashes() {
        var api = new TestApi(mvc);
        api.post("/api/v1/auth/register", registration("tok@example.rw"));
        String raw = api.cookie(properties.session().cookieName());
        Integer plaintextMatches = jdbc.queryForObject(
                "select count(*) from auth_sessions where encode(token_hash, 'escape') = ?", Integer.class, raw);
        assertThat(plaintextMatches).isZero();
        assertThat(jdbc.queryForObject("select count(*) from auth_sessions", Integer.class)).isEqualTo(1);
    }

    @Test
    void duplicateAndWeakRegistrationsAreRejected() {
        var api = new TestApi(mvc);
        assertThat(api.post("/api/v1/auth/register", registration("dup@example.rw")).status()).isEqualTo(200);
        var again = new TestApi(mvc).post("/api/v1/auth/register", registration("DUP@example.rw"));
        assertThat(again.status()).isEqualTo(409);
        assertThat(again.code()).isEqualTo("email_taken");
        var weak = new TestApi(mvc).post("/api/v1/auth/register",
                Map.of("fullName", "X Y", "email", "w@example.rw", "phoneNumber", "", "password", "short1"));
        assertThat(weak.status()).isEqualTo(422);
        assertThat(new TestApi(mvc).post("/api/v1/auth/register",
                Map.of("fullName", "X Y", "email", "not-an-email", "password", "Correct-horse-9")).status()).isEqualTo(422);
    }

    @Test
    void loginIsUniformForWrongPasswordAndUnknownAccount() {
        new TestApi(mvc).post("/api/v1/auth/register", registration("known@example.rw"));
        var wrong = new TestApi(mvc).post("/api/v1/auth/login", Map.of("email", "known@example.rw", "password", "Wrong-pass-1"));
        var unknown = new TestApi(mvc).post("/api/v1/auth/login", Map.of("email", "nobody@example.rw", "password", "Wrong-pass-1"));
        assertThat(wrong.status()).isEqualTo(401);
        assertThat(unknown.status()).isEqualTo(401);
        assertThat(wrong.body()).isEqualTo(unknown.body());
    }

    @Test
    void repeatedFailuresLockTheAccountEvenForTheRightPassword() {
        new TestApi(mvc).post("/api/v1/auth/register", registration("lock@example.rw"));
        var api = new TestApi(mvc);
        for (int i = 0; i < 5; i++) {
            assertThat(api.post("/api/v1/auth/login", Map.of("email", "lock@example.rw", "password", "Wrong-pass-1")).status()).isEqualTo(401);
        }
        var locked = api.post("/api/v1/auth/login", Map.of("email", "lock@example.rw", "password", "Correct-horse-9"));
        assertThat(locked.status()).isEqualTo(401);
        assertThat(locked.code()).isEqualTo("invalid_credentials");
        // Indistinguishable from an address that is not registered at all: lockout must not reveal that an account exists.
        var unknown = new TestApi(mvc).post("/api/v1/auth/login", Map.of("email", "never-registered@example.rw", "password", "Correct-horse-9"));
        assertThat(locked.status()).isEqualTo(unknown.status());
        assertThat(locked.body()).isEqualTo(unknown.body());
    }

    @Test
    void logoutRevokesTheSessionOnTheServerNotJustInTheBrowser() {
        var api = new TestApi(mvc);
        api.post("/api/v1/auth/register", registration("out@example.rw"));
        String stolenCookie = api.cookie(properties.session().cookieName());

        assertThat(api.post("/api/v1/auth/logout", null).status()).isEqualTo(204);
        assertThat(api.get("/api/v1/auth/session").status()).isEqualTo(204);

        // An attacker who copied the cookie before logout gets nothing.
        var attacker = new TestApi(mvc);
        attacker.setCookie(properties.session().cookieName(), stolenCookie);
        assertThat(attacker.get("/api/v1/auth/session").status()).isEqualTo(204);
        assertThat(attacker.get("/api/v1/merchants").status()).isEqualTo(401);
    }

    @Test
    void expiredAndForgedSessionsAreRejected() {
        var api = new TestApi(mvc);
        api.post("/api/v1/auth/register", registration("exp@example.rw"));
        jdbc.update("update auth_sessions set idle_expires_at = now() - interval '1 minute'");
        assertThat(api.get("/api/v1/merchants").status()).isEqualTo(401);

        var forged = new TestApi(mvc);
        forged.setCookie(properties.session().cookieName(), "A".repeat(43));
        assertThat(forged.get("/api/v1/merchants").status()).isEqualTo(401);
    }

    @Test
    void absoluteLifetimeIsEnforcedEvenForAnActiveSession() {
        var api = new TestApi(mvc);
        api.post("/api/v1/auth/register", registration("abs@example.rw"));
        jdbc.update("update auth_sessions set absolute_expires_at = now() - interval '1 second'");
        assertThat(api.get("/api/v1/merchants").status()).isEqualTo(401);
    }

    @Test
    void suspendingAUserEndsTheirAccessImmediately() {
        var api = new TestApi(mvc);
        api.post("/api/v1/auth/register", registration("susp@example.rw"));
        assertThat(api.get("/api/v1/merchants").status()).isEqualTo(200);
        jdbc.update("update users set status = 'SUSPENDED', password_hash = password_hash");
        assertThat(api.get("/api/v1/merchants").status()).isEqualTo(401);
    }

    @Test
    void stateChangingRequestsNeedTheCsrfToken() {
        var api = new TestApi(mvc);
        api.post("/api/v1/auth/register", registration("csrf@example.rw"));
        // A cross-site form post carries the session cookie but cannot read or send the CSRF token.
        var cookieOnly = TestApi.anonymous(mvc, HttpMethod.POST, "/api/v1/auth/logout", null,
                Map.of("Cookie", properties.session().cookieName() + "=" + api.cookie(properties.session().cookieName())));
        assertThat(cookieOnly.status()).isEqualTo(403);
        assertThat(api.get("/api/v1/auth/session").status()).isEqualTo(200);
    }

    @Test
    void protectedEndpointsRejectAnonymousCallers() {
        for (String url : new String[] {"/api/v1/merchants", "/api/v1/auth/logout"}) {
            var response = TestApi.anonymous(mvc, HttpMethod.GET, url, null, Map.of());
            assertThat(response.status()).isIn(401, 403, 405);
        }
        assertThat(TestApi.anonymous(mvc, HttpMethod.GET, "/api/v1/merchants", null, Map.of()).status()).isEqualTo(401);
    }

    @Test
    void securityHeadersAreSet() {
        var response = new TestApi(mvc).get("/api/v1/auth/session");
        assertThat(response.raw().getHeader("Content-Security-Policy")).contains("default-src 'none'");
        assertThat(response.raw().getHeader("X-Content-Type-Options")).isEqualTo("nosniff");
        assertThat(response.raw().getHeader("Referrer-Policy")).isEqualTo("no-referrer");
    }
}
