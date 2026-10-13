package rw.oupay.security;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.test.context.TestPropertySource;
import rw.oupay.support.Fixtures;
import rw.oupay.support.IntegrationTest;
import rw.oupay.support.TestApi;

/** The settings production uses: Secure __Host- session cookie, HSTS, no API documentation endpoints. */
@TestPropertySource(properties = {
        "oupay.security.session.secure-cookie=true",
        "oupay.security.session.cookie-name=__Host-oupay_session",
        "springdoc.api-docs.enabled=false",
        "springdoc.swagger-ui.enabled=false"})
class ProductionLikeConfigIT extends IntegrationTest {

    @Test
    void theSessionCookieIsSecureAndHostPrefixed() {
        fixtures.user("prod@shop.rw", "Prod");
        var api = new TestApi(mvc);
        var login = api.post("/api/v1/auth/login", Map.of("email", "prod@shop.rw", "password", Fixtures.PASSWORD));
        assertThat(login.status()).isEqualTo(200);
        String cookie = login.raw().getHeaders("Set-Cookie").stream().filter(c -> c.startsWith("__Host-oupay_session=")).findFirst().orElseThrow();
        assertThat(cookie).contains("Secure").contains("HttpOnly").contains("SameSite=Lax").contains("Path=/").doesNotContain("Domain=");
        // The readable CSRF cookie is Secure as well.
        var first = new TestApi(mvc).get("/api/v1/auth/session");
        assertThat(first.raw().getHeaders("Set-Cookie").stream().filter(c -> c.startsWith("XSRF-TOKEN=")).findFirst().orElseThrow()).contains("Secure");
        // And the session works under that name.
        assertThat(api.get("/api/v1/auth/session").status()).isEqualTo(200);
    }

    @Test
    void strictTransportSecurityIsSentEvenWhenTlsEndsAtTheProxy() {
        var response = new TestApi(mvc).get("/api/v1/auth/session");
        assertThat(response.raw().getHeader("Strict-Transport-Security")).contains("max-age=31536000").contains("includeSubDomains");
    }

    @Test
    void apiDocumentationIsNotServed() {
        for (String path : new String[] {"/v3/api-docs", "/v3/api-docs/swagger-config", "/swagger-ui.html", "/swagger-ui/index.html"}) {
            assertThat(new TestApi(mvc).get(path).status()).as(path).isIn(401, 403, 404);
        }
    }
}
