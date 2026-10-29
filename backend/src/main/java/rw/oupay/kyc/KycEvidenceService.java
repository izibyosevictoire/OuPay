package rw.oupay.kyc;

import java.sql.Timestamp;
import java.time.Clock;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import rw.oupay.audit.AuditService;
import rw.oupay.collection.ApprovalSource;
import rw.oupay.common.ApiException;
import rw.oupay.membership.MembershipRepository;
import rw.oupay.user.UserRepository;

/**
 * The ONLY place an application can move to HANDED_OFF, MORE_INFO_REQUESTED, APPROVED or REJECTED, and only with evidence of what the bank
 * did. It has no HTTP surface and is <b>switched off</b> ({@code oupay.kyc.evidence-recording-enabled=false}, refused outright outside the
 * {@code test} profile by {@link KycEvidenceStartupGuard}): OuPay has no channel to Equity, no verified bank event for KYC and no operator
 * authentication, so there is nothing real to record yet. It exists so the model, its rules and its tests are complete, like the
 * collection-code approval service. A merchant has no way to reach it, and the database refuses these statuses without evidence anyway.
 */
@Service
public class KycEvidenceService {

    /** What proves the step: a verified bank event, or an operator citing written evidence with a second person checking. */
    public record Evidence(ApprovalSource source, String evidenceRef, UUID recordedByUserId, UUID checkedByUserId) {}

    private final JdbcClient jdbc;
    private final AuditService audit;
    private final UserRepository users;
    private final MembershipRepository memberships;
    private final Clock clock;
    private final boolean enabled;

    public KycEvidenceService(JdbcClient jdbc, AuditService audit, UserRepository users, MembershipRepository memberships, Clock clock,
                              @Value("${oupay.kyc.evidence-recording-enabled:false}") boolean enabled) {
        this.jdbc = jdbc;
        this.audit = audit;
        this.users = users;
        this.memberships = memberships;
        this.clock = clock;
        this.enabled = enabled;
    }

    /** Evidence that the application really was handed to the bank. */
    @Transactional
    public void recordHandoff(UUID merchantId, UUID applicationId, Evidence evidence) {
        requireEnabled();
        requireEvidence(merchantId, evidence);
        KycApplicationStatus status = lock(merchantId, applicationId);
        if (status != KycApplicationStatus.COLLECTED) {
            throw ApiException.invalidState("invalid_transition", "Only an application collected by OuPay can be handed off.");
        }
        Instant now = now();
        jdbc.sql("update kyc_applications set status = 'HANDED_OFF', handoff_source = :s, handoff_evidence_ref = :e, handoff_recorded_by_user_id = :r, "
                        + "handoff_checked_by_user_id = :c, handed_off_at = :now, version = version + 1, updated_at = :now where id = :id")
                .param("s", evidence.source().name()).param("e", evidence.evidenceRef().trim()).param("r", evidence.recordedByUserId())
                .param("c", evidence.checkedByUserId()).param("now", Timestamp.from(now)).param("id", applicationId).update();
        event(merchantId, applicationId, "HANDOFF_RECORDED", evidence, status, KycApplicationStatus.HANDED_OFF, now);
        audit.record(merchantId, evidence.recordedByUserId(), "KYC_HANDED_OFF", "kyc_application", applicationId,
                "Equity activation application recorded as handed to the bank (" + evidence.source() + "). Evidence reference recorded.");
    }

    /** The bank asked for more information. */
    @Transactional
    public UUID requestMoreInformation(UUID merchantId, UUID applicationId, Evidence evidence, String message, String fieldKey) {
        requireEnabled();
        requireEvidence(merchantId, evidence);
        KycApplicationStatus status = lock(merchantId, applicationId);
        if (status != KycApplicationStatus.HANDED_OFF && status != KycApplicationStatus.MORE_INFO_REQUESTED) {
            throw ApiException.invalidState("invalid_transition", "Information can only be requested after the application was handed to the bank.");
        }
        if (message == null || message.isBlank() || message.length() > 1000) {
            throw ApiException.validation("The request needs a message of up to 1000 characters.");
        }
        Instant now = now();
        UUID id = UUID.randomUUID();
        jdbc.sql("insert into kyc_information_requests (id, application_id, merchant_id, source, evidence_ref, recorded_by_user_id, checked_by_user_id, message, "
                        + "field_key, requested_at, status) values (:id, :a, :m, :s, :e, :r, :c, :msg, :f, :now, 'OPEN')")
                .param("id", id).param("a", applicationId).param("m", merchantId).param("s", evidence.source().name()).param("e", evidence.evidenceRef().trim())
                .param("r", evidence.recordedByUserId()).param("c", evidence.checkedByUserId()).param("msg", message.trim()).param("f", fieldKey)
                .param("now", Timestamp.from(now)).update();
        if (status == KycApplicationStatus.HANDED_OFF) {
            jdbc.sql("update kyc_applications set status = 'MORE_INFO_REQUESTED', version = version + 1, updated_at = :now where id = :id")
                    .param("now", Timestamp.from(now)).param("id", applicationId).update();
        }
        event(merchantId, applicationId, "MORE_INFORMATION_REQUESTED", evidence, status, KycApplicationStatus.MORE_INFO_REQUESTED, now);
        audit.record(merchantId, evidence.recordedByUserId(), "KYC_MORE_INFO_REQUESTED", "kyc_application", applicationId,
                "The bank asked for more information on the Equity activation application. Evidence reference recorded.");
        return id;
    }

