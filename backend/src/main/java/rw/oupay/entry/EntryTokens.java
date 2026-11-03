package rw.oupay.entry;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.HexFormat;
import java.util.regex.Pattern;

/**
 * The two kinds of opaque value of a payment-entry device. Both come from the platform's cryptographic random generator.
 *
 * <p>The DEVICE token is the public identifier printed in a QR code and written to an NFC tag: 128 random bits, so it can neither be guessed
 * nor enumerated, and it names no merchant, branch, cashier or sale. It is not a credential (anyone holding the tag can read it).
 *
 * <p>The CLAIM token is a bearer secret of ONE customer's session: 256 random bits, shown to that customer once and stored only as a hash.
 */
final class EntryTokens {

    static final Pattern DEVICE_TOKEN = Pattern.compile("^[A-Za-z0-9_-]{22}$");
    static final Pattern CLAIM_TOKEN = Pattern.compile("^[A-Za-z0-9_-]{43}$");

    private static final SecureRandom RANDOM = new SecureRandom();
    private static final Base64.Encoder URL = Base64.getUrlEncoder().withoutPadding();

    private EntryTokens() {}

    static String newDeviceToken() {
        return random(16);
    }

    static String newClaimToken() {
        return random(32);
    }

    private static String random(int bytes) {
        byte[] value = new byte[bytes];
        RANDOM.nextBytes(value);
        return URL.encodeToString(value);
    }

    /** Lower-case hex SHA-256: the only form in which a claim token is stored. */
    static String hash(String token) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(token.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is unavailable", e);
        }
    }
}
