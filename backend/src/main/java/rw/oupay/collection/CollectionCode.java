package rw.oupay.collection;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import jakarta.persistence.Version;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.UUID;
import rw.oupay.banking.ProviderId;

/**
 * A merchant's collection code, as OuPay records it. {@link #getInternalRef()} is OuPay's own identifier and is never a payment code.
 * {@link #getExternalCode()} is the code the BANK issued: it stays null until approval evidence is recorded, and then never changes.
 * Nothing here makes a code bank-approved except {@link #approve}, which only the trusted approval service calls.
 */
@Entity
@Table(name = "collection_codes")
public class CollectionCode {

    @Id
    private UUID id;

    @Column(name = "merchant_id", nullable = false, updatable = false)
    private UUID merchantId;

    @Enumerated(EnumType.STRING)
    @Column(name = "provider_id", nullable = false, updatable = false)
    private ProviderId providerId;

    @Column(name = "settlement_destination_id", nullable = false, updatable = false)
    private UUID settlementDestinationId;

    @Column(name = "is_simulated", nullable = false, updatable = false)
    private boolean simulated;

    @Column(name = "internal_ref", nullable = false, updatable = false)
    private String internalRef;

    @Column(name = "external_code")
    private String externalCode;

    @Column(name = "display_label", nullable = false)
    private String displayLabel;

    @Column(name = "branch_id", updatable = false)
    private UUID branchId;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    private CollectionCodeStatus status;

    @Column(name = "status_reason")
    private String statusReason;

    @Column(name = "bank_request_ref")
    private String bankRequestRef;

    @Column(name = "bank_request_recorded_at")
    private Instant bankRequestRecordedAt;

    @Enumerated(EnumType.STRING)
    @Column(name = "approval_source")
    private ApprovalSource approvalSource;

    @Column(name = "approval_evidence_ref")
    private String approvalEvidenceRef;

    @Column(name = "approval_recorded_by_user_id")
    private UUID approvalRecordedByUserId;

    @Column(name = "approval_checked_by_user_id")
    private UUID approvalCheckedByUserId;

    @Column(name = "approved_at")
    private Instant approvedAt;

    @Column(name = "client_request_id", nullable = false, updatable = false)
    private UUID clientRequestId;

    @Column(name = "request_sha256", nullable = false, updatable = false)
    private String requestSha256;

    @Column(name = "created_by_user_id", nullable = false, updatable = false)
    private UUID createdByUserId;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    @Version
    private long version;

    protected CollectionCode() {}

    public CollectionCode(UUID merchantId, ProviderId providerId, UUID settlementDestinationId, boolean simulated, String internalRef,
                          String displayLabel, UUID branchId, UUID clientRequestId, String requestSha256, UUID createdByUserId, Instant now) {
        this.id = UUID.randomUUID();
        this.merchantId = merchantId;
        this.providerId = providerId;
        this.settlementDestinationId = settlementDestinationId;
        this.simulated = simulated;
        this.internalRef = internalRef;
        this.displayLabel = displayLabel;
        this.branchId = branchId;
        this.status = CollectionCodeStatus.REQUESTED;
        this.clientRequestId = clientRequestId;
        this.requestSha256 = requestSha256;
        this.createdByUserId = createdByUserId;
        this.createdAt = now.truncatedTo(ChronoUnit.MICROS);
        this.updatedAt = this.createdAt;
    }

    public UUID getId() { return id; }
    public UUID getMerchantId() { return merchantId; }
    public ProviderId getProviderId() { return providerId; }
    public UUID getSettlementDestinationId() { return settlementDestinationId; }
    public boolean isSimulated() { return simulated; }
    public String getInternalRef() { return internalRef; }
    public String getExternalCode() { return externalCode; }
    public String getDisplayLabel() { return displayLabel; }
    public UUID getBranchId() { return branchId; }
    public CollectionCodeStatus getStatus() { return status; }
    public String getStatusReason() { return statusReason; }
    public String getBankRequestRef() { return bankRequestRef; }
    public ApprovalSource getApprovalSource() { return approvalSource; }
    public String getApprovalEvidenceRef() { return approvalEvidenceRef; }
    public Instant getApprovedAt() { return approvedAt; }
    public UUID getApprovalRecordedByUserId() { return approvalRecordedByUserId; }
    public UUID getApprovalCheckedByUserId() { return approvalCheckedByUserId; }
    public Instant getBankRequestRecordedAt() { return bankRequestRecordedAt; }
    public UUID getClientRequestId() { return clientRequestId; }
    public String getRequestSha256() { return requestSha256; }
    public UUID getCreatedByUserId() { return createdByUserId; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }
    public long getVersion() { return version; }

    /**
     * The bank approved this code and it is real (not simulated). Necessary, NOT sufficient, for collection: the code must also be assigned
     * to someone who is currently allowed to collect (see {@link CollectionCodeService}, "eligible for collection").
     */
    public boolean isBankProvisioned() {
        return status == CollectionCodeStatus.ACTIVE && !simulated && externalCode != null;
    }

    /** The caller has checked the transition; the database checks it again. */
    public void recordBankRequest(String reference, Instant now) {
        this.bankRequestRef = reference;
        this.bankRequestRecordedAt = micros(now);
        moveTo(CollectionCodeStatus.REQUEST_DECLARED, null, now);
    }

    public void suspend(String reason, Instant now) {
        moveTo(CollectionCodeStatus.SUSPENDED, reason, now);
    }

    public void deactivate(String reason, Instant now) {
        moveTo(CollectionCodeStatus.DEACTIVATED, reason, now);
    }

    public void reject(String reason, Instant now) {
        moveTo(CollectionCodeStatus.REJECTED, reason, now);
    }

    /** Back to ACTIVE after a suspension; the original approval evidence is unchanged. */
    public void resume(Instant now) {
        moveTo(CollectionCodeStatus.ACTIVE, null, now);
    }

    /** The ONLY way a code becomes bank-approved. Called by {@link CollectionCodeApprovalService} with evidence, never by a merchant API. */
    void approve(String externalCode, ApprovalSource source, String evidenceRef, UUID recordedBy, UUID checkedBy, Instant now) {
        this.externalCode = externalCode;
        this.approvalSource = source;
        this.approvalEvidenceRef = evidenceRef;
        this.approvalRecordedByUserId = recordedBy;
        this.approvalCheckedByUserId = checkedBy;
        this.approvedAt = micros(now);
        moveTo(CollectionCodeStatus.ACTIVE, null, now);
    }

    private void moveTo(CollectionCodeStatus target, String reason, Instant now) {
        this.status = target;
        this.statusReason = reason;
        this.updatedAt = micros(now);
    }

    private static Instant micros(Instant instant) {
        return instant.truncatedTo(ChronoUnit.MICROS);
    }
}
