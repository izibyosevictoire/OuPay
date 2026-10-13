package rw.oupay.security;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpMethod;
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders;
import rw.oupay.support.Fixtures;
import rw.oupay.support.IntegrationTest;
import rw.oupay.support.TestApi;
import rw.oupay.support.World;

/** Cross-cutting hardening: correlation ids, headers, origins, cookies, CSRF on the new endpoints, operational endpoints. */
class SecurityHardeningIT extends IntegrationTest {

    World w;

    @BeforeEach
    void world() {
        w = World.create(this);
    }

    private TestApi anonymous() {
        return new TestApi(mvc);
    }

    // ---- correlation ids -----------------------------------------------------------------------

    @Test
    void everyResponseCarriesACorrelationIdEvenWhenTheRequestIsRefused() {
        var ok = anonymous().get("/api/v1/auth/session");
        assertThat(ok.raw().getHeader("X-Request-Id")).matches("[0-9a-f-]{36}");
        var refused = TestApi.anonymous(mvc, HttpMethod.GET, "/api/v1/merchants", null, Map.of());
        assertThat(refused.status()).isEqualTo(401);
        assertThat(refused.raw().getHeader("X-Request-Id")).isNotBlank();
        assertThat(ok.raw().getHeader("X-Request-Id")).isNotEqualTo(refused.raw().getHeader("X-Request-Id"));
    }

    @Test
    void aWellFormedCallerIdIsKeptAndAnythingElseIsReplaced() {
        var kept = TestApi.anonymous(mvc, HttpMethod.GET, "/api/v1/auth/session", null, Map.of("X-Request-Id", "client-req.123_ABC"));
        assertThat(kept.raw().getHeader("X-Request-Id")).isEqualTo("client-req.123_ABC");
        for (String bad : new String[] {"short", "has space in it 12345", "x".repeat(65), "<script>alert(1)</script>", "a/b/c/d/e/f/g/h"}) {
            var replaced = TestApi.anonymous(mvc, HttpMethod.GET, "/api/v1/auth/session", null, Map.of("X-Request-Id", bad));
            assertThat(replaced.raw().getHeader("X-Request-Id")).as(bad).matches("[0-9a-f-]{36}");
        }
    }

    // ---- headers -------------------------------------------------------------------------------

    @Test
    void responsesCarryTheSecurityHeaders() {
        var response = w.owner.get("/api/v1/merchants");
        var raw = response.raw();
        assertThat(raw.getHeader("Content-Security-Policy")).contains("default-src 'none'").contains("frame-ancestors 'none'");
        assertThat(raw.getHeader("Referrer-Policy")).isEqualTo("no-referrer");
        assertThat(raw.getHeader("X-Content-Type-Options")).isEqualTo("nosniff");
        assertThat(raw.getHeader("Permissions-Policy")).contains("camera=()").contains("geolocation=()");
        assertThat(raw.getHeader("Cache-Control")).contains("no-store");
        assertThat(raw.getHeader("X-Frame-Options")).isNotNull();
        assertThat(raw.getHeader("Server")).isNull();
    }

    // ---- cookies -------------------------------------------------------------------------------

    @Test
    void theSessionCookieIsHttpOnlySameSiteOpaqueAndStoredOnlyHashed() {
        var api = anonymous();
        var login = api.post("/api/v1/auth/login", Map.of("email", w.ownerPerson.email(), "password", Fixtures.PASSWORD));
        String setCookie = login.raw().getHeaders("Set-Cookie").stream().filter(c -> c.startsWith("oupay_session=")).findFirst().orElseThrow();
        assertThat(setCookie).contains("HttpOnly").contains("SameSite=Lax").contains("Path=/");
        String value = api.cookie("oupay_session");
        assertThat(value).hasSizeGreaterThanOrEqualTo(43).matches("[A-Za-z0-9_-]+");
        assertThat(jdbc.queryForList("select encode(token_hash, 'hex') from auth_sessions", String.class)).doesNotContain(value);
        assertThat(login.body()).doesNotContain(value);
        // The readable CSRF cookie is the only cookie JavaScript can see.
        assertThat(login.raw().getHeaders("Set-Cookie").stream().filter(c -> !c.contains("HttpOnly")).toList()).allMatch(c -> c.startsWith("XSRF-TOKEN="));
    }

    // ---- CSRF and origins ----------------------------------------------------------------------

