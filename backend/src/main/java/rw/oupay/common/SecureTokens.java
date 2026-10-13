package rw.oupay.common;

import java.security.SecureRandom;

/** Cryptographically random identifiers. Never use java.util.Random for anything public. */
public final class SecureTokens {

    private static final SecureRandom RANDOM = new SecureRandom();
    private static final char[] BASE62 =
            "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz".toCharArray();
    /** No 0/O/1/I/L/U-free confusion: easy to read aloud and type. */
    private static final char[] REFERENCE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ".toCharArray();

    private SecureTokens() {}

    /** 12 base62 characters is about 71 bits. A public identifier, not a credential. */
    public static String publicToken(int length) {
        return random(BASE62, length);
    }

    /** {@code OP-} plus 12 characters (about 59 bits). */
    public static String paymentReference() {
        return "OP-" + random(REFERENCE_ALPHABET, 12);
    }

    /** 32 random bytes as URL-safe base64, for opaque session cookies. */
    public static String sessionToken() {
        byte[] bytes = new byte[32];
        RANDOM.nextBytes(bytes);
        return java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    private static String random(char[] alphabet, int length) {
        StringBuilder out = new StringBuilder(length);
        for (int i = 0; i < length; i++) {
            out.append(alphabet[RANDOM.nextInt(alphabet.length)]);
        }
        return out.toString();
    }
}
