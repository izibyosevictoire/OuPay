package rw.oupay.security;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpMethod;
import org.springframework.test.context.TestPropertySource;
import rw.oupay.support.Fixtures;
import rw.oupay.support.IntegrationTest;
import rw.oupay.support.TestApi;

/**
 * Proxying does not solve Origin handling by itself: the backend's own Host (Render) differs from the browser's
 * Origin (Vercel). Without OUPAY_ALLOWED_ORIGINS every state-changing request through the proxy is refused. This
 * is the failure an operator sees if the variable is forgotten, and it fails closed.
 */
@TestPropertySource(properties = {
        "oupay.security.session.secure-cookie=true",
        "oupay.security.session.cookie-name=__Host-oupay_session"})
class ProxyWithoutAllowedOriginIT extends IntegrationTest {

    @Test
    void withoutTheAllowedOriginConfiguredLoginThroughTheProxyIsRefused() {
        var person = fixtures.user("noorigin@shop.rw", "No Origin");
        TestApi browser = new TestApi(mvc);
        Map<String, String> viaVercel = Map.of("Host", "oupay-api.onrender.com", "Origin", "https://oupay-staging.vercel.app");
        browser.send(HttpMethod.GET, "/api/v1/auth/session", null, viaVercel);
        var login = browser.send(HttpMethod.POST, "/api/v1/auth/login", Map.of("email", person.email(), "password", Fixtures.PASSWORD), viaVercel);
        assertThat(login.status()).isEqualTo(403);
        assertThat(login.code()).isEqualTo("forbidden");
        assertThat(login.raw().getHeaders("Set-Cookie").stream().filter(c -> c.startsWith("__Host-oupay_session="))).isEmpty();
        assertThat(jdbc.queryForObject("select count(*) from auth_sessions", Integer.class)).isZero();
    }
}
