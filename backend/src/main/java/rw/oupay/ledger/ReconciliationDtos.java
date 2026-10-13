package rw.oupay.ledger;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import rw.oupay.banking.ProviderId;

/** Wire shapes matching the frontend's BankTransactionView, AllocationView, BankTransactionDetails and AuditEntry. */
public final class ReconciliationDtos {

    private ReconciliationDtos() {}

    public record InvoiceLink(UUID invoiceId, String invoiceNumber, long amount, String allocationStatus) {}

    public record BankTransactionView(
            UUID id, UUID merchantId, String bankAccountId, ProviderId provider, String providerTransactionId, String providerEventId,
            String direction, long amount, String currency, String paymentReference, String payerDisplayName,
            Instant providerOccurredAt, Instant receivedAt, BankTransactionStatus status, Instant createdAt, Instant updatedAt,
            boolean isSimulated, Instant statusAppliedAt, UUID paymentRequestId, ReviewState reviewState, String reviewReason,
            String reviewNote, long version, long allocatedAmount, long unappliedAmount,
            LedgerMath.ReconciliationStatus reconciliationStatus, List<InvoiceLink> invoices, List<String> verifiedCashierNames) {}

    public record AllocationView(
            UUID id, UUID merchantId, UUID bankTransactionId, UUID invoiceId, long amount, String allocationStatus,
            PaymentAllocation.Origin origin, UUID createdByUserId, Instant createdAt, Instant reversedAt, UUID reversedByUserId,
            PaymentAllocation.ReversalKind reversalKind, String reversalReason, String invoiceNumber, String customerName,
            String transactionReference, long transactionAmount, boolean isSimulated) {}

    public record AuditEntry(Long id, UUID merchantId, UUID bankTransactionId, UUID invoiceId, String kind, UUID actorUserId,
                             String message, Instant createdAt) {}

    public record Details(BankTransactionView transaction, List<AllocationView> allocations, List<AuditEntry> auditHistory) {}

    public record PayableInvoice(UUID invoiceId, String invoiceNumber, String customerName, long grandTotal, long remainingBalance) {}

    public record AllocationLine(@NotNull UUID invoiceId, long amount, long expectedRemainingBalance) {}

    public record ManualAllocationRequest(@NotNull UUID bankTransactionId, long expectedTransactionVersion,
                                          @NotEmpty @Valid List<AllocationLine> allocations, @Size(max = 300) String note) {}

    public record ReverseRequest(@NotBlank @Size(min = 3, max = 300) String reason) {}

    public record ReviewRequest(@NotBlank @Size(min = 3, max = 300) String note, long expectedTransactionVersion) {}
}
