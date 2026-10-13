package rw.oupay.branch;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.Instant;
import java.util.UUID;

/**
 * Connects one membership to one branch of the same business. Assignments are history, not state:
 * removing someone ends the assignment instead of deleting it.
 */
@Entity
@Table(name = "branch_assignments")
public class BranchAssignment {

    @Id
    private UUID id;

    @Column(name = "merchant_id", nullable = false, updatable = false)
    private UUID merchantId;

    @Column(name = "membership_id", nullable = false, updatable = false)
    private UUID membershipId;

    @Column(name = "branch_id", nullable = false, updatable = false)
    private UUID branchId;

    /** ACTIVE or ENDED. */
    @Column(nullable = false)
    private String status;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    @Column(name = "ended_at")
    private Instant endedAt;

    protected BranchAssignment() {}

    public BranchAssignment(UUID id, UUID merchantId, UUID membershipId, UUID branchId, Instant now) {
        this.id = id;
        this.merchantId = merchantId;
        this.membershipId = membershipId;
        this.branchId = branchId;
        this.status = "ACTIVE";
        this.createdAt = now;
        this.updatedAt = now;
    }

    public UUID getId() { return id; }
    public UUID getMerchantId() { return merchantId; }
    public UUID getMembershipId() { return membershipId; }
    public UUID getBranchId() { return branchId; }
    public String getStatus() { return status; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }
    public Instant getEndedAt() { return endedAt; }

    public boolean isActive() {
        return "ACTIVE".equals(status);
    }

    public void end(Instant now) {
        this.status = "ENDED";
        this.endedAt = now;
        this.updatedAt = now;
    }
}
