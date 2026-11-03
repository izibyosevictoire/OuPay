package rw.oupay.entry;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;
import java.util.HashSet;
import java.util.Set;
import org.junit.jupiter.api.Test;

/** The entropy and shape of the two opaque values of a payment-entry device. */
class EntryTokensTest {

    @Test
    void deviceTokensAreOneHundredTwentyEightRandomBitsAndNeverRepeat() {
        Set<String> seen = new HashSet<>();
        for (int i = 0; i < 5_000; i++) {
            String token = EntryTokens.newDeviceToken();
            assertThat(token).matches(EntryTokens.DEVICE_TOKEN);
            // 22 base64url characters decode to exactly 16 bytes: 128 bits.
            assertThat(Base64.getUrlDecoder().decode(token)).hasSize(16);
            assertThat(seen.add(token)).isTrue();
        }
    }

    @Test
    void tokensAreNotSequentialOrPatternedAtAnyPosition() {
        // A counter or a timestamp would leave most positions with a handful of values. Random tokens use the whole alphabet everywhere.
        int positions = 22;
        for (int p = 0; p < positions - 1; p++) {
            Set<Character> values = new HashSet<>();
            for (int i = 0; i < 3_000; i++) {
                values.add(EntryTokens.newDeviceToken().charAt(p));
            }
            assertThat(values.size()).as("position %d", p).isGreaterThan(15);
        }
    }

    @Test
    void claimTokensAreTwoHundredFiftySixBitsAndOnlyTheirHashIsStorable() {
        Set<String> seen = new HashSet<>();
        for (int i = 0; i < 2_000; i++) {
            String token = EntryTokens.newClaimToken();
            assertThat(token).matches(EntryTokens.CLAIM_TOKEN);
            assertThat(Base64.getUrlDecoder().decode(token)).hasSize(32);
            assertThat(seen.add(token)).isTrue();
        }
        String token = EntryTokens.newClaimToken();
        assertThat(EntryTokens.hash(token)).hasSize(64).matches("^[0-9a-f]{64}$").isEqualTo(EntryTokens.hash(token)).isNotEqualTo(token);
        assertThat(EntryTokens.hash(token)).isNotEqualTo(EntryTokens.hash(EntryTokens.newClaimToken()));
    }

    @Test
    void theGeneratorIsTheCryptographicOneAndNothingElseIsUsedForTokens() throws IOException {
        String source = Files.readString(Path.of("src/main/java/rw/oupay/entry/EntryTokens.java"));
        assertThat(source).contains("SecureRandom").doesNotContain("java.util.Random").doesNotContain("Math.random").doesNotContain("UUID").doesNotContain("System.currentTimeMillis");
    }
}
