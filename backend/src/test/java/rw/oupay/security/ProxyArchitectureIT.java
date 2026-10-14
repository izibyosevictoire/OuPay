package rw.oupay.security;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.servlet.http.Cookie;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpMethod;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders;
import rw.oupay.support.Fixtures;
import rw.oupay.support.IntegrationTest;
import rw.oupay.support.TestApi;

/**
 * The staging architecture: the browser talks to the frontend host (Vercel) at https://app.example, and Vercel
 * rewrites /api/* to the backend host (Render). So the backend sees the BROWSER's Origin (the frontend host) but
 * its own Host header and a TLS-terminating proxy in front of it. This test proves login, authenticated reads,
 * CSRF-protected writes, logout and session expiry all work in that shape, with the production cookie settings,
 * and that nothing needs (or gets) CORS.
 */
@TestPropertySource(properties = {
        "oupay.security.session.secure-cookie=true",
        "oupay.security.session.cookie-name=__Host-oupay_session",
        "oupay.security.origins.allowed=https://oupay-staging.vercel.app"})
class ProxyArchitectureIT extends IntegrationTest {

    private static final String FRONTEND = "https://oupay-staging.vercel.app";
    /** What the backend sees as the request host: Render's, not Vercel's. */
    private static final Map<String, String> VIA_VERCEL = Map.of(
            "Host", "oupay-api.onrender.com",
            "Origin", FRONTEND,
            "X-Forwarded-Proto", "https",
            "X-Forwarded-Host", "oupay-staging.vercel.app",
            "X-Forwarded-For", "198.51.100.23");

    private TestApi.Response get(TestApi api, String url) {
        return api.send(HttpMethod.GET, url, null, VIA_VERCEL);
    }

    private TestApi.Response post(TestApi api, String url, Object body) {
        return api.send(HttpMethod.POST, url, body, VIA_VERCEL);
    }

    private static List<String> setCookies(TestApi.Response response) {
        return response.raw().getHeaders("Set-Cookie");
    }

