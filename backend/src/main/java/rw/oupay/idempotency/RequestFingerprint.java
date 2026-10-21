package rw.oupay.idempotency;

import java.math.BigDecimal;
import java.util.Map;
import java.util.TreeMap;
import rw.oupay.common.TokenHashing;

/**
 * A stable SHA-256 of "what this request asks for", so a reused idempotency key with different data can be told apart
 * from an honest retry. The input is reduced to a canonical text first:
 * <ul>
 *   <li>object keys are sorted, so field order never matters;</li>
 *   <li>numbers are normalised ({@code 2}, {@code 2.0} and {@code 2.00} are the same quantity);</li>
 *   <li>arrays keep their order (a different order is a different request);</li>
 *   <li>strings are escaped, so no two different values can produce the same text;</li>
 *   <li>the operation name and the route parameters (merchant, resource ids) are part of the fingerprint, so the same
 *       body sent to a different resource is a different request.</li>
 * </ul>
 * The body must already be a plain structure (maps, lists, strings, numbers, booleans, null); see
 * {@link IdempotencyService#fingerprintOf}, which converts request objects.
 */
public final class RequestFingerprint {

    private static final String VERSION_PREFIX = "oupay-request-v1:";

    private RequestFingerprint() {}

    public static String of(String operation, Map<String, ?> routeParameters, Object plainBody) {
        Map<String, Object> request = new TreeMap<>();
        request.put("operation", operation);
        request.put("route", routeParameters);
        request.put("body", plainBody);
        return TokenHashing.sha256Hex(VERSION_PREFIX + canonical(request));
    }

    /** The canonical text itself. Exposed for tests. */
    static String canonical(Object plainValue) {
        StringBuilder out = new StringBuilder();
        append(out, plainValue);
        return out.toString();
    }

    private static void append(StringBuilder out, Object value) {
        switch (value) {
            case null -> out.append("null");
            case Map<?, ?> map -> appendObject(out, map);
            case Iterable<?> items -> appendArray(out, items);
            case Number number -> out.append(new BigDecimal(number.toString()).stripTrailingZeros().toPlainString());
            case Boolean flag -> out.append(flag.booleanValue());
            default -> appendQuoted(out, value.toString());
        }
    }

    private static void appendObject(StringBuilder out, Map<?, ?> map) {
        Map<String, Object> sorted = new TreeMap<>();
        map.forEach((key, entry) -> sorted.put(String.valueOf(key), entry));
        out.append('{');
        boolean first = true;
        for (Map.Entry<String, Object> entry : sorted.entrySet()) {
            if (!first) {
                out.append(',');
            }
            first = false;
            appendQuoted(out, entry.getKey());
            out.append(':');
            append(out, entry.getValue());
        }
        out.append('}');
    }

    private static void appendArray(StringBuilder out, Iterable<?> items) {
        out.append('[');
        boolean first = true;
        for (Object item : items) {
            if (!first) {
                out.append(',');
            }
            first = false;
            append(out, item);
        }
        out.append(']');
    }

    private static void appendQuoted(StringBuilder out, String text) {
        out.append('"');
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (c == '"' || c == '\\') {
                out.append('\\').append(c);
            } else if (c < 0x20) {
                out.append(String.format("\\u%04x", (int) c));
            } else {
                out.append(c);
            }
        }
        out.append('"');
    }
}