    /** The bank's decision. */
    @Transactional
    public void recordDecision(UUID merchantId, UUID applicationId, boolean approved, Evidence evidence, String reason) {
        requireEnabled();
        requireEvidence(merchantId, evidence);
        KycApplicationStatus status = lock(merchantId, applicationId);
        if (status != KycApplicationStatus.HANDED_OFF && status != KycApplicationStatus.MORE_INFO_REQUESTED) {
            throw ApiException.invalidState("invalid_transition", "A decision can only be recorded after the application was handed to the bank.");
        }
        if (!approved && (reason == null || reason.isBlank() || reason.length() > 300)) {
            throw ApiException.validation("A rejection needs a reason of up to 300 characters.");
        }
        Instant now = now();
        KycApplicationStatus next = approved ? KycApplicationStatus.APPROVED : KycApplicationStatus.REJECTED;
        jdbc.sql("update kyc_applications set status = :st, decision_source = :s, decision_evidence_ref = :e, decision_recorded_by_user_id = :r, "
                        + "decision_checked_by_user_id = :c, decided_at = :now, decision_reason = :reason, version = version + 1, updated_at = :now where id = :id")
                .param("st", next.name()).param("s", evidence.source().name()).param("e", evidence.evidenceRef().trim()).param("r", evidence.recordedByUserId())
                .param("c", evidence.checkedByUserId()).param("now", Timestamp.from(now)).param("reason", reason == null ? null : reason.trim()).param("id", applicationId).update();
        event(merchantId, applicationId, "DECISION_RECORDED", evidence, status, next, now);
        audit.record(merchantId, evidence.recordedByUserId(), approved ? "KYC_APPROVED" : "KYC_REJECTED", "kyc_application", applicationId,
                "Equity activation application recorded as " + (approved ? "approved" : "rejected") + " by the bank (" + evidence.source() + "). Evidence reference recorded.");
    }

    private void requireEnabled() {
        if (!enabled) {
            throw ApiException.notImplemented("Recording the bank's handling of an application is not available: OuPay has no channel to Equity and no verified "
                    + "bank evidence or authenticated operator process for it yet.");
        }
    }

    private void requireEvidence(UUID merchantId, Evidence evidence) {
        if (evidence == null || evidence.source() == null || evidence.evidenceRef() == null || evidence.evidenceRef().isBlank() || evidence.evidenceRef().length() > 200) {
            throw ApiException.validation("Evidence is required.");
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
            throw ApiException.validation("Operator evidence needs two different people: one to record it and one to check it.");
        }
        if (users.findById(maker).isEmpty() || users.findById(checker).isEmpty()) {
            throw ApiException.validation("Both people must be known users.");
        }
        if (memberships.findByUserIdAndMerchantId(maker, merchantId).isPresent() || memberships.findByUserIdAndMerchantId(checker, merchantId).isPresent()) {
            throw ApiException.validation("The people recording evidence must not belong to the business that owns the application.");
        }
    }

    private KycApplicationStatus lock(UUID merchantId, UUID applicationId) {
        return jdbc.sql("select status from kyc_applications where id = :id and merchant_id = :m for update").param("id", applicationId).param("m", merchantId)
                .query((rs, row) -> KycApplicationStatus.valueOf(rs.getString(1))).optional()
                .orElseThrow(() -> ApiException.notFound("This application could not be found."));
    }

    private void event(UUID merchantId, UUID applicationId, String kind, Evidence evidence, KycApplicationStatus from, KycApplicationStatus to, Instant now) {
        jdbc.sql("insert into kyc_events (application_id, merchant_id, kind, actor_user_id, from_status, to_status, detail, created_at) "
                        + "values (:a, :m, :k, :u, :f, :t, :d, :now)")
                .param("a", applicationId).param("m", merchantId).param("k", kind).param("u", evidence.recordedByUserId()).param("f", from.name()).param("t", to.name())
                .param("d", abbreviate(evidence.source() + " " + evidence.evidenceRef().trim())).param("now", Timestamp.from(now)).update();
    }

    private static String abbreviate(String text) {
        return text.length() <= 200 ? text : text.substring(0, 200);
    }

    private Instant now() {
        return clock.instant().truncatedTo(ChronoUnit.MICROS);
    }
}
