package rw.oupay.collection;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import rw.oupay.membership.MembershipStatus;

/**
 * Wire shapes of the collection-code registry. The merchant comes only from the URL. NOTHING here lets a caller approve a code or
 * supply a bank-issued code: those fields only ever appear in responses, and only once bank evidence is recorded server-side.
 */
public final class CollectionCodeDtos {

    private CollectionCodeDtos() {}

    /** Asks OuPay to register a code request. Nothing is sent to the bank. */
    public record RequestCodeRequest(
            @NotNull UUID clientOperationId,
            @NotNull UUID settlementDestinationId,
            @NotBlank @Size(max = 60) String displayLabel,
            UUID branchId) {}

    /** Exactly one of {@code membershipId} and {@code collectionPointLabel}. */
    public record AssignRequest(UUID membershipId, @Size(max = 60) String collectionPointLabel, UUID branchId) {}

    public record EndRequest(@NotNull UUID expectedAssignmentId, @NotBlank @Size(max = 160) String reason) {}

    public record ReassignRequest(@NotNull UUID expectedAssignmentId, UUID membershipId, @Size(max = 60) String collectionPointLabel,
                                  UUID branchId, @NotBlank @Size(max = 160) String reason) {}

    /** The owner records that a request WAS made to the bank, and the reference they were given. Unverified; not an approval. */
    public record SubmissionRequest(@NotNull Long expectedVersion, @NotBlank @Size(max = 200) String bankRequestRef) {}

    public record StatusChangeRequest(@NotNull Long expectedVersion, @NotBlank @Size(max = 300) String reason) {}

    public record Approval(ApprovalSource source, String evidenceRef, Instant approvedAt) {}

    public record AssignmentDto(UUID id, UUID codeId, AssigneeKind assigneeKind, UUID membershipId, UUID assigneeUserId, String assigneeName,
                                String assigneeRole, String collectionPointLabel, UUID branchId, String branchName, String branchCode,
                                Instant validFrom, Instant validTo, String assignedByName, String endedByName, String endReason,
                                MembershipStatus assigneeCurrentStatus) {}

    /**
     * Four different facts, never to be confused:
     * <ul>
     *   <li>{@code status} {@code ACTIVE} + {@code externalCodeState} {@code BANK_APPROVED}: the bank provisioned the code (evidence recorded);</li>
     *   <li>{@code currentAssignment}: the code is assigned to a person or collection point;</li>
     *   <li>{@code payable}: the code is ELIGIBLE FOR COLLECTION RIGHT NOW (provisioned, real, assigned to someone currently allowed, at an active
     *       branch, on a connected settlement account); {@code eligibilityIssues} lists what is missing when it is not;</li>
     *   <li>{@code simulated}: a simulated code is NEVER payable, whatever else is true.</li>
     * </ul>
     * {@code externalCode} appears only for a bank-approved code; evidence and the bank-request reference only for those who manage codes.
     * {@code internalRef} is OuPay's own identifier and is never a payment code.
     */
    public record CodeDto(UUID id, String internalRef, String displayLabel, String providerId, UUID settlementDestinationId,
                          String settlementAccountLabel, String settlementAccountMasked, boolean simulated, UUID branchId, String branchName,
                          String branchCode, CollectionCodeStatus status, String statusReason, String bankRequestRef,
                          String externalCodeState, String externalCode, Approval approval, boolean bankProvisioned, boolean payable,
                          List<String> eligibilityIssues, AssignmentDto currentAssignment, Instant createdAt, Instant updatedAt, long version) {}

    public record WriteResult(CodeDto code, boolean replayed) {}

    public record DestinationOption(UUID id, String label, String maskedAccount, String providerId, boolean simulated, String connectionStatus) {}

    public record BranchOption(UUID id, String name, String code, String status) {}

    public record MemberOption(UUID membershipId, UUID userId, String fullName, String role, List<UUID> branchIds) {}

    public record Options(List<DestinationOption> destinations, List<BranchOption> branches, List<MemberOption> members) {}

    /** What an agent sees of their own code. The bank-issued code appears only when it is payable. */
    public record MyCode(UUID id, String displayLabel, CollectionCodeStatus status, boolean simulated, String branchName, boolean payable,
                         String externalCode, String message) {}

    public record MyCollectionCode(AssignmentDto assignment, MyCode code) {}
}
