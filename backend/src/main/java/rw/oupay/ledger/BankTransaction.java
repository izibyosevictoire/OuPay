package rw.oupay.ledger;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import jakarta.persistence.Version;
import java.time.Instant;
import java.util.UUID;
import rw.oupay.banking.ProviderId;

/**
 * What the BANK reported about one payment. Created and advanced only by the trusted event
 * processor. The amount, provider ids and direction never change; only the status moves, along
 * the legal transitions, in provider time order.
 */
@Entity
@Table(name = "bank_transactions")
public class BankTransaction {

    @Id
    private UUID id;

    @Column(name = "merchant_id", nullable = false, updatable = false)
    private UUID merchantId;

    @Column(name = "bank_connection_id", nullable = false, updatable = false)
    private UUID bankConnectionId;

    @Enumerated(EnumType.STRING)
    @Column(name = "provider_id", nullable = false, updatable = false)
    private ProviderId providerId;

    @Column(name = "provider_transaction_id", nullable = false, updatable = false)
    private String providerTransactionId;

    @Column(name = "last_provider_event_id", nullable = false)
    private String lastProviderEventId;

    @Column(nullable = false, updatable = false)
    private String direction;

    @Column(name = "amount_rwf", nullable = false, updatable = false)
    private long amountRwf;

    @Column(nullable = false, updatable = false)
    private String currency = "RWF";

    @Column(name = "payment_reference")
    private String paymentReference;

    @Column(name = "payer_display_name", nullable = false, updatable = false)
    private String payerDisplayName;

    @Column(name = "provider_occurred_at", nullable = false, updatable = false)
    private Instant providerOccurredAt;

    @Column(name = "status_applied_at", nullable = false)
    private Instant statusAppliedAt;

    @Column(name = "received_at", nullable = false, updatable = false)
    private Instant receivedAt;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    private BankTransactionStatus status;

    @Column(name = "is_simulated", nullable = false, updatable = false)
    private boolean simulated;

    @Column(name = "payment_request_id")
    private UUID paymentRequestId;

    @Enumerated(EnumType.STRING)
    @Column(name = "review_state", nullable = false)
    private ReviewState reviewState = ReviewState.NONE;

    @Column(name = "review_reason")
    private String reviewReason;

    @Column(name = "review_note")
    private String reviewNote;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    @Version
    private long version;

    protected BankTransaction() {}

    public UUID getId() { return id; }
    public UUID getMerchantId() { return merchantId; }
    public UUID getBankConnectionId() { return bankConnectionId; }
    public ProviderId getProviderId() { return providerId; }
    public String getProviderTransactionId() { return providerTransactionId; }
    public String getLastProviderEventId() { return lastProviderEventId; }
    public String getDirection() { return direction; }
    public long getAmountRwf() { return amountRwf; }
    public String getPaymentReference() { return paymentReference; }
    public String getPayerDisplayName() { return payerDisplayName; }
    public Instant getProviderOccurredAt() { return providerOccurredAt; }
    public Instant getStatusAppliedAt() { return statusAppliedAt; }
    public Instant getReceivedAt() { return receivedAt; }
    public BankTransactionStatus getStatus() { return status; }
    public boolean isSimulated() { return simulated; }
    public UUID getPaymentRequestId() { return paymentRequestId; }
    public ReviewState getReviewState() { return reviewState; }
    public String getReviewReason() { return reviewReason; }
    public String getReviewNote() { return reviewNote; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }
    public long getVersion() { return version; }

    public boolean isIncoming() {
        return "INCOMING".equals(direction);
    }

    public void applyStatus(BankTransactionStatus newStatus, String eventId, Instant appliedAt, String referenceIfMissing, Instant now) {
        this.status = newStatus;
        this.lastProviderEventId = eventId;
        this.statusAppliedAt = appliedAt;
        if (this.paymentReference == null) {
            // A reference that arrives later is accepted only if none was recorded yet.
            this.paymentReference = referenceIfMissing;
        }
        this.updatedAt = now;
    }

    public void linkRequest(UUID requestId, Instant now) {
        this.paymentRequestId = requestId;
        this.updatedAt = now;
    }

    public void flagForReview(String reason, Instant now) {
        this.reviewState = ReviewState.NEEDS_REVIEW;
        this.reviewReason = reason;
        this.updatedAt = now;
    }

    public void markReviewed(String note, Instant now) {
        this.reviewState = ReviewState.REVIEWED;
        this.reviewNote = note;
        this.updatedAt = now;
    }

    /** Bumps the version (via a changed timestamp) so concurrent manual work notices the change. */
    public void touch(Instant now) {
        this.updatedAt = now;
    }
}
