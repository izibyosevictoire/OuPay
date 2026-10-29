package rw.oupay.banking;

import java.nio.charset.StandardCharsets;
import java.security.InvalidKeyException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.HexFormat;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Pattern;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * SIMULATION ONLY. This is NOT Equity Bank's API. There are no real endpoints, field names,
 * signatures or credentials here. The event format below is INVENTED for local development and
 * testing; a real adapter will be written from the bank's actual documentation once an integration
 * is approved. Events must carry {@code "simulated": true} or they are refused.
 *
 * <p>Authentication is a stand-in too: an HMAC-SHA256 of the raw body with a shared secret that is
 * configured explicitly (there is no default). It demonstrates the shape of the trust boundary and
 * says nothing about how a real bank authenticates.
 */
@Component
public class SimulatedProviderAdapter implements BankingProviderAdapter,
        BankingProviderAdapter.AccountLinkingCapable, BankingProviderAdapter.EventAuthenticating {

    public static final String SIGNATURE_HEADER = "x-oupay-simulator-signature";

    private static final Pattern DEMO_REFERENCE = Pattern.compile("^SIM-[A-Z0-9]{4,12}$");
    private static final long MAX_AMOUNT = 10_000_000_000L;

    /** An event signed longer ago (or further in the future) than this is a replay or a clock fault: refused. */
    static final Duration TIMESTAMP_TOLERANCE = Duration.ofMinutes(5);

    private final JsonMapper json;
    private final SimulatedProviderProperties properties;
    private final Clock clock;

    public SimulatedProviderAdapter(JsonMapper json, SimulatedProviderProperties properties, Clock clock) {
        this.json = json;
        this.properties = properties;
        this.clock = clock;
    }

    @Override
    public ProviderId providerId() {
        return ProviderId.EQUITY_MOCK;
    }

    @Override
    public String displayName() {
        return "Equity Bank (simulated)";
    }

    @Override
    public boolean isSimulated() {
        return true;
    }

    /** Everything "supported" because this is a simulator we control. It says nothing about the real bank. */
    @Override
    public ProviderCapabilities capabilities() {
        return new ProviderCapabilities(Capability.SUPPORTED, Capability.SUPPORTED, Capability.NOT_SUPPORTED,
                Capability.SUPPORTED, Capability.NOT_SUPPORTED, Capability.SUPPORTED, Capability.NOT_SUPPORTED,
                Capability.SUPPORTED);
    }

    @Override
    public AccountLinkValidation validateAccountLink(String accountReference) {
        String reference = accountReference == null ? "" : accountReference.trim().toUpperCase(Locale.ROOT);
        if (reference.equals("SIM-ERROR")) {
            return new AccountLinkValidation(false, null, null, "Simulated provider error. Try a different demo reference.");
        }
        if (!DEMO_REFERENCE.matcher(reference).matches()) {
            return new AccountLinkValidation(false, null, null,
                    "Demo references look like SIM-1234. Never enter real banking details here.");
        }
        return new AccountLinkValidation(true, "bacc-" + UUID.randomUUID().toString().substring(0, 8),
                "••••" + reference.substring(reference.length() - 4), null);
    }

    /**
     * The header looks like {@code t=<epoch seconds>,v1=<hex>} and the signature is the HMAC-SHA256 of
     * {@code t + "." + body}. Binding the timestamp into the signature means a captured request cannot be
     * replayed later (it falls outside the tolerance) and the timestamp cannot be changed without
     * invalidating the signature. (A stand-in format: a real provider defines its own.)
     */
    @Override
    public boolean isAuthentic(Map<String, String> headers, String rawBody) {
        String secret = properties.sharedSecret();
        String supplied = headers.get(SIGNATURE_HEADER);
        if (secret == null || secret.isBlank() || supplied == null || rawBody == null) {
            return false;
        }
        String timestamp = null;
        String signature = null;
        for (String part : supplied.split(",")) {
            String piece = part.trim();
            if (piece.startsWith("t=")) {
                timestamp = piece.substring(2);
            } else if (piece.startsWith("v1=")) {
                signature = piece.substring(3);
            }
        }
        if (timestamp == null || signature == null) {
            return false;
        }
        try {
            long signedAt = Long.parseLong(timestamp);
            if (Math.abs(clock.instant().getEpochSecond() - signedAt) > TIMESTAMP_TOLERANCE.toSeconds()) {
                return false;
            }
            byte[] expected = hmac(secret, timestamp + "." + rawBody);
            byte[] given = HexFormat.of().parseHex(signature.trim().toLowerCase(Locale.ROOT));
            // Constant-time comparison: no timing signal about how much of the signature matched.
            return MessageDigest.isEqual(expected, given);
        } catch (IllegalArgumentException e) {
            return false;
        }
    }

    /** Computes the header a legitimate simulator would send for a body signed at the given time. */
    public static String sign(String secret, String rawBody, Instant signedAt) {
        String timestamp = Long.toString(signedAt.getEpochSecond());
        return "t=" + timestamp + ",v1=" + HexFormat.of().formatHex(hmac(secret, timestamp + "." + rawBody));
    }

    /** Signed now. Used by tests and the dev tooling. */
    public static String sign(String secret, String rawBody) {
        return sign(secret, rawBody, Instant.now());
    }

    private static byte[] hmac(String secret, String message) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            return mac.doFinal(message.getBytes(StandardCharsets.UTF_8));
        } catch (NoSuchAlgorithmException | InvalidKeyException e) {
            throw new IllegalStateException(e);
        }
    }

    @Override
    public NormalizedBankEvent normalizeTransactionEvent(String rawBody) {
        JsonNode node;
        try {
            node = json.readTree(rawBody);
        } catch (RuntimeException e) {
            throw new InvalidProviderEventException("The event is not valid JSON.");
        }
        if (node == null || !node.isObject()) {
            throw new InvalidProviderEventException("The event is not an object.");
        }
        if (!node.path("simulated").asBoolean(false)) {
            throw new InvalidProviderEventException("Only simulator events are accepted by this adapter.");
        }
        EventStatus status = switch (text(node, "state", 20)) {
            case "POSTED" -> EventStatus.CONFIRMED;
            case "PENDING" -> EventStatus.PENDING;
            case "REJECTED" -> EventStatus.FAILED;
            case "REVERSED" -> EventStatus.REVERSED;
            default -> throw new InvalidProviderEventException("Unknown payment state.");
        };
        JsonNode amount = node.path("amount");
        if (!amount.isIntegralNumber() || amount.asLong() <= 0 || amount.asLong() > MAX_AMOUNT) {
            throw new InvalidProviderEventException("The amount must be a positive whole number of francs.");
        }
        if (!"RWF".equals(node.path("currency").asString(""))) {
            throw new InvalidProviderEventException("Only RWF is supported.");
        }
        Instant occurredAt;
        try {
            occurredAt = Instant.parse(text(node, "occurredAt", 40));
        } catch (DateTimeParseException e) {
            throw new InvalidProviderEventException("The timestamp is not a date.");
        }
        String reference = node.path("reference").isString() ? node.path("reference").asString().trim() : "";
        if (reference.length() > 64) {
            throw new InvalidProviderEventException("The reference is too long.");
        }
        // The simulator's OPTIONAL code field. Like the reference it is kept exactly as sent (matching is exact), and an over-long or
        // unprintable value makes the whole event untrustworthy rather than being silently altered.
        String code = node.path("collectionCode").isString() ? node.path("collectionCode").asString().trim() : "";
        if (code.length() > 64 || code.chars().anyMatch(c -> c < 0x20 || c == 0x7f)) {
            throw new InvalidProviderEventException("The collection code is not valid.");
        }
        String payer = node.path("payerName").isString() ? node.path("payerName").asString().trim() : "";
        return new NormalizedBankEvent(ProviderId.EQUITY_MOCK, text(node, "eventId", 120), text(node, "transactionId", 120),
                status, amount.asLong(),
                // Kept exactly as sent: matching is exact, so no case folding or guessing.
                reference.isEmpty() ? null : reference,
                payer.isEmpty() ? "Unknown payer" : payer.substring(0, Math.min(payer.length(), 80)),
                occurredAt, text(node, "accountRef", 64), true, code.isEmpty() ? null : code);
    }

    private static String text(JsonNode node, String field, int maxLength) {
        JsonNode value = node.path(field);
        if (!value.isString() || value.asString().isBlank() || value.asString().length() > maxLength) {
            throw new InvalidProviderEventException("Missing or invalid " + field + ".");
        }
        return value.asString();
    }
}
