package rw.oupay.kyc;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.SecureRandom;
import java.util.Base64;
import javax.crypto.Cipher;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * Encrypts the few sensitive KYC values (an identity number, a bank account reference) with AES-256-GCM before they reach the database.
 *
 * <p>The key lives in configuration ({@code oupay.kyc.encryption-key}, base64 of 32 bytes), never in the database or the repository. Without
 * a key the cipher is simply unavailable and sensitive values are REFUSED: they are never stored in the clear as a fallback. Each value gets
 * a fresh random 96-bit nonce, and the business, application and field are bound in as authenticated data, so a ciphertext copied to another
 * row or merchant fails to decrypt. The stored form is {@code nonce || ciphertext || tag}.
 *
 * <p>Final, and failing fast on a malformed key in its constructor on purpose (like {@code ProductionSafetyCheck}): a wrong key must stop the
 * application, not silently disable protection.
 */
@Component
public final class KycFieldCipher {

    private static final int NONCE_BYTES = 12;
    private static final int TAG_BITS = 128;

    private final SecretKey key;
    private final String keyId;
    private final SecureRandom random = new SecureRandom();

    public KycFieldCipher(@Value("${oupay.kyc.encryption-key:}") String base64Key, @Value("${oupay.kyc.encryption-key-id:k1}") String keyId) {
        this.keyId = keyId;
        if (base64Key == null || base64Key.isBlank()) {
            this.key = null;
            return;
        }
        byte[] raw;
        try {
            raw = Base64.getDecoder().decode(base64Key.trim());
        } catch (IllegalArgumentException e) {
            throw new IllegalStateException("oupay.kyc.encryption-key must be base64 of exactly 32 bytes");
        }
        if (raw.length != 32) {
            throw new IllegalStateException("oupay.kyc.encryption-key must be base64 of exactly 32 bytes");
        }
        this.key = new SecretKeySpec(raw, "AES");
    }

    public boolean available() {
        return key != null;
    }

    public String keyId() {
        return keyId;
    }

    public byte[] encrypt(String plaintext, String context) {
        requireKey();
        try {
            byte[] nonce = new byte[NONCE_BYTES];
            random.nextBytes(nonce);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key, new GCMParameterSpec(TAG_BITS, nonce));
            cipher.updateAAD(context.getBytes(StandardCharsets.UTF_8));
            byte[] sealed = cipher.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));
            byte[] out = new byte[NONCE_BYTES + sealed.length];
            System.arraycopy(nonce, 0, out, 0, NONCE_BYTES);
            System.arraycopy(sealed, 0, out, NONCE_BYTES, sealed.length);
            return out;
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("A sensitive value could not be protected.");
        }
    }

    public String decrypt(byte[] stored, String storedKeyId, String context) {
        requireKey();
        if (!keyId.equals(storedKeyId)) {
            throw new IllegalStateException("The key that protected this value is not available.");
        }
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(TAG_BITS, stored, 0, NONCE_BYTES));
            cipher.updateAAD(context.getBytes(StandardCharsets.UTF_8));
            return new String(cipher.doFinal(stored, NONCE_BYTES, stored.length - NONCE_BYTES), StandardCharsets.UTF_8);
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("A sensitive value could not be read.");
        }
    }

    private void requireKey() {
        if (key == null) {
            throw new IllegalStateException("Sensitive storage is not configured.");
        }
    }
}