    @Test
    void theNewStateChangingEndpointsAreCsrfProtected() throws Exception {
        String session = w.owner.cookie("oupay_session");
        for (String url : new String[] {"/api/v1/auth/password/change", "/api/v1/auth/email-verification/request",
                "/api/v1/merchants/" + w.merchantId + "/invitations", "/api/v1/invitations/sometoken/accept"}) {
            var result = mvc.perform(MockMvcRequestBuilders.post(url).cookie(new jakarta.servlet.http.Cookie("oupay_session", session))
                    .contentType("application/json").content("{}")).andReturn();
            assertThat(result.getResponse().getStatus()).as(url).isEqualTo(403);
        }
        // Public ones too (login CSRF): a cross-site page cannot make a browser reset someone's password silently.
        var reset = mvc.perform(MockMvcRequestBuilders.post("/api/v1/auth/password-reset/request").contentType("application/json")
                .content("{\"email\":\"a@b.rw\"}")).andReturn();
        assertThat(reset.getResponse().getStatus()).isEqualTo(403);
    }

    @Test
    void aStateChangingRequestFromAnotherSiteIsRefusedEvenWithAValidCsrfToken() {
        // The attacker somehow has a valid token (for instance an XSS elsewhere): the Origin still gives them away.
        var evil = w.owner.send(HttpMethod.POST, "/api/v1/merchants/" + w.merchantId + "/branches", Map.of(),
                Map.of("Origin", "https://evil.example", "Host", "app.oupay.test"));
        assertThat(evil.status()).isEqualTo(403);
        assertThat(evil.code()).isEqualTo("forbidden");
        // The same request from the application's own origin gets through to the real validation (422, not 403).
        var home = w.owner.send(HttpMethod.POST, "/api/v1/merchants/" + w.merchantId + "/branches", Map.of(),
                Map.of("Origin", "https://app.oupay.test", "Host", "app.oupay.test"));
        assertThat(home.status()).isEqualTo(422);
        // Look-alike origins do not match.
        for (String origin : new String[] {"https://app.oupay.test.evil.example", "https://evil.example/app.oupay.test", "null", "http://app.oupay.test:8443"}) {
            assertThat(w.owner.send(HttpMethod.POST, "/api/v1/merchants/" + w.merchantId + "/branches", Map.of(),
                    Map.of("Origin", origin, "Host", "app.oupay.test")).status()).as(origin).isEqualTo(403);
        }
        // Reading is not state-changing.
        assertThat(w.owner.send(HttpMethod.GET, "/api/v1/merchants", null, Map.of("Origin", "https://evil.example", "Host", "app.oupay.test")).status())
                .isEqualTo(200);
    }

    @Test
    void theCookielessPublicSurfaceIsNotSubjectToTheOriginCheck() {
        var response = TestApi.anonymous(mvc, HttpMethod.POST, "/api/v1/public/payment-profiles/unknowntoken1/requests", Map.of("amount", 1000),
                Map.of("Origin", "https://customer-site.example", "Host", "api.oupay.test"));
        assertThat(response.status()).isNotEqualTo(403);
        assertThat(response.raw().getCookies()).isEmpty();
    }

    // ---- operational endpoints -----------------------------------------------------------------

    @Test
    void healthProbesAreOpenAndRevealNothingBeyondTheStatus() {
        for (String path : new String[] {"/actuator/health", "/actuator/health/liveness", "/actuator/health/readiness"}) {
            var response = anonymous().get(path);
            assertThat(response.status()).as(path).isEqualTo(200);
            assertThat(response.json().path("status").asString()).isEqualTo("UP");
            assertThat(response.body()).as(path).doesNotContain("components").doesNotContain("details").doesNotContain("jdbc")
                    .doesNotContain("postgres").doesNotContain("pending");
        }
    }

    @Test
    void everythingElseOnTheManagementSurfaceIsAbsentEvenForSignedInUsers() {
        for (String path : new String[] {"/actuator/metrics", "/actuator/env", "/actuator/beans", "/actuator/heapdump",
                "/actuator/loggers", "/actuator/prometheus", "/actuator/health/emailOutbox"}) {
            assertThat(anonymous().get(path).status()).as("anonymous " + path).isIn(401, 403, 404);
            assertThat(w.owner.get(path).status()).as("signed in " + path).isIn(404);
        }
    }
}
