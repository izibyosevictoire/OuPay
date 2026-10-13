package rw.oupay.ledger;

import java.util.Iterator;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

/**
 * Provider payloads contain personal data (who paid, from which account or phone). The ledger needs only
 * the normalised facts, which are stored in typed columns, so the copy kept in {@code bank_events} is
 * REDACTED before it is written: names are reduced to an initial, account and phone numbers to their last
 * four digits. The SHA-256 of the original is stored next to it, so a replay of the same event id with
 * different content is still detected without keeping the personal data.
 */
public final class EventPayloadRedactor {

    private static final JsonMapper JSON = JsonMapper.builder().build();
    private static final Pattern NAME_KEY = Pattern.compile("(?i).*(name|holder|payer|sender|narration|description|memo).*");
    private static final Pattern NUMBER_KEY = Pattern.compile("(?i).*(account|iban|msisdn|phone|mobile|card|pan|email).*");

    private EventPayloadRedactor() {}

    public static String redact(String rawPayload) {
        try {
            JsonNode node = JSON.readTree(rawPayload);
            if (node == null || !node.isObject()) {
                return "{\"redacted\":true}";
            }
            redactObject((ObjectNode) node);
            return JSON.writeValueAsString(node);
        } catch (RuntimeException e) {
            return "{\"redacted\":true}";
        }
    }

    private static void redactObject(ObjectNode object) {
        Iterator<Map.Entry<String, JsonNode>> fields = object.properties().iterator();
        while (fields.hasNext()) {
            Map.Entry<String, JsonNode> field = fields.next();
            JsonNode value = field.getValue();
            if (value.isObject()) {
                redactObject((ObjectNode) value);
            } else if (value.isString()) {
                String key = field.getKey().toLowerCase(Locale.ROOT);
                if (key.equals("accountref") || NUMBER_KEY.matcher(key).matches()) {
                    object.put(field.getKey(), maskNumber(value.asString()));
                } else if (NAME_KEY.matcher(key).matches()) {
                    object.put(field.getKey(), maskName(value.asString()));
                }
            }
        }
    }

    static String maskName(String name) {
        String trimmed = name.strip();
        return trimmed.isEmpty() ? "" : trimmed.charAt(0) + "***";
    }

    static String maskNumber(String number) {
        String trimmed = number.strip();
        return trimmed.length() <= 4 ? "****" : "****" + trimmed.substring(trimmed.length() - 4);
    }
}
