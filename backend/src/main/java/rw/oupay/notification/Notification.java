package rw.oupay.notification;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "notifications")
public class Notification {

    @Id
    private UUID id;

    @Column(name = "merchant_id", nullable = false, updatable = false)
    private UUID merchantId;

    @Column(name = "recipient_user_id", nullable = false, updatable = false)
    private UUID recipientUserId;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, updatable = false)
    private NotificationKind kind;

    @Column(nullable = false, updatable = false)
    private String title;

    @Column(nullable = false, updatable = false)
    private String body;

    @Column(name = "related_bank_transaction_id", updatable = false)
    private UUID relatedBankTransactionId;

    @Column(name = "related_invoice_id", updatable = false)
    private UUID relatedInvoiceId;

    @Column(name = "dedupe_key", nullable = false, updatable = false)
    private String dedupeKey;

    @Column(name = "is_simulated", nullable = false, updatable = false)
    private boolean simulated;

    @Column(name = "read_at")
    private Instant readAt;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    protected Notification() {}

    public UUID getId() { return id; }
    public UUID getMerchantId() { return merchantId; }
    public UUID getRecipientUserId() { return recipientUserId; }
    public NotificationKind getKind() { return kind; }
    public String getTitle() { return title; }
    public String getBody() { return body; }
    public UUID getRelatedBankTransactionId() { return relatedBankTransactionId; }
    public UUID getRelatedInvoiceId() { return relatedInvoiceId; }
    public String getDedupeKey() { return dedupeKey; }
    public boolean isSimulated() { return simulated; }
    public Instant getReadAt() { return readAt; }
    public Instant getCreatedAt() { return createdAt; }

    public void markRead(Instant now) {
        if (readAt == null) {
            this.readAt = now;
        }
    }
}
