package rw.oupay.payment;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
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

    /** Where the request came from. Empty on requests created before provenance existed: read it through {@link #getSource()}. */
    @Enumerated(EnumType.STRING)
    @Column(updatable = false)
    private PaymentRequestSource source;

    /** The branch the collection belongs to; for an invoice request, the invoice's own branch. Fixed at creation. */
    @Column(name = "branch_id", updatable = false)
    private UUID branchId;

    /** The member who created the request. Empty for anonymous open requests. Fixed at creation. */
    @Column(name = "created_by_user_id", updatable = false)
    private UUID createdByUserId;

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

    /**
     * A request with recorded provenance. Set only by trusted server code, from the invoice and the signed-in member. The
     * combinations are validated here and again, as constraints, by the database: a request for an invoice names a source other
     * than OPEN, its branch and its creator; an OPEN request has no invoice and no creator.
     */
    public PaymentRequest(UUID id, UUID merchantId, UUID paymentProfileId, UUID invoiceId, long requestedAmountRwf,
                          String publicReference, Instant expiresAt, Instant now,
                          PaymentRequestSource source, UUID branchId, UUID createdByUserId) {
        this(id, merchantId, paymentProfileId, invoiceId, requestedAmountRwf, publicReference, expiresAt, now);
        if (source == null) {
            throw new IllegalArgumentException("A request with recorded provenance needs a source.");
        }
        if ((source == PaymentRequestSource.OPEN) != (invoiceId == null)) {
            throw new IllegalArgumentException("A request is OPEN exactly when it has no invoice.");
        }
        if (source == PaymentRequestSource.OPEN ? createdByUserId != null : (branchId == null || createdByUserId == null)) {
            throw new IllegalArgumentException("An invoice request names its branch and creator; an open request has no creator.");
        }
        this.source = source;
        this.branchId = branchId;
        this.createdByUserId = createdByUserId;
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
    public UUID getBranchId() { return branchId; }
    public UUID getCreatedByUserId() { return createdByUserId; }

    /**
     * Where the request came from. A request with no stored value predates provenance: with no invoice it is an OPEN
     * collection, otherwise an INVOICE request (every older invoice is a traditional one).
     */
    public PaymentRequestSource getSource() {
        if (source != null) {
            return source;
        }
        return invoiceId == null ? PaymentRequestSource.OPEN : PaymentRequestSource.INVOICE;
    }

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
