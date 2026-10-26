package rw.oupay.kyc;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Pattern;
import rw.oupay.common.ApiException;

/**
 * A published requirement set as data: the fields, documents and consent text Equity KYC asks for, and the rules to check an answer. Sets are
 * versioned and immutable; an application keeps the version it started under. Nothing here names a specific Equity form field that the bank
 * has confirmed (see docs/equity-technical-questions.md, section 5).
 */
public final class KycRequirements {

    private KycRequirements() {}

    public record Option(String value, String label) {}

    /** The field or document applies only when another field has one of these values. */
    public record AppliesWhen(String key, List<String> in) {}

    public record Section(String key, String label) {}

    /** {@code required} and {@code sensitive} may be left out of a published set: absent means false. */
    public record Field(String key, String section, String label, String type, Boolean required, Boolean sensitive, Integer maxLength,
                        String pattern, String patternHint, String help, List<Option> options, AppliesWhen appliesWhen) {
        public Field {
            required = Boolean.TRUE.equals(required);
            sensitive = Boolean.TRUE.equals(sensitive);
        }
    }

    /**
     * {@code requiredAtSubmission}: an ACTUAL stored file is mandatory before the application can be submitted to OuPay. A document marked
     * ready by the owner never satisfies it. Absent means false (the provisional set 1 cannot demand files while upload is unavailable).
     */
    public record Document(String key, String label, Boolean required, Boolean requiredAtSubmission, AppliesWhen appliesWhen) {
        public Document {
            required = Boolean.TRUE.equals(required);
            requiredAtSubmission = Boolean.TRUE.equals(requiredAtSubmission);
        }
    }

    public record Consent(String textVersion, String text) {}

    public record Definition(String note, List<Section> sections, List<Field> fields, List<Document> documents, Consent consent) {}

    public record RequirementSet(UUID id, String providerId, int version, boolean provisional, Instant effectiveFrom, Definition definition) {

        public Field field(String key) {
            return definition.fields().stream().filter(f -> f.key().equals(key)).findFirst().orElse(null);
        }

        public Document document(String key) {
            return definition.documents().stream().filter(d -> d.key().equals(key)).findFirst().orElse(null);
        }
    }

    private static final Pattern EMAIL = Pattern.compile("^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$");
    private static final Pattern PHONE = Pattern.compile("^\\+?[0-9][0-9 ]{5,18}[0-9]$");
    private static final int DEFAULT_MAX = 200;

    /** Whether a field or document applies, given the answers so far. Nothing hidden by a condition is ever required. */
    public static boolean applies(AppliesWhen when, Map<String, String> values) {
        if (when == null) {
            return true;
        }
        String current = values.get(when.key());
        return current != null && when.in().contains(current);
    }

    /**
     * Checks and normalises one answer. The message names the FIELD, never the value, so a rejected identity number is not echoed anywhere.
     */
    public static String validate(Field field, String raw) {
        String value = raw == null ? "" : raw.trim();
        if (value.isEmpty()) {
            throw ApiException.validation(field.label() + " cannot be empty.");
        }
        if (value.chars().anyMatch(Character::isISOControl)) {
            throw ApiException.validation(field.label() + " must be on one line, without special characters.");
        }
        int max = field.maxLength() == null ? DEFAULT_MAX : field.maxLength();
        switch (field.type()) {
            case "EMAIL" -> {
                if (value.length() > 254 || !EMAIL.matcher(value).matches()) {
                    throw ApiException.validation(field.label() + " is not a valid email address.");
                }
            }
            case "PHONE" -> {
                if (!PHONE.matcher(value).matches()) {
                    throw ApiException.validation(field.label() + " is not a valid phone number.");
                }
            }
            case "CHOICE" -> {
                if (field.options() == null || field.options().stream().noneMatch(o -> o.value().equals(value))) {
                    throw ApiException.validation("Choose one of the offered options for " + field.label() + ".");
                }
            }
            default -> {
                if (value.length() > max) {
                    throw ApiException.validation(field.label() + " can be at most " + max + " characters.");
                }
            }
        }
        if (field.pattern() != null && !Pattern.compile(field.pattern()).matcher(value).matches()) {
            throw ApiException.validation(field.patternHint() == null ? field.label() + " is not in the expected format." : field.label() + ": " + field.patternHint());
        }
        return value;
    }
}
