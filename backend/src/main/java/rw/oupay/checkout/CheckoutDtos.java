package rw.oupay.checkout;

import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import rw.oupay.merchant.OperatingMode;
import rw.oupay.payment.PaymentRequestState;

/**
 * Wire shapes of the simplified checkout. The request carries only what the cashier decides (an amount, a note, a branch) and
 * the client's stable identifier for the sale; everything else (sale channel, tax, expiry, status, bank confirmation) is the
 * server's to decide and cannot be supplied.
 */
public final class CheckoutDtos {

    private CheckoutDtos() {}

    /**
     * @param amountRwf       whole Rwandan francs. Taken as a decimal NUMBER so a fractional value is refused, never truncated.
     * @param clientRequestId the client's stable identifier of this sale, kept for good: the same sale always carries the same id
     */
    public record SimpleCheckoutRequest(@NotNull BigDecimal amountRwf, @Size(max = 120) String description, UUID branchId,
                                        @NotNull UUID clientRequestId) {}

    /** What the checkout needs before billing: whether it can run, where, and what is missing if it cannot. */
    public record SimpleCheckoutOptions(OperatingMode operatingMode, Readiness readiness, List<BranchChoice> branches,
                                        long minAmountRwf, long maxAmountRwf, int paymentLifetimeMinutes,
                                        String defaultDescription) {}

    /** READY, or the first thing that must be set up (the checkout never creates these silently). */
    public enum Readiness { READY, NOT_SIMPLIFIED, NO_BRANCH, NO_PAYMENT_LINK }

    public record BranchChoice(UUID id, String name, String code, boolean paymentReady) {}

    public record SimpleCheckoutResult(UUID invoiceId, String invoiceNumber, UUID paymentRequestId, String publicReference,
                                       long amountRwf, String currency, String description, PaymentRequestState.Status status,
                                       Instant expiresAt, Instant createdAt, String merchantDisplayName, UUID branchId,
                                       String branchName, String profileToken, String paymentPath) {}
}
