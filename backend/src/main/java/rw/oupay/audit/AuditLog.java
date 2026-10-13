package rw.oupay.audit;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.Instant;
import java.util.UUID;

/** One append-only audit entry. The database refuses updates and deletes. */
@Entity
@Table(name = "audit_log")
public class AuditLog {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "merchant_id", updatable = false)
    private UUID merchantId;

    @Column(name = "actor_user_id", updatable = false)
    private UUID actorUserId;

    @Column(nullable = false, updatable = false)
    private String kind;

    @Column(name = "entity_type", updatable = false)
    private String entityType;

    @Column(name = "entity_id", updatable = false)
    private UUID entityId;

    @Column(name = "bank_transaction_id", updatable = false)
    private UUID bankTransactionId;

    @Column(name = "invoice_id", updatable = false)
    private UUID invoiceId;

    @Column(nullable = false, updatable = false)
    private String message;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    protected AuditLog() {}

    public AuditLog(UUID merchantId, UUID actorUserId, String kind, String entityType, UUID entityId,
                    UUID bankTransactionId, UUID invoiceId, String message, Instant createdAt) {
        this.merchantId = merchantId;
        this.actorUserId = actorUserId;
        this.kind = kind;
        this.entityType = entityType;
        this.entityId = entityId;
        this.bankTransactionId = bankTransactionId;
        this.invoiceId = invoiceId;
        this.message = message.length() > 500 ? message.substring(0, 500) : message;
        this.createdAt = createdAt;
    }

    public Long getId() { return id; }
    public UUID getMerchantId() { return merchantId; }
    public UUID getActorUserId() { return actorUserId; }
    public String getKind() { return kind; }
    public UUID getBankTransactionId() { return bankTransactionId; }
    public UUID getInvoiceId() { return invoiceId; }
    public String getMessage() { return message; }
    public Instant getCreatedAt() { return createdAt; }
}
