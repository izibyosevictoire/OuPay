package rw.oupay.checkout;

import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import rw.oupay.payment.PaymentRequestState;

/**
 * Wire shapes of the agent's code checkout. The request carries only what the agent decides (an amount, a note, which of THEIR codes, and a
 * branch if the code has none) and the client's stable sale identifier. It can never carry a bank code, a payment status, a confirmation,
 * an assignment or an agent: those are decided by the server from its own records.
 */
public final class CodeCheckoutDtos {

    private CodeCheckoutDtos() {}

    /** @param amountRwf a decimal NUMBER so a fractional value is refused, never truncated */
    public record CodeSaleRequest(@NotNull BigDecimal amountRwf, @Size(max = 120) String description, UUID collectionCodeId, UUID branchId,
                                  @NotNull UUID clientRequestId) {}

    public enum Readiness { READY, NO_ASSIGNED_CODE, CODE_NOT_AVAILABLE, NO_PAYMENT_LINK }

    /** One of the CALLER's own codes. {@code mode} is DEMONSTRATION, LIVE or UNAVAILABLE (with the reason). */
    public record CodeChoice(UUID id, String label, String mode, String reason, boolean paymentReady, String branchName) {}

    public record Options(Readiness readiness, List<CodeChoice> codes, long minAmountRwf, long maxAmountRwf, int paymentLifetimeMinutes,
                          boolean liveCollectionEnabled, String note) {}

    /**
     * What the customer is shown to pay with. {@code bankCode} is the bank-issued code and exists ONLY for a LIVE sale; a demonstration shows
     * OuPay's internal reference as {@code demoReference}, which is never a payment code.
     */
    public record CodePresentation(String mode, String label, String bankCode, String demoReference, String notice) {}

    public record CodeSaleDto(UUID saleId, UUID invoiceId, String invoiceNumber, String saleReference, long amountRwf, String currency,
                              String description, PaymentRequestState.Status status, PaymentRequestState.Stage stage, long confirmedAmount,
                              long amountDue, Instant expiresAt, Instant createdAt, String merchantDisplayName, String branchName,
                              String agentName, CodePresentation code) {}

    public record Billed(CodeSaleDto sale, boolean created) {}

    public enum CustomerStatus { AWAITING_PAYMENT, PARTIALLY_PAID, PAID, EXPIRED, CANCELLED, REQUIRES_RECONCILIATION }

    /** The customer's page: no agent, no staff, no account, no internal ids. */
    public record PublicCodeSale(String merchantDisplayName, String saleReference, long amountRwf, String currency, String description,
                                 CustomerStatus status, long confirmedAmount, long amountDue, Instant expiresAt, CodePresentation code,
                                 List<String> instructions, String statusNote) {}
}
