package rw.oupay.ledger;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.Instant;
import java.util.UUID;

/**
 * Confirmed money applied to one invoice. Allocations are never edited or deleted: a correction
 * reverses one (it stops counting) and the history stays.
 */
@Entity
@Table(name = "payment_allocations")
public class PaymentAllocation {

    public enum Origin { AUTO_REFERENCE, MANUAL }

    public enum ReversalKind { BANK_REVERSAL, MANUAL_CORRECTION }

    @Id
    private UUID id;

    @Column(name = "merchant_id", nullable = false, updatable = false)
    private UUID merchantId;

    @Column(name = "bank_transaction_id", nullable = false, updatable = false)
    private UUID bankTransactionId;

    @Column(name = "invoice_id", nullable = false, updatable = false)
    private UUID invoiceId;

    @Column(name = "amount_rwf", nullable = false, updatable = false)
    private long amountRwf;

    /** ACTIVE or REVERSED. */
    @Column(nullable = false)
    private String status;

    @jakarta.persistence.Enumerated(jakarta.persistence.EnumType.STRING)
    @Column(nullable = false, updatable = false)
    private Origin origin;

    @Column(name = "created_by_user_id", updatable = false)
    private UUID createdByUserId;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "reversed_at")
    private Instant reversedAt;

    @Column(name = "reversed_by_user_id")
    private UUID reversedByUserId;

    @jakarta.persistence.Enumerated(jakarta.persistence.EnumType.STRING)
    @Column(name = "reversal_kind")
    private ReversalKind reversalKind;

    @Column(name = "reversal_reason")
    private String reversalReason;

    protected PaymentAllocation() {}

    public PaymentAllocation(UUID id, UUID merchantId, UUID bankTransactionId, UUID invoiceId, long amountRwf, Origin origin,
                             UUID createdByUserId, Instant now) {
        this.id = id;
        this.merchantId = merchantId;
        this.bankTransactionId = bankTransactionId;
        this.invoiceId = invoiceId;
        this.amountRwf = amountRwf;
        this.status = "ACTIVE";
        this.origin = origin;
        this.createdByUserId = createdByUserId;
        this.createdAt = now;
    }

    public UUID getId() { return id; }
    public UUID getMerchantId() { return merchantId; }
    public UUID getBankTransactionId() { return bankTransactionId; }
    public UUID getInvoiceId() { return invoiceId; }
    public long getAmountRwf() { return amountRwf; }
    public String getStatus() { return status; }
    public Origin getOrigin() { return origin; }
    public UUID getCreatedByUserId() { return createdByUserId; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getReversedAt() { return reversedAt; }
    public UUID getReversedByUserId() { return reversedByUserId; }
    public ReversalKind getReversalKind() { return reversalKind; }
    public String getReversalReason() { return reversalReason; }

    public boolean isActive() {
        return "ACTIVE".equals(status);
    }

    public void reverse(ReversalKind kind, String reason, UUID byUserId, Instant now) {
        this.status = "REVERSED";
        this.reversalKind = kind;
        this.reversalReason = reason;
        this.reversedByUserId = byUserId;
        this.reversedAt = now;
    }
}
