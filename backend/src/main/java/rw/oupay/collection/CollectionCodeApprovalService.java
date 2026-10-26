package rw.oupay.collection;

import java.time.Clock;
import java.time.Instant;
import java.util.Locale;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.env.Environment;
import org.springframework.core.env.Profiles;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import rw.oupay.audit.AuditService;
import rw.oupay.common.ApiException;
import rw.oupay.common.DatabaseErrors;
import rw.oupay.membership.MembershipRepository;
import rw.oupay.user.UserRepository;

/**
 * THE ONLY PLACE A COLLECTION CODE BECOMES BANK-APPROVED, AND IT IS <b>OFF</b>.
 *
 * <p><b>Unavailable until real evidence can be verified.</b> OuPay has no operator authentication and no way to verify a bank
 * event yet, so this service refuses {@link #approve} and {@link #resume} unless
 * {@code oupay.collection-codes.approval-enabled=true}, which is {@code false} by default, and the application <b>refuses to start</b>
 * with it enabled under the {@code prod} profile. Two different user ids are not proof of two independent decisions, and a caller
 * naming {@link ApprovalSource#BANK_EVENT} is not proof that the bank said anything. Until the real Equity integration (R6e) verifies
 * authenticated bank evidence, or a separately reviewed operator process authenticates its operators and records their independent
 * decisions, approval stays unavailable for production use. It exists, switched off, so the model and its tests are complete; the
 * flag is turned on only by the integration tests.
 *
 * <p><b>Not reachable from any merchant-facing HTTP endpoint.</b> There is no controller for it: no merchant, owner, manager or cashier can
 * call it, so an owner can never fabricate approval by typing an evidence reference. There is no simulated "approve" endpoint.
 *
 * <p>When it is enabled, what is checked here and again by the database (V11): the code is {@code REQUEST_DECLARED}; the bank-issued code
 * is non-blank, differs from OuPay's own reference, and is not already used by ANY code of the same provider, ever (deactivated codes stay
 * reserved); evidence is present; a bank-event approval names no person; an operator approval names two different existing people who
 * do <b>not</b> belong to the business that owns the code (a merchant's own staff can never approve its codes). The bank-issued code
 * and its evidence are written once, together, and can never be changed. The evidence reference is kept out of the audit message, so
 * people who can read the audit trail do not see it.
 */
@Service
public class CollectionCodeApprovalService {

    /** Evidence for an approval. */
    public record Evidence(ApprovalSource source, String evidenceRef, UUID recordedByUserId, UUID checkedByUserId) {}

    private static final String UNIQUE_VIOLATION = "23505";
    private static final int MAX_EXTERNAL_CODE = 64;

    private final CollectionCodeRepository codes;
    private final CollectionCodeAssignmentRepository assignments;
    private final UserRepository users;
    private final MembershipRepository memberships;
    private final AuditService audit;
    private final Clock clock;
    private final boolean approvalEnabled;

    public CollectionCodeApprovalService(CollectionCodeRepository codes, CollectionCodeAssignmentRepository assignments, UserRepository users,
                                         MembershipRepository memberships, AuditService audit, Clock clock, Environment environment,
                                         @Value("${oupay.collection-codes.approval-enabled:false}") boolean approvalEnabled) {
        if (approvalEnabled && environment.acceptsProfiles(Profiles.of("prod"))) {
            throw new IllegalStateException("Unsafe configuration, refusing to start: oupay.collection-codes.approval-enabled must not be true in "
                    + "production until bank evidence is verified by a real integration or an authenticated operator process exists");
        }
        this.codes = codes;
        this.assignments = assignments;
        this.users = users;
        this.memberships = memberships;
        this.audit = audit;
        this.clock = clock;
        this.approvalEnabled = approvalEnabled;
    }

    /** Records the code the bank issued, with its evidence, and activates the code. */
    @Transactional
    public CollectionCode approve(UUID merchantId, UUID codeId, String externalCode, Evidence evidence) {
        requireEnabled();
        CollectionCode code = lock(merchantId, codeId);
        if (code.getStatus() != CollectionCodeStatus.REQUEST_DECLARED) {
            throw ApiException.conflict("code_status_invalid", "Only a code whose bank request was declared can be approved.");
        }
        String bankCode = externalCode == null ? "" : externalCode.trim();
        if (bankCode.isEmpty() || bankCode.length() > MAX_EXTERNAL_CODE || bankCode.chars().anyMatch(Character::isISOControl)) {
            throw ApiException.validation("The bank-issued code is required (up to " + MAX_EXTERNAL_CODE + " characters, no control characters).");
        }
        if (bankCode.toUpperCase(Locale.ROOT).equals(code.getInternalRef())) {
            throw ApiException.validation("The bank-issued code cannot be OuPay's own reference.");
        }
        requireEvidence(merchantId, evidence);
        if (codes.existsByProviderIdAndExternalCodeIgnoreCase(code.getProviderId(), bankCode)) {
            throw ApiException.conflict("external_code_taken", "That bank-issued code is already recorded for another collection code.");
        }
        code.approve(bankCode, evidence.source(), evidence.evidenceRef().trim(), evidence.recordedByUserId(), evidence.checkedByUserId(), clock.instant());
        try {
            code = codes.saveAndFlush(code);
        } catch (DataIntegrityViolationException e) {
            if (DatabaseErrors.sqlState(e).filter(UNIQUE_VIOLATION::equals).isPresent()) {
                throw ApiException.conflict("external_code_taken", "That bank-issued code is already recorded for another collection code.");
            }
            throw e;
        }
        audit.record(merchantId, evidence.recordedByUserId(), "COLLECTION_CODE_APPROVED", "collection_code", code.getId(),
                "Collection code " + code.getInternalRef() + " recorded as approved by the bank (" + evidence.source() + "). Evidence reference recorded.");
        return code;
    }

