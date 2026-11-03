package rw.oupay.entry;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import rw.oupay.checkout.CodeCheckoutDtos;

/** Wire shapes of the payment-entry devices. A device carries a stable doorway and nothing else: no bank detail, no amount, no secret. */
public final class EntryDtos {

    private EntryDtos() {}

    // ---- merchant side -------------------------------------------------------------------------

    /** The prepared bill a device currently leads to, with what the counter needs to know about the customer session. */
    public record BindingDto(UUID id, UUID saleId, String saleReference, long amountRwf, String description, String presentationMode, String agentName,
                             Instant boundAt, Instant saleExpiresAt, String saleStatus, boolean customerSessionActive, Instant sessionExpiresAt) {}

    /** {@code entryPath} is the permanent path ({@code /e/{token}}); the browser prefixes the customer-facing domain, which is configuration. */
    public record DeviceDto(UUID id, String deviceType, String displayName, String entryPath, UUID branchId, String branchName,
                            UUID assignedCashierUserId, String assignedCashierName, String status, String statusReason,
                            Instant createdAt, Instant updatedAt, long version, BindingDto binding) {}

    public record CashierOption(UUID userId, String fullName, String role, List<UUID> branchIds) {}

    public record BranchOption(UUID id, String name, String code) {}

    public record Options(List<BranchOption> branches, List<CashierOption> cashiers) {}

    public record AssignmentDto(UUID id, UUID branchId, String branchName, UUID assignedCashierUserId, String assignedCashierName,
                                Instant validFrom, Instant validTo, String assignedBy, String reason) {}

    public record BindingHistoryDto(UUID id, String saleReference, long amountRwf, String agentName, String boundBy, Instant boundAt,
                                    Instant endedAt, String endReason) {}

    public record EligibleSaleDto(UUID saleId, String saleReference, long amountRwf, String description, String presentationMode, String agentName,
                                  Instant expiresAt, Instant createdAt, String status) {}

    public record WriteResult(DeviceDto device, boolean replayed) {}

    public record CreateRequest(@NotNull UUID clientRequestId, @NotBlank String deviceType, @NotBlank @Size(max = 60) String displayName,
                                @NotNull UUID branchId, UUID assignedCashierUserId) {}

    public record AssignRequest(long expectedVersion, @NotNull UUID branchId, UUID assignedCashierUserId, @Size(max = 200) String reason,
                                Boolean confirmActiveSession) {}

    public record StatusRequest(long expectedVersion, @NotBlank @Size(max = 200) String reason) {}

    public record BindRequest(@NotNull UUID saleId, long expectedVersion) {}

    public record UnbindRequest(@NotBlank @Size(max = 200) String reason, Boolean confirmActiveSession) {}

    // ---- customer side -------------------------------------------------------------------------

    /**
     * What the customer's page may know. UNAVAILABLE is one answer for an unknown, malformed, suspended or revoked token, so nothing can be
     * learned by trying tokens. READY and BUSY carry no amount, reference or code: the bill is shown only to the customer who claimed it.
     */
    public enum EntryState { UNAVAILABLE, IDLE, READY, BUSY, CLAIMED, SESSION_ENDED }

    /** {@code claimToken} is present only in the answer that CREATES the claim: it is the customer's bearer secret and is never stored in clear. */
    public record Claim(boolean active, Instant expiresAt, String endReason, String claimToken) {}

    public record PublicEntry(EntryState state, String message, String merchantDisplayName, CodeCheckoutDtos.PublicCodeSale sale, Claim claim) {}
}
