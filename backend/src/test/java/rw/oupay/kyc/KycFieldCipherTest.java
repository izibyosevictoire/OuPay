package rw.oupay.kyc;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Base64;
import org.junit.jupiter.api.Test;

class KycFieldCipherTest {

    private static final String KEY = Base64.getEncoder().encodeToString("0123456789abcdef0123456789abcdef".getBytes(StandardCharsets.UTF_8));
    private static final String OTHER = Base64.getEncoder().encodeToString("fedcba9876543210fedcba9876543210".getBytes(StandardCharsets.UTF_8));

    @Test
    void roundTripsAndNeverRepeatsTheSameCiphertext() {
        KycFieldCipher cipher = new KycFieldCipher(KEY, "k1");
        byte[] first = cipher.encrypt("1199880012345678", "m|a|f");
        byte[] second = cipher.encrypt("1199880012345678", "m|a|f");
        assertThat(cipher.decrypt(first, "k1", "m|a|f")).isEqualTo("1199880012345678");
        assertThat(first).isNotEqualTo(second);
        assertThat(new String(first, StandardCharsets.ISO_8859_1)).doesNotContain("1199880012345678");
    }

    @Test
    void aCiphertextOnlyOpensWhereItWasMadeAndWithTheRightKey() {
        KycFieldCipher cipher = new KycFieldCipher(KEY, "k1");
        byte[] sealed = cipher.encrypt("secret", "merchant-1|app|field");
        assertThatThrownBy(() -> cipher.decrypt(sealed, "k1", "merchant-2|app|field")).isInstanceOf(IllegalStateException.class).hasMessageNotContaining("secret");
        assertThatThrownBy(() -> new KycFieldCipher(OTHER, "k1").decrypt(sealed, "k1", "merchant-1|app|field")).isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> cipher.decrypt(sealed, "k0", "merchant-1|app|field")).isInstanceOf(IllegalStateException.class);
        byte[] tampered = Arrays.copyOf(sealed, sealed.length);
        tampered[tampered.length - 1] ^= 1;
        assertThatThrownBy(() -> cipher.decrypt(tampered, "k1", "merchant-1|app|field")).isInstanceOf(IllegalStateException.class);
    }

    @Test
    void withoutAKeyNothingSensitiveIsEverStoredAndABadKeyStopsTheApplication() {
        KycFieldCipher none = new KycFieldCipher("", "k1");
        assertThat(none.available()).isFalse();
        assertThatThrownBy(() -> none.encrypt("x", "c")).isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> new KycFieldCipher("not base64 !!", "k1")).isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> new KycFieldCipher(Base64.getEncoder().encodeToString(new byte[16]), "k1")).isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("32 bytes");
    }
}
