package rw.oupay.security;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpMethod;
import org.springframework.test.context.TestPropertySource;
import rw.oupay.support.IntegrationTest;
import rw.oupay.support.TestApi;

/**
 * Rate limiting WITHOUT trusted proxies: the X-Forwarded-For header is attacker-controlled, so it must never
 * change which bucket a caller falls into. Each surface has its own bucket.
 */
@TestPropertySource(properties = {
        "oupay.rate-limit.recovery-per-minute=3",
        "oupay.rate-limit.auth-per-minute=50",
        "oupay.rate-limit.public-read-per-minute=4"})
class RateLimitHardeningIT extends IntegrationTest {

    private static final String P1 = "192.0.2.11";
    private static final String P2 = "192.0.2.12";
    private static final String P3 = "192.0.2.13";
    private static final String P4 = "192.0.2.14";
    private static final String P5 = "192.0.2.15";

    private TestApi.Response reset(String peer, String forwardedFor) {
        Map<String, String> headers = forwardedFor == null ? Map.of() : Map.of("X-Forwarded-For", forwardedFor);
        return new TestApi(mvc).from(peer).send(HttpMethod.POST, "/api/v1/auth/password-reset/request", Map.of("email", "someone@example.rw"), headers);
    }

    @Test
    void accountRecoveryEndpointsHaveTheirOwnLimit() {
        for (int i = 0; i < 3; i++) {
            assertThat(reset(P1, null).status()).isEqualTo(204);
        }
        var limited = reset(P1, null);
        assertThat(limited.status()).isEqualTo(429);
        assertThat(limited.code()).isEqualTo("rate_limited");
        assertThat(limited.raw().getHeader("Retry-After")).isNotNull();
        // Other surfaces are unaffected by a flood on this one.
        assertThat(new TestApi(mvc).from(P5).post("/api/v1/auth/login", Map.of("email", "nobody@example.rw", "password", "Wrong-pass-1")).status()).isEqualTo(401);
    }

    @Test
    void inventingAForwardedForHeaderDoesNotEscapeTheLimit() {
        for (int i = 0; i < 3; i++) {
            assertThat(reset(P2, "198.51.100." + i).status()).isEqualTo(204);
        }
        // A "different client" every time, but the proxy chain is not trusted, so they are all the same peer.
        assertThat(reset(P2, "198.51.100.77").status()).isEqualTo(429);
        assertThat(reset(P2, "203.0.113.1, 198.51.100.78").status()).isEqualTo(429);
    }

    @Test
    void verifyingAndConfirmingLinksShareTheRecoveryBucketSoTokensCannotBeGuessedQuickly() {
        int refused = 0;
        for (int i = 0; i < 10; i++) {
            var response = new TestApi(mvc).from(P3).post("/api/v1/auth/password-reset/verify", Map.of("token", "g".repeat(43)));
            if (response.status() == 429) {
                refused++;
            }
        }
        assertThat(refused).isEqualTo(7);
    }

    @Test
    void publicInvitationPreviewsAreLimitedAsPublicReads() {
        int refused = 0;
        for (int i = 0; i < 8; i++) {
            if (new TestApi(mvc).from(P4).get("/api/v1/public/invitations/" + "q".repeat(43)).status() == 429) {
                refused++;
            }
        }
        assertThat(refused).isEqualTo(4);
    }
}
