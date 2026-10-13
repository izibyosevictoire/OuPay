package rw.oupay.payment;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpMethod;
import org.springframework.test.context.TestPropertySource;
import rw.oupay.support.IntegrationTest;
import rw.oupay.support.TestApi;

/** Anti-abuse on the unauthenticated surface (low limits so the test is quick). */
@TestPropertySource(properties = {
        "oupay.rate-limit.public-read-per-minute=5",
        "oupay.rate-limit.public-write-per-minute=3",
        "oupay.rate-limit.auth-per-minute=4"})
class RateLimitIT extends IntegrationTest {

    @Test
    void publicReadsAreLimitedPerClientAndTheLimiterSaysHowLongToWait() {
        for (int i = 0; i < 5; i++) {
            assertThat(TestApi.anonymous(mvc, HttpMethod.GET, "/api/v1/public/payment-profiles/AAAAAAAAAAAA", null, Map.of()).status()).isEqualTo(404);
        }
        var limited = TestApi.anonymous(mvc, HttpMethod.GET, "/api/v1/public/payment-profiles/AAAAAAAAAAAA", null, Map.of());
        assertThat(limited.status()).isEqualTo(429);
        assertThat(limited.code()).isEqualTo("rate_limited");
        assertThat(limited.raw().getHeader("Retry-After")).isNotNull();
    }

    @Test
    void publicWritesHaveAStricterLimit() {
        int limited = 0;
        for (int i = 0; i < 6; i++) {
            var response = TestApi.anonymous(mvc, HttpMethod.POST, "/api/v1/public/payment-profiles/AAAAAAAAAAAA/requests", Map.of("amount", 500), Map.of());
            if (response.status() == 429) limited++;
        }
        assertThat(limited).isEqualTo(3);
    }

    @Test
    void loginAttemptsAreLimitedBeforeTheyReachTheCredentialCheck() {
        int limited = 0;
        for (int i = 0; i < 8; i++) {
            var response = new TestApi(mvc).post("/api/v1/auth/login", Map.of("email", "nobody@example.rw", "password", "Wrong-pass-1"));
            if (response.status() == 429) limited++;
        }
        assertThat(limited).isPositive();
    }
}