    /** The bank did not approve the request. The code is final; an open assignment ends in the same transaction. */
    @Transactional
    public CollectionCode reject(UUID merchantId, UUID codeId, String reason, UUID recordedByUserId) {
        CollectionCode code = lock(merchantId, codeId);
        if (!code.getStatus().canMoveTo(CollectionCodeStatus.REJECTED)) {
            throw ApiException.conflict("code_status_invalid", "A code that is " + code.getStatus().name().toLowerCase(Locale.ROOT) + " cannot be rejected.");
        }
        if (reason == null || reason.isBlank()) {
            throw ApiException.validation("A reason is required.");
        }
        Instant now = clock.instant();
        assignments.findByCodeIdAndMerchantIdAndValidToIsNull(codeId, merchantId).ifPresent(open -> {
            open.end(recordedByUserId, "Bank process", "Collection code rejected", now);
            assignments.saveAndFlush(open);
        });
        code.reject(reason.trim(), now);
        code = codes.saveAndFlush(code);
        audit.record(merchantId, recordedByUserId, "COLLECTION_CODE_REJECTED", "collection_code", code.getId(),
                "Collection code " + code.getInternalRef() + " was not approved by the bank. Reason: " + reason.trim());
        return code;
    }

    /** Lifts a suspension, with a reference to the bank's confirmation. The original approval evidence is unchanged. */
    @Transactional
    public CollectionCode resume(UUID merchantId, UUID codeId, String evidenceRef, UUID recordedByUserId) {
        requireEnabled();
        CollectionCode code = lock(merchantId, codeId);
        if (code.getStatus() != CollectionCodeStatus.SUSPENDED) {
            throw ApiException.conflict("code_status_invalid", "Only a suspended code can be resumed.");
        }
        if (evidenceRef == null || evidenceRef.isBlank() || recordedByUserId == null) {
            throw ApiException.validation("Evidence and the person recording it are required.");
        }
        if (memberships.findByUserIdAndMerchantId(recordedByUserId, merchantId).isPresent()) {
            throw ApiException.validation("A member of the business cannot lift a suspension of its own code.");
        }
        code.resume(clock.instant());
        code = codes.saveAndFlush(code);
        audit.record(merchantId, recordedByUserId, "COLLECTION_CODE_RESUMED", "collection_code", code.getId(),
                "Collection code " + code.getInternalRef() + " resumed. Evidence reference recorded.");
        return code;
    }

    private void requireEnabled() {
        if (!approvalEnabled) {
            throw ApiException.notImplemented("Bank approval of collection codes is not available: it needs verified bank evidence or an authenticated "
                    + "operator process, neither of which exists yet.");
        }
    }

    private void requireEvidence(UUID merchantId, Evidence evidence) {
        if (evidence == null || evidence.source() == null || evidence.evidenceRef() == null || evidence.evidenceRef().isBlank()) {
            throw ApiException.validation("Approval evidence is required.");
        }
        if (evidence.source() == ApprovalSource.BANK_EVENT) {
            if (evidence.recordedByUserId() != null || evidence.checkedByUserId() != null) {
                throw ApiException.validation("A bank event is not recorded by a person.");
            }
            return;
        }
        UUID maker = evidence.recordedByUserId();
        UUID checker = evidence.checkedByUserId();
        if (maker == null || checker == null || maker.equals(checker)) {
            throw ApiException.validation("An operator approval needs two different people: one to record it and one to check it.");
        }
        if (users.findById(maker).isEmpty() || users.findById(checker).isEmpty()) {
            throw ApiException.validation("Both people must be known users.");
        }
        if (memberships.findByUserIdAndMerchantId(maker, merchantId).isPresent() || memberships.findByUserIdAndMerchantId(checker, merchantId).isPresent()) {
            throw ApiException.validation("The people approving a code must not belong to the business that owns it.");
        }
    }

    private CollectionCode lock(UUID merchantId, UUID codeId) {
        return codes.lockByIdAndMerchantId(codeId, merchantId).orElseThrow(() -> ApiException.notFound("This collection code could not be found."));
    }
}
