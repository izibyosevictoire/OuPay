package rw.oupay.common;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

/** Credentials that only ever travel in e-mails and cookies are stored as their SHA-256 hash. */
public final class TokenHashing {

    private TokenHashing() {}

    public static byte[] sha256(String raw) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(raw.getBytes(StandardCharsets.UTF_8));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    public static String sha256Hex(String raw) {
        return java.util.HexFormat.of().formatHex(sha256(raw));
    }
}
