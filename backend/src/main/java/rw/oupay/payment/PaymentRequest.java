package rw.oupay.payment;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.Instant;
import java.util.UUID;

/**
 * A request to collect money. Separate from the invoice (a commercial document) and from the bank
 * transaction (what the bank confirms). Its status is DERIVED from linked transactions on every
 * read, never stored, so it can never disagree with the ledger.
 */
@Entity
@Table(name = "payment_requests")
public class PaymentRequest {

    @Id
    private UUID id;

    @Column(name = "merchant_id", nullable = false, updatable = false)
    private UUID merchantId;

    @Column(name = "payment_profile_id", nullable = false, updatable = false)
    private UUID paymentProfileId;

    @Column(name = "invoice_id", updatable = false)
    private UUID invoiceId;

    @Column(name = "requested_amount_rwf", nullable = false, updatable = false)
    private long requestedAmountRwf;

    @Column(nullable = false, updatable = false)
    private String currency = "RWF";

    @Column(name = "public_reference", nullable = false, updatable = false)
    private String publicReference;

    @Column(name = "expires_at", nullable = false, updatable = false)
    private Instant expiresAt;

    @Column(name = "cancelled_at")
    private Instant cancelledAt;

    @Column(name = "instructions_opened_at")
    private Instant instructionsOpenedAt;

    @Column(name = "customer_claimed_at")
    private Instant customerClaimedAt;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    protected PaymentRequest() {}

    public PaymentRequest(UUID id, UUID merchantId, UUID paymentProfileId, UUID invoiceId, long requestedAmountRwf,
                          String publicReference, Instant expiresAt, Instant now) {
        this.id = id;
        this.merchantId = merchantId;
        this.paymentProfileId = paymentProfileId;
        this.invoiceId = invoiceId;
        this.requestedAmountRwf = requestedAmountRwf;
        this.publicReference = publicReference;
        this.expiresAt = expiresAt;
        this.createdAt = now;
        this.updatedAt = now;
    }

    public UUID getId() { return id; }
    public UUID getMerchantId() { return merchantId; }
    public UUID getPaymentProfileId() { return paymentProfileId; }
    public UUID getInvoiceId() { return invoiceId; }
    public long getRequestedAmountRwf() { return requestedAmountRwf; }
    public String getPublicReference() { return publicReference; }
    public Instant getExpiresAt() { return expiresAt; }
    public Instant getCancelledAt() { return cancelledAt; }
    public Instant getInstructionsOpenedAt() { return instructionsOpenedAt; }
    public Instant getCustomerClaimedAt() { return customerClaimedAt; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }

    public void cancel(Instant now) {
        if (cancelledAt == null) {
            this.cancelledAt = now;
            this.updatedAt = now;
        }
    }

    public void markInstructionsOpened(Instant now) {
        if (instructionsOpenedAt == null) {
            this.instructionsOpenedAt = now;
            this.updatedAt = now;
        }
    }

    /** The customer SAYS they started a payment. A claim only, never confirmation. */
    public void markCustomerClaimed(Instant now) {
        if (customerClaimedAt == null) {
            this.customerClaimedAt = now;
            this.updatedAt = now;
        }
    }
}