    @Test
    void theWholeSessionLifecycleWorksThroughTheFrontendHost() {
        var person = fixtures.user("proxy@shop.rw", "Proxy User");
        TestApi browser = new TestApi(mvc);

        // 1. First visit: the CSRF cookie is issued, Secure, readable, host-only.
        var first = get(browser, "/api/v1/auth/session");
        assertThat(first.status()).isEqualTo(204);
        String csrf = setCookies(first).stream().filter(c -> c.startsWith("XSRF-TOKEN=")).findFirst().orElseThrow();
        assertThat(csrf).contains("Secure").contains("Path=/").doesNotContain("Domain=").doesNotContain("HttpOnly");
        // (The container renders SameSite on the Cookie object rather than in the header string.)
        assertThat(first.raw().getCookie("XSRF-TOKEN").getAttribute("SameSite")).isEqualTo("Lax");

        // 2. Login from the frontend origin (valid CSRF token, foreign Host): allowed because the origin is configured.
        var login = post(browser, "/api/v1/auth/login", Map.of("email", person.email(), "password", Fixtures.PASSWORD));
        assertThat(login.status()).isEqualTo(200);
        String session = setCookies(login).stream().filter(c -> c.startsWith("__Host-oupay_session=")).findFirst().orElseThrow();
        // Everything the __Host- prefix demands, so the browser accepts it for the FRONTEND host: Secure, Path=/, no Domain.
        assertThat(session).contains("Secure").contains("HttpOnly").contains("Path=/").contains("SameSite=Lax").doesNotContain("Domain=");
        assertThat(login.body()).doesNotContain(browser.cookie("__Host-oupay_session"));

        // 3. Authenticated read.
        var me = get(browser, "/api/v1/auth/session");
        assertThat(me.status()).isEqualTo(200);
        assertThat(me.json().path("user").path("email").asString()).isEqualTo("proxy@shop.rw");
        assertThat(get(browser, "/api/v1/merchants").status()).isEqualTo(200);

        // 4. CSRF-protected writes: with the token they work (repeatedly), without it they do not.
        for (int i = 0; i < 3; i++) {
            assertThat(post(browser, "/api/v1/auth/email-verification/request", null).status()).isEqualTo(204);
        }
        // 4b. Same cookies and a good Origin, but NO csrf header.
        try {
            var noToken = mvc.perform(MockMvcRequestBuilders.post("/api/v1/auth/email-verification/request")
                    .header("Host", "oupay-api.onrender.com").header("Origin", FRONTEND)
                    .cookie(new Cookie("__Host-oupay_session", browser.cookie("__Host-oupay_session")))
                    .cookie(new Cookie("XSRF-TOKEN", browser.cookie("XSRF-TOKEN")))).andReturn();
            assertThat(noToken.getResponse().getStatus()).isEqualTo(403);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
        // 4c. A valid token from a page on ANOTHER site is still refused by the Origin check.
        var evil = browser.send(HttpMethod.POST, "/api/v1/auth/email-verification/request", null,
                Map.of("Host", "oupay-api.onrender.com", "Origin", "https://evil.example"));
        assertThat(evil.status()).isEqualTo(403);
        var lookAlike = browser.send(HttpMethod.POST, "/api/v1/auth/email-verification/request", null,
                Map.of("Host", "oupay-api.onrender.com", "Origin", "https://oupay-staging.vercel.app.evil.example"));
        assertThat(lookAlike.status()).isEqualTo(403);

        // 5. Logout through the proxy: the cookie is cleared for the same host-only scope, and the server forgets the session.
        String stolenCopy = browser.cookie("__Host-oupay_session");
        var logout = post(browser, "/api/v1/auth/logout", null);
        assertThat(logout.status()).isEqualTo(204);
        String cleared = setCookies(logout).stream().filter(c -> c.startsWith("__Host-oupay_session=")).findFirst().orElseThrow();
        assertThat(cleared).contains("Max-Age=0").contains("Path=/").contains("Secure").doesNotContain("Domain=");
        assertThat(get(browser, "/api/v1/auth/session").status()).isEqualTo(204);
        TestApi replay = new TestApi(mvc);
        replay.setCookie("__Host-oupay_session", stolenCopy);
        assertThat(get(replay, "/api/v1/auth/session").status()).isEqualTo(204);
        assertThat(get(replay, "/api/v1/merchants").status()).isEqualTo(401);
    }

    @Test
    void anExpiredSessionIsRefusedThroughTheProxyToo() {
        var person = fixtures.user("expiry@shop.rw", "Expiry");
        TestApi browser = new TestApi(mvc);
        get(browser, "/api/v1/auth/session");
        assertThat(post(browser, "/api/v1/auth/login", Map.of("email", person.email(), "password", Fixtures.PASSWORD)).status()).isEqualTo(200);
        assertThat(get(browser, "/api/v1/merchants").status()).isEqualTo(200);
        // Idle timeout passes: the session is dead on the server, whatever the browser still holds.
        jdbc.update("update auth_sessions set idle_expires_at = ?", Timestamp.from(Instant.now().minusSeconds(5)));
        assertThat(get(browser, "/api/v1/auth/session").status()).isEqualTo(204);
        var refused = get(browser, "/api/v1/merchants");
        assertThat(refused.status()).isEqualTo(401);
        assertThat(refused.code()).isEqualTo("unauthenticated");
        // Absolute timeout, on a fresh session.
        TestApi again = new TestApi(mvc);
        get(again, "/api/v1/auth/session");
        post(again, "/api/v1/auth/login", Map.of("email", person.email(), "password", Fixtures.PASSWORD));
        jdbc.update("update auth_sessions set absolute_expires_at = ? where revoked_at is null and idle_expires_at > now()", Timestamp.from(Instant.now().minusSeconds(5)));
        assertThat(get(again, "/api/v1/merchants").status()).isEqualTo(401);
    }

    @Test
    void thereIsNoCorsAtAllSoNoCredentialedWildcardIsPossible() {
        var person = fixtures.user("cors@shop.rw", "Cors");
        TestApi browser = new TestApi(mvc);
        get(browser, "/api/v1/auth/session");
        var login = post(browser, "/api/v1/auth/login", Map.of("email", person.email(), "password", Fixtures.PASSWORD));
        for (var response : List.of(login, get(browser, "/api/v1/merchants"), get(browser, "/api/v1/auth/session"),
                get(new TestApi(mvc), "/api/v1/public/payment-profiles/AAAAAAAAAAAA"))) {
            assertThat(response.raw().getHeaderNames()).noneMatch(name -> name.toLowerCase().startsWith("access-control-"));
        }
        // A cross-site preflight gets nothing that would permit the call.
        var preflight = new TestApi(mvc).send(HttpMethod.OPTIONS, "/api/v1/merchants", null, Map.of(
                "Origin", "https://evil.example", "Access-Control-Request-Method", "GET", "Host", "oupay-api.onrender.com"));
        assertThat(preflight.raw().getHeader("Access-Control-Allow-Origin")).isNull();
        assertThat(preflight.raw().getHeader("Access-Control-Allow-Credentials")).isNull();
        assertThat(preflight.status()).isIn(401, 403, 404, 405);
    }

    @Test
    void publicPaymentPagesAreNeverCachedByTheProxyAndCarryNoCookies() {
        var response = get(new TestApi(mvc), "/api/v1/public/payment-profiles/AAAAAAAAAAAA");
        assertThat(response.raw().getHeader("Cache-Control")).contains("no-store");
        assertThat(response.raw().getHeaders("Set-Cookie")).isEmpty();
        var authed = get(new TestApi(mvc), "/api/v1/auth/session");
        assertThat(authed.raw().getHeader("Cache-Control")).contains("no-store");
    }
}
