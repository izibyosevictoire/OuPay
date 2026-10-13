package rw.oupay.security;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import rw.oupay.support.Fixtures;
import rw.oupay.support.IntegrationTest;
import rw.oupay.support.TestApi;

/**
 * Regression found in browser testing: the CSRF cookie used to be cleared and re-issued on alternate signed-in
 * requests, so parallel requests could carry a stale token and be refused with 403. It must stay stable for the
 * whole session and be rotated exactly when a new session starts.
 */
class CsrfCookieStabilityIT extends IntegrationTest {

    private static List<String> xsrfCookies(TestApi.Response response) {
        return response.raw().getHeaders("Set-Cookie").stream().filter(c -> c.startsWith("XSRF-TOKEN=")).toList();
    }

    @Test
    void theCsrfCookieIsNotTouchedByRepeatedSignedInRequests() {
        var person = fixtures.user("stable@shop.rw", "Stable");
        TestApi api = fixtures.signIn(mvc, person);
        api.get("/api/v1/auth/session");                       // make sure a cookie exists after the login rotation
        String token = api.cookie("XSRF-TOKEN");
        assertThat(token).isNotBlank();
        for (int i = 0; i < 5; i++) {
            var response = api.get("/api/v1/auth/session");
            assertThat(response.status()).isEqualTo(200);
            assertThat(xsrfCookies(response)).as("request " + i).isEmpty();
        }
        assertThat(api.cookie("XSRF-TOKEN")).isEqualTo(token);
        // And it keeps working for writes, repeatedly, without a re-fetch in between.
        for (int i = 0; i < 3; i++) {
            assertThat(api.post("/api/v1/auth/email-verification/request", null).status()).isEqualTo(204);
        }
    }

    @Test
    void signingInRotatesTheToken() {
        fixtures.user("rotate@shop.rw", "Rotate");
        TestApi api = new TestApi(mvc);
        api.get("/api/v1/auth/session");
        String before = api.cookie("XSRF-TOKEN");
        var login = api.post("/api/v1/auth/login", Map.of("email", "rotate@shop.rw", "password", Fixtures.PASSWORD));
        assertThat(login.status()).isEqualTo(200);
        // The old value is expired in the login response, so a token that existed before sign-in is not reused after it.
        assertThat(xsrfCookies(login)).anyMatch(c -> c.contains("Max-Age=0") || c.contains("Expires=Thu, 01 Jan 1970"));
        api.get("/api/v1/auth/session");
        assertThat(api.cookie("XSRF-TOKEN")).isNotBlank().isNotEqualTo(before);
    }
}
