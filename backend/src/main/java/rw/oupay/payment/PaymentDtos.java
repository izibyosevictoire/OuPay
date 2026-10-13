package rw.oupay.payment;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import rw.oupay.banking.BankingDtos;
import rw.oupay.banking.ProviderId;

/** Wire shapes matching the frontend's PaymentProfileView, InvoicePaymentRequestView and public views. */
public final class PaymentDtos {

    private PaymentDtos() {}

    // ---- merchant side ----------------------------------------------------------------------

    public record CreateProfileRequest(@NotBlank @Size(min = 2, max = 60) String label, @NotNull UUID paymentDestinationId,
                                       UUID branchId, UUID assignedCashierId) {}

    public record ActiveRequest(boolean isActive) {}

    public record ProfileDto(UUID id, UUID merchantId, String paymentProfileId, String merchantDisplayName, String label,
                             UUID branchId, UUID assignedCashierId, UUID paymentDestinationId, PaymentProfile.Status status,
                             UUID replacedByProfileId, Instant createdAt, Instant updatedAt, String branchName, String cashierName,
                             String destinationLabel, String destinationMasked, boolean isSimulated) {}

    public record RequestDto(UUID id, UUID merchantId, UUID paymentProfileId, UUID invoiceId, long requestedAmount, String currency,
                             String publicReference, PaymentRequestState.Status status, Instant expiresAt, Instant createdAt,
                             Instant updatedAt, Instant cancelledAt, Instant instructionsOpenedAt, Instant customerClaimedPaymentAt,
                             String profileToken) {}

    public record CashierOption(UUID userId, String fullName, List<UUID> branchIds) {}

    public record BranchOption(UUID id, String name) {}

    public record FormOptions(List<BankingDtos.DestinationDto> destinations, List<BranchOption> branches, List<CashierOption> cashiers) {}

    // ---- public side: deliberately minimal ---------------------------------------------------

    public record OpenRequestBody(long amount) {}

    public record PublicMethod(String id, String label, boolean isUsable, String unavailableReason, boolean isSimulated,
                               List<String> instructions) {}

    public record PublicProfile(String merchantDisplayName, String branchName, String cashierDisplayName, boolean isMerchantVerified,
                                String status, List<PublicMethod> paymentMethods) {}

    public record PublicRequest(PublicProfile profile, String invoiceReference, long requestedAmount, long amountDue, String currency,
                                long confirmedAmount, String publicReference, boolean isAmountFixed, PaymentRequestState.Stage stage,
                                Instant expiresAt, boolean instructionsOpened, boolean customerClaimedPayment, boolean isSimulated) {}

    /** Which provider backs a payment method. */
    public record MethodDefinition(String id, String label, ProviderId providerId) {}
}
