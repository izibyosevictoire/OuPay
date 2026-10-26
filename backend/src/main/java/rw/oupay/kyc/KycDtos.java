package rw.oupay.kyc;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Wire shapes of the Equity KYC onboarding. Sensitive values never appear in any of these except through the explicit, audited
 * {@link Revealed} answer. No request carries a status, an evidence reference or anything the bank decides.
 */
public final class KycDtos {

    private KycDtos() {}

    // ---- requests ------------------------------------------------------------------------------

    /** Starts an application. One per business and provider is live at a time. */
    public record StartRequest(@NotNull UUID clientOperationId) {}

    /** Saves some answers. A null or blank value clears that answer. Unknown field keys are refused. */
    public record SaveAnswersRequest(@NotNull Long expectedVersion, @NotNull Map<String, String> answers) {}

    /** "I have this document ready." This records the owner's statement only: no file is received. */
    public record DocumentRequest(@NotNull Long expectedVersion, boolean declaredReady) {}

    public record ConsentRequest(@NotNull Long expectedVersion, @NotBlank @Size(max = 20) String consentTextVersion, boolean affirmed) {}

    public record SubmitRequest(@NotNull Long expectedVersion, @NotNull UUID submissionRequestId) {}

    public record InformationResponseRequest(@NotBlank @Size(max = 2000) String response) {}

    // ---- responses -----------------------------------------------------------------------------

    /** A sensitive answer is never carried here: only whether it exists and a masked hint. */
    public record AnswerDto(String key, boolean sensitive, String value, boolean hasValue, String hint, String source) {}

    public record DocumentDto(String key, String label, boolean required, boolean applies, String state, Instant declaredReadyAt,
                              boolean uploadAvailable) {}

    public record ConsentDto(UUID id, Instant givenAt, String consentTextVersion, int requirementSetVersion, String consentingName, boolean current) {}

    public record InformationRequestDto(UUID id, String message, String fieldKey, String status, Instant requestedAt, String response, Instant respondedAt) {}

    /** What stands between the draft and a submission to OuPay. Field and document KEYS only. */
    public record Readiness(List<String> missingFields, String consent, List<String> outstandingDocuments, List<String> blockingDocuments,
                            boolean canSubmit) {}

    public record ApplicationSummary(UUID id, KycApplicationStatus status, int requirementSetVersion, Instant createdAt, Instant submittedAt, Instant decidedAt) {}

    public record ApplicationDto(UUID id, String providerId, KycApplicationStatus status, int requirementSetVersion, long version, Instant createdAt,
                                 Instant updatedAt, Instant submittedAt, Instant handedOffAt, Instant decidedAt, String decisionReason,
                                 List<AnswerDto> answers, List<DocumentDto> documents, ConsentDto consent,
                                 List<InformationRequestDto> informationRequests, Readiness readiness) {}

    public record WriteResult(ApplicationDto application, boolean replayed) {}

    public record Revealed(String key, String value) {}

    public record RequirementSetDto(int version, boolean provisional, Instant effectiveFrom, KycRequirements.Definition definition) {}

    public record StorageDto(boolean documentUploadAvailable, boolean sensitiveStorageAvailable, boolean revealAvailable,
                             boolean submissionToEquityAvailable, String note) {}

    public record LinkedAccount(String label, String maskedAccount, String providerId, boolean simulated) {}

    public record Options(String providerId, RequirementSetDto requirementSet, Map<String, String> prefill, StorageDto storage,
                          List<LinkedAccount> linkedAccounts, ApplicationSummary current, boolean retentionConfigured) {}
}
