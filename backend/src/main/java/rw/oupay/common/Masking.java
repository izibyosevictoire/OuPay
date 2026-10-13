package rw.oupay.common;

/** Hides personal data in logs and metrics: enough to correlate, not enough to identify. */
public final class Masking {

    private Masking() {}

    /** {@code jane.doe@example.rw} becomes {@code j***@example.rw}. */
    public static String email(String email) {
        if (email == null || email.isBlank()) {
            return "";
        }
        int at = email.indexOf('@');
        if (at <= 0) {
            return "***";
        }
        return email.charAt(0) + "***" + email.substring(at);
    }
}
