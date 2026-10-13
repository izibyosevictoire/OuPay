package rw.oupay.payment;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import jakarta.persistence.Version;
import java.time.Instant;
import java.util.UUID;

/**
 * A merchant's public payment identity: what a QR code or NFC tag points at. The public token is
 * opaque and unpredictable but is NOT a secret or credential: anyone holding the URL can open the
 * page, so the page may reveal nothing private. Hardware UIDs are never trusted.
 */
@Entity
@Table(name = "payment_profiles")
public class PaymentProfile {

    public enum Status { ACTIVE, INACTIVE, REVOKED }

    @Id
    private UUID id;

    @Column(name = "merchant_id", nullable = false, updatable = false)
    private UUID merchantId;

    @Column(name = "public_token", nullable = false, updatable = false)
    private String publicToken;

    @Column(nullable = false)
    private String label;

    @Column(name = "branch_id", updatable = false)
    private UUID branchId;

    @Column(name = "assigned_cashier_user_id", updatable = false)
    private UUID assignedCashierUserId;

    @Column(name = "payment_destination_id", nullable = false, updatable = false)
    private UUID paymentDestinationId;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    private Status status;

    @Column(name = "replaced_by_profile_id")
    private UUID replacedByProfileId;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    @Version
    private long version;

    protected PaymentProfile() {}

    public PaymentProfile(UUID id, UUID merchantId, String publicToken, String label, UUID branchId, UUID assignedCashierUserId,
                          UUID paymentDestinationId, Instant now) {
        this.id = id;
        this.merchantId = merchantId;
        this.publicToken = publicToken;
        this.label = label;
        this.branchId = branchId;
        this.assignedCashierUserId = assignedCashierUserId;
        this.paymentDestinationId = paymentDestinationId;
        this.status = Status.ACTIVE;
        this.createdAt = now;
        this.updatedAt = now;
    }

    public UUID getId() { return id; }
    public UUID getMerchantId() { return merchantId; }
    public String getPublicToken() { return publicToken; }
    public String getLabel() { return label; }
    public UUID getBranchId() { return branchId; }
    public UUID getAssignedCashierUserId() { return assignedCashierUserId; }
    public UUID getPaymentDestinationId() { return paymentDestinationId; }
    public Status getStatus() { return status; }
    public UUID getReplacedByProfileId() { return replacedByProfileId; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }

    public void changeStatus(Status status, Instant now) {
        this.status = status;
        this.updatedAt = now;
    }

    public void revoke(UUID replacedBy, Instant now) {
        this.status = Status.REVOKED;
        this.replacedByProfileId = replacedBy;
        this.updatedAt = now;
    }
}
