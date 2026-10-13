package rw.oupay.invoice;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import rw.oupay.ledger.LedgerMath;

/** Wire shapes matching the frontend's Invoice, InvoiceDraftInput and InvoiceFormOptions. */
public final class InvoiceDtos {

    private InvoiceDtos() {}

    public record Customer(@NotBlank @Size(max = 200) String name, @Size(max = 254) String email,
                           @Size(max = 20) String phoneNumber, @Size(max = 300) String address, @Size(max = 9) String tin) {}

    public record TaxRate(@NotNull InvoiceCalculator.TaxCategory category, int rateBp) {}

    public record ItemInput(@NotBlank @Size(max = 300) String description, @NotNull BigDecimal quantity,
                            long unitPrice, long discount, @NotNull @Valid TaxRate taxRate) {}

    public record DraftRequest(@NotNull UUID branchId, @NotNull UUID assignedToUserId, @NotNull @Valid Customer customer,
                               @NotEmpty @Valid List<ItemInput> items, @NotNull InvoiceCalculator.TaxMode taxMode,
                               @NotBlank String dueAt, @Size(max = 1000) String notes) {}

    public record VoidRequest(@NotBlank @Size(max = 500) String reason) {}

    public record MerchantSnapshot(String legalName, String tradingName, String tin, String registrationNumber,
                                   String address, String phoneNumber, String email) {}

    public record BranchSnapshot(String name, String code, String address) {}

    public record ItemDto(UUID id, String description, BigDecimal quantity, long unitPrice, long discount, TaxRate taxRate,
                          long netAmount, long taxAmount, long lineTotal) {}

    public record PaymentDto(long invoiceTotal, long allocatedAmount, long remainingBalance, long unappliedAmount,
                             LedgerMath.PaymentStatus paymentStatus) {}

    public record InvoiceDto(UUID id, UUID merchantId, UUID branchId, String invoiceNumber, UUID createdByUserId,
                             UUID assignedToUserId, String createdByName, String assignedToName, Customer customer,
                             MerchantSnapshot merchantSnapshot, BranchSnapshot branchSnapshot, List<ItemDto> items,
                             String currency, InvoiceCalculator.TaxMode taxMode, long subtotal, long discountTotal,
                             long taxTotal, long grandTotal, Instant issuedAt, String dueAt, Instant createdAt,
                             Instant updatedAt, Instant cancelledAt, Instant voidedAt, String voidReason,
                             InvoiceStatus status, LedgerMath.PaymentStatus paymentStatus, PaymentDto payment,
                             String notes, long version) {}

    public record InvoicePage(List<InvoiceDto> items, long totalCount, String nextCursor) {}

    public record BranchOption(UUID id, String name, String code) {}

    public record AssigneeOption(UUID userId, UUID membershipId, String fullName, List<UUID> branchIds) {}

    public record FormOptions(List<BranchOption> branches, List<AssigneeOption> assignees) {}
}
