package rw.oupay.banking;

import java.nio.charset.StandardCharsets;
import java.security.InvalidKeyException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
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

    private final JsonMapper json;
    private final SimulatedProviderProperties properties;

    public SimulatedProviderAdapter(JsonMapper json, SimulatedProviderProperties properties) {
        this.json = json;
        this.properties = properties;
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

    @Override
    public boolean isAuthentic(Map<String, String> headers, String rawBody) {
        String secret = properties.sharedSecret();
        String supplied = headers.get(SIGNATURE_HEADER);
        if (secret == null || secret.isBlank() || supplied == null || rawBody == null) {
            return false;
        }
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            byte[] expected = mac.doFinal(rawBody.getBytes(StandardCharsets.UTF_8));
            byte[] given = HexFormat.of().parseHex(supplied.trim().toLowerCase(Locale.ROOT));
            // Constant-time comparison: no timing signal about how much of the signature matched.
            return MessageDigest.isEqual(expected, given);
        } catch (NoSuchAlgorithmException | InvalidKeyException | IllegalArgumentException e) {
            return false;
        }
    }

    /** Computes the signature a legitimate simulator would send. Used by tests and the dev tooling. */
    public static String sign(String secret, String rawBody) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            return HexFormat.of().formatHex(mac.doFinal(rawBody.getBytes(StandardCharsets.UTF_8)));
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
        String payer = node.path("payerName").isString() ? node.path("payerName").asString().trim() : "";
        return new NormalizedBankEvent(ProviderId.EQUITY_MOCK, text(node, "eventId", 120), text(node, "transactionId", 120),
                status, amount.asLong(),
                // Kept exactly as sent: matching is exact, so no case folding or guessing.
                reference.isEmpty() ? null : reference,
                payer.isEmpty() ? "Unknown payer" : payer.substring(0, Math.min(payer.length(), 80)),
                occurredAt, text(node, "accountRef", 64), true);
    }

    private static String text(JsonNode node, String field, int maxLength) {
        JsonNode value = node.path(field);
        if (!value.isString() || value.asString().isBlank() || value.asString().length() > maxLength) {
            throw new InvalidProviderEventException("Missing or invalid " + field + ".");
        }
        return value.asString();
    }
}
