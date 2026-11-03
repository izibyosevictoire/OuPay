package rw.oupay.checkout;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.test.context.TestPropertySource;
import tools.jackson.databind.JsonNode;

/** R8b: the public entry endpoints sit inside the existing per-address rate limits (reads and writes separately), and a refusal reveals nothing. */
@TestPropertySource(properties = {
        "oupay.rate-limit.public-read-per-minute=5",
        "oupay.rate-limit.public-write-per-minute=3"})
class PaymentEntryRateLimitIT extends PaymentEntryTestSupport {

    @Test
    void scanningFloodsAndClaimFloodsAreRefusedWithoutRevealingAnything() {
        JsonNode sale = liveSale();
        JsonNode d = device("STATIC_QR", "Counter 1", null);
        bound(d, sale);
        String token = token(d);
        List<Integer> reads = new ArrayList<>();
        for (int i = 0; i < 8; i++) {
            reads.add(viewAs(token, null).status());
        }
        assertThat(reads.subList(0, 5)).containsOnly(200);
        assertThat(reads.subList(5, 8)).containsOnly(429);
        List<Integer> writes = new ArrayList<>();
        for (int i = 0; i < 6; i++) {
            writes.add(claimAs(token, null).status());
        }
        assertThat(writes.get(0)).isEqualTo(200);
        assertThat(writes.subList(3, 6)).containsOnly(429);
        // A refused request carries no data about the device, the bill or the business.
        var refused = viewAs(token, null);
        assertThat(refused.status()).isEqualTo(429);
        assertThat(refused.body()).doesNotContain(reference(sale)).doesNotContain("Sample Shop").doesNotContain(token);
    }
}
