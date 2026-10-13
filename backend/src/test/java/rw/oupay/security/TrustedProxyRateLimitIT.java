package rw.oupay.security;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpMethod;
import org.springframework.test.context.TestPropertySource;
import rw.oupay.support.IntegrationTest;
import rw.oupay.support.TestApi;

/** The test client connects from 127.0.0.1, which is configured here as the trusted reverse proxy. */
@TestPropertySource(properties = {
        "oupay.security.proxy.trusted=127.0.0.1/32",
        "oupay.rate-limit.recovery-per-minute=2"})
class TrustedProxyRateLimitIT extends IntegrationTest {

    private int status(String forwardedFor) {
        return new TestApi(mvc).send(HttpMethod.POST, "/api/v1/auth/password-reset/request", Map.of("email", "someone@example.rw"),
                Map.of("X-Forwarded-For", forwardedFor)).status();
    }

    @Test
    void clientsBehindATrustedProxyAreLimitedIndividually() {
        assertThat(status("198.51.100.1")).isEqualTo(204);
        assertThat(status("198.51.100.1")).isEqualTo(204);
        assertThat(status("198.51.100.1")).isEqualTo(429);
        // A different real client is not punished for the first one's requests.
        assertThat(status("198.51.100.2")).isEqualTo(204);
    }

    @Test
    void aClientCannotPrependAFakeAddressToEscapeItsOwnBucket() {
        assertThat(status("198.51.100.9")).isEqualTo(204);
        assertThat(status("1.1.1.1, 198.51.100.9")).isEqualTo(204);
        // The proxy appended the real address last; the right-most untrusted hop identifies the client, so these share one bucket.
        assertThat(status("2.2.2.2, 198.51.100.9")).isEqualTo(429);
    }
}
