package rw.oupay.membership;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import jakarta.persistence.Version;
import java.time.Instant;
import java.util.UUID;

/** Links one user to one business with one role. A user may have many memberships. */
@Entity
@Table(name = "memberships")
public class Membership {

    @Id
    private UUID id;

    @Column(name = "user_id", nullable = false)
    private UUID userId;

    @Column(name = "merchant_id", nullable = false)
    private UUID merchantId;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    private Role role;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    private MembershipStatus status;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    @Version
    private long version;

    protected Membership() {}

    public Membership(UUID id, UUID userId, UUID merchantId, Role role, MembershipStatus status, Instant now) {
        this.id = id;
        this.userId = userId;
        this.merchantId = merchantId;
        this.role = role;
        this.status = status;
        this.createdAt = now;
        this.updatedAt = now;
    }

    public UUID getId() { return id; }
    public UUID getUserId() { return userId; }
    public UUID getMerchantId() { return merchantId; }
    public Role getRole() { return role; }
    public MembershipStatus getStatus() { return status; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }

    public void change(Role newRole, MembershipStatus newStatus, Instant now) {
        this.role = newRole;
        this.status = newStatus;
        this.updatedAt = now;
    }

    public boolean isActive() {
        return status == MembershipStatus.ACTIVE;
    }
}
