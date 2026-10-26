package rw.oupay.collection;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.UUID;

/**
 * One period during which a collection code was held by a member or a collection point. It is HISTORY: every column is a snapshot
 * taken when the assignment was made, and the only change that is ever allowed is ending it, once (a database trigger agrees). Staff,
 * role or branch changes afterwards never rewrite it, and it is never deleted.
 */
@Entity
@Table(name = "collection_code_assignments")
public class CollectionCodeAssignment {

    @Id
    private UUID id;

    @Column(name = "code_id", nullable = false, updatable = false)
    private UUID codeId;

    @Column(name = "merchant_id", nullable = false, updatable = false)
    private UUID merchantId;

    @Enumerated(EnumType.STRING)
    @Column(name = "assignee_kind", nullable = false, updatable = false)
    private AssigneeKind assigneeKind;

    @Column(name = "membership_id", updatable = false)
    private UUID membershipId;

    @Column(name = "assignee_user_id", updatable = false)
    private UUID assigneeUserId;

    @Column(name = "collection_point_label", updatable = false)
    private String collectionPointLabel;

    @Column(name = "assignee_name", nullable = false, updatable = false)
    private String assigneeName;

    @Column(name = "assignee_role", updatable = false)
    private String assigneeRole;

    @Column(name = "branch_id", updatable = false)
    private UUID branchId;

    @Column(name = "branch_name", updatable = false)
    private String branchName;

    @Column(name = "branch_code", updatable = false)
    private String branchCode;

    @Column(name = "valid_from", nullable = false, updatable = false)
    private Instant validFrom;

    @Column(name = "valid_to")
    private Instant validTo;

    @Column(name = "assigned_by_user_id", nullable = false, updatable = false)
    private UUID assignedByUserId;

    @Column(name = "assigned_by_name", nullable = false, updatable = false)
    private String assignedByName;

    @Column(name = "ended_by_user_id")
    private UUID endedByUserId;

    @Column(name = "ended_by_name")
    private String endedByName;

    @Column(name = "end_reason")
    private String endReason;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    protected CollectionCodeAssignment() {}

    /** What an assignment is made of, resolved and snapshotted by the service. */
    public record Subject(AssigneeKind kind, UUID membershipId, UUID userId, String collectionPointLabel, String name, String role,
                          UUID branchId, String branchName, String branchCode) {}

    public CollectionCodeAssignment(UUID codeId, UUID merchantId, Subject subject, UUID assignedByUserId, String assignedByName, Instant now) {
        this.id = UUID.randomUUID();
        this.codeId = codeId;
        this.merchantId = merchantId;
        this.assigneeKind = subject.kind();
        this.membershipId = subject.membershipId();
        this.assigneeUserId = subject.userId();
        this.collectionPointLabel = subject.collectionPointLabel();
        this.assigneeName = subject.name();
        this.assigneeRole = subject.role();
        this.branchId = subject.branchId();
        this.branchName = subject.branchName();
        this.branchCode = subject.branchCode();
        this.validFrom = now.truncatedTo(ChronoUnit.MICROS);
        this.assignedByUserId = assignedByUserId;
        this.assignedByName = assignedByName;
        this.createdAt = this.validFrom;
    }

    public UUID getId() { return id; }
    public UUID getCodeId() { return codeId; }
    public UUID getMerchantId() { return merchantId; }
    public AssigneeKind getAssigneeKind() { return assigneeKind; }
    public UUID getMembershipId() { return membershipId; }
    public UUID getAssigneeUserId() { return assigneeUserId; }
    public String getCollectionPointLabel() { return collectionPointLabel; }
    public String getAssigneeName() { return assigneeName; }
    public String getAssigneeRole() { return assigneeRole; }
    public UUID getBranchId() { return branchId; }
    public String getBranchName() { return branchName; }
    public String getBranchCode() { return branchCode; }
    public Instant getValidFrom() { return validFrom; }
    public Instant getValidTo() { return validTo; }
    public UUID getAssignedByUserId() { return assignedByUserId; }
    public String getAssignedByName() { return assignedByName; }
    public UUID getEndedByUserId() { return endedByUserId; }
    public String getEndedByName() { return endedByName; }
    public String getEndReason() { return endReason; }
    public Instant getCreatedAt() { return createdAt; }

    public boolean isOpen() {
        return validTo == null;
    }

    /** The only change an assignment ever undergoes. */
    public void end(UUID byUserId, String byName, String reason, Instant now) {
        this.validTo = now.truncatedTo(ChronoUnit.MICROS);
        this.endedByUserId = byUserId;
        this.endedByName = byName;
        this.endReason = reason;
    }
}
