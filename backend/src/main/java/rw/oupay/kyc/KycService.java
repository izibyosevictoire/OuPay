package rw.oupay.kyc;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.TreeMap;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import rw.oupay.audit.AuditService;
import rw.oupay.common.ApiException;
import rw.oupay.idempotency.IdempotencyService;
import rw.oupay.membership.Actor;
import rw.oupay.membership.MerchantAccess;
import rw.oupay.membership.Permission;
import rw.oupay.merchant.Merchant;
import rw.oupay.merchant.MerchantRepository;
import tools.jackson.databind.json.JsonMapper;

/**
 * Equity KYC onboarding, as the business OWNER sees it. Everything here is owner-only ({@link Permission#KYC_MANAGE}), merchant-scoped by
 * the URL AND by composite foreign keys, and one {@code @Transactional} unit with its audit entry.
 *
 * <h2>What this service can and cannot say</h2>
 * It collects, saves, consents and submits TO OUPAY. It never contacts Equity, never moves an application to HANDED_OFF, MORE_INFO_REQUESTED,
 * APPROVED or REJECTED (see {@link KycEvidenceService}, which has no HTTP surface and is switched off), and never claims a document was
 * received: documents are only tracked, and upload is refused while there is no secure storage.
 *
 * <h2>Sensitive data</h2>
 * Fields the requirement set marks sensitive are encrypted by {@link KycFieldCipher} and are refused when no key is configured. They are not in
 * any ordinary response, audit entry, event, snapshot or error message. Reading one back is a separate action that writes an event and an audit
 * entry naming the FIELD only.
 */
@Service
public class KycService {

    static final String PROVIDER = "EQUITY";

    private final JdbcClient jdbc;
    private final MerchantAccess access;
    private final MerchantRepository merchants;
    private final AuditService audit;
    private final IdempotencyService fingerprints;
    private final KycFieldCipher cipher;
    private final JsonMapper json;
    private final Clock clock;
    private final long retentionDays;
    private final boolean revealEnabled;

    public KycService(JdbcClient jdbc, MerchantAccess access, MerchantRepository merchants, AuditService audit, IdempotencyService fingerprints,
                      KycFieldCipher cipher, JsonMapper json, Clock clock, @Value("${oupay.kyc.retention-days:0}") long retentionDays,
                      @Value("${oupay.kyc.reveal-enabled:false}") boolean revealEnabled) {
        this.jdbc = jdbc;
        this.access = access;
        this.merchants = merchants;
        this.audit = audit;
        this.fingerprints = fingerprints;
        this.cipher = cipher;
        this.json = json;
        this.clock = clock;
        this.retentionDays = retentionDays;
        this.revealEnabled = revealEnabled;
    }

    public record Written(KycDtos.ApplicationDto application, boolean created) {}

    private record AppRow(UUID id, UUID merchantId, KycApplicationStatus status, UUID setId, int setVersion, long version, Instant createdAt,
                          Instant updatedAt, Instant submittedAt, Instant handedOffAt, Instant decidedAt, String decisionReason, String answersSha256,
                          UUID submissionRequestId, String requestSha256) {}

    private record AnswerRow(String key, boolean sensitive, String value, byte[] ciphertext, String keyId, String hint, String source) {}

    // ---- reads ---------------------------------------------------------------------------------

    @Transactional(readOnly = true)
    public KycDtos.Options options(UUID merchantId) {
        access.require(merchantId, Permission.KYC_MANAGE);
        KycRequirements.RequirementSet set = currentSet();
        Merchant merchant = merchants.findById(merchantId).orElseThrow(() -> ApiException.notFound("This business could not be found."));
        var accounts = jdbc.sql("select label, masked_account, provider_id, is_simulated from payment_destinations where merchant_id = :m order by created_at")
                .param("m", merchantId)
                .query((rs, row) -> new KycDtos.LinkedAccount(rs.getString("label"), rs.getString("masked_account"), rs.getString("provider_id"),
                        rs.getBoolean("is_simulated")))
                .list();
        KycDtos.ApplicationSummary current = list(merchantId).stream().filter(a -> a.status() != KycApplicationStatus.REJECTED).findFirst().orElse(null);
        return new KycDtos.Options(PROVIDER, new KycDtos.RequirementSetDto(set.version(), set.provisional(), set.effectiveFrom(), set.definition()),
                prefill(merchant, set), new KycDtos.StorageDto(false, cipher.available(), revealEnabled && cipher.available(), false,
                "OuPay cannot receive documents yet: there is no secure storage. OuPay does not send applications to Equity yet either: "
                        + "submitting here only gives them to OuPay for review."),
                accounts, current, retentionDays > 0);
    }

    @Transactional(readOnly = true)
    public List<KycDtos.ApplicationSummary> list(UUID merchantId) {
        access.require(merchantId, Permission.KYC_MANAGE);
        return jdbc.sql("select id, status, requirement_set_version, created_at, submitted_at, decided_at from kyc_applications "
                        + "where merchant_id = :m order by created_at desc, id desc")
                .param("m", merchantId)
                .query((rs, row) -> new KycDtos.ApplicationSummary(rs.getObject("id", UUID.class), KycApplicationStatus.valueOf(rs.getString("status")),
                        rs.getInt("requirement_set_version"), instant(rs.getTimestamp("created_at")), instant(rs.getTimestamp("submitted_at")),
                        instant(rs.getTimestamp("decided_at"))))
                .list();
    }

    @Transactional(readOnly = true)
    public KycDtos.ApplicationDto get(UUID merchantId, UUID applicationId) {
        access.require(merchantId, Permission.KYC_MANAGE);
        return toDto(load(merchantId, applicationId, false));
    }

    // ---- writes: the owner's own steps ---------------------------------------------------------

    /** Starts a draft, prefilled from the business registration. Durable and idempotent by {@code clientOperationId}. */
    @Transactional
    public Written start(UUID merchantId, KycDtos.StartRequest request) {
        Actor actor = access.require(merchantId, Permission.KYC_MANAGE);
        String fingerprint = fingerprints.fingerprintOf("KYC_START", Map.of("merchantId", merchantId), Map.of("actor", actor.userId(), "provider", PROVIDER));
        lock("kyc-start:" + merchantId + ":" + request.clientOperationId());
        Optional<AppRow> existing = jdbc.sql(APP_SELECT + " where merchant_id = :m and client_operation_id = :c")
                .param("m", merchantId).param("c", request.clientOperationId()).query(APP_MAPPER).optional();
        if (existing.isPresent()) {
            if (!fingerprint.equals(existing.get().requestSha256())) {
                throw ApiException.conflict("client_request_id_reuse", "This request identifier was already used for a different request.");
            }
            return new Written(toDto(existing.get()), false);
        }
        // Serialise starts for one business, so the "one live application" rule is a clear 409 rather than a database error.
        lock("kyc-live:" + merchantId);
        if (jdbc.sql("select count(*) from kyc_applications where merchant_id = :m and provider_id = :p and status <> 'REJECTED'")
                .param("m", merchantId).param("p", PROVIDER).query(Integer.class).single() > 0) {
            throw ApiException.conflict("application_exists", "This business already has an Equity activation application.");
        }
        KycRequirements.RequirementSet set = currentSet();
        Merchant merchant = merchants.findById(merchantId).orElseThrow(() -> ApiException.notFound("This business could not be found."));
        UUID id = UUID.randomUUID();
        Instant now = now();
        jdbc.sql("insert into kyc_applications (id, merchant_id, provider_id, requirement_set_id, requirement_set_version, status, client_operation_id, "
                        + "request_sha256, created_by_user_id, created_at, updated_at, version) "
                        + "values (:id, :m, :p, :s, :sv, 'DRAFT', :c, :h, :u, :now, :now, 0)")
                .param("id", id).param("m", merchantId).param("p", PROVIDER).param("s", set.id()).param("sv", set.version())
                .param("c", request.clientOperationId()).param("h", fingerprint).param("u", actor.userId()).param("now", Timestamp.from(now)).update();
        Map<String, String> known = prefill(merchant, set);
        for (KycRequirements.Field field : set.definition().fields()) {
            String value = known.get(field.key());
            if (value == null || field.sensitive()) {
                continue;
            }
            try {
                storeAnswer(merchantId, id, field, KycRequirements.validate(field, value), "PREFILL", now);
            } catch (ApiException invalidPrefill) {
                // A registration value that does not fit this form's rules is left for the owner to fix, never forced in.
            }
        }
        event(merchantId, id, "APPLICATION_STARTED", actor.userId(), null, KycApplicationStatus.DRAFT, "requirement set v" + set.version(), now);
        audit.record(merchantId, actor.userId(), "KYC_STARTED", "kyc_application", id, "Equity activation application started (draft).");
        return new Written(toDto(load(merchantId, id, false)), true);
    }

    @Transactional
    public KycDtos.ApplicationDto saveAnswers(UUID merchantId, UUID applicationId, KycDtos.SaveAnswersRequest request) {
        Actor actor = access.require(merchantId, Permission.KYC_MANAGE);
        AppRow app = load(merchantId, applicationId, true);
        requireDraft(app);
        requireVersion(app, request.expectedVersion());
        KycRequirements.RequirementSet set = set(app);
        Instant now = now();
        // Validate EVERYTHING before writing anything, so a refused save changes nothing.
        Map<String, String> clean = new LinkedHashMap<>();
        for (Map.Entry<String, String> entry : request.answers().entrySet()) {
            KycRequirements.Field field = set.field(entry.getKey());
            if (field == null) {
                throw ApiException.validation("That is not a field of this application.");
            }
            if (entry.getValue() == null || entry.getValue().isBlank()) {
                clean.put(field.key(), null);
                continue;
            }
            String value = KycRequirements.validate(field, entry.getValue());
            if (field.sensitive() && !cipher.available()) {
                throw ApiException.invalidState("sensitive_storage_unavailable",
                        "OuPay cannot store " + field.label().toLowerCase(java.util.Locale.ROOT) + " securely yet, so it cannot be saved. Leave it empty for now.");
            }
            clean.put(field.key(), value);
        }
        for (Map.Entry<String, String> entry : clean.entrySet()) {
            KycRequirements.Field field = set.field(entry.getKey());
            if (entry.getValue() == null) {
                jdbc.sql("delete from kyc_answers where application_id = :a and field_key = :k").param("a", applicationId).param("k", field.key()).update();
            } else {
                storeAnswer(merchantId, applicationId, field, entry.getValue(), "OWNER", now);
            }
        }
        bump(applicationId, now);
        event(merchantId, applicationId, "ANSWERS_SAVED", actor.userId(), KycApplicationStatus.DRAFT, KycApplicationStatus.DRAFT, clean.size() + " field(s)", now);
        audit.record(merchantId, actor.userId(), "KYC_DRAFT_SAVED", "kyc_application", applicationId, "Equity activation draft saved.");
        return toDto(load(merchantId, applicationId, false));
    }

    /** Records what the owner SAYS about a document. It never means a file was received. */
    @Transactional
    public KycDtos.ApplicationDto declareDocument(UUID merchantId, UUID applicationId, String key, KycDtos.DocumentRequest request) {
        Actor actor = access.require(merchantId, Permission.KYC_MANAGE);
        AppRow app = load(merchantId, applicationId, true);
        if (app.status() != KycApplicationStatus.DRAFT && app.status() != KycApplicationStatus.MORE_INFO_REQUESTED) {
            throw ApiException.invalidState("application_not_editable", "Documents can only be tracked while the application is a draft or more information was requested.");
        }
        requireVersion(app, request.expectedVersion());
        if (set(app).document(key) == null) {
            throw ApiException.validation("That is not a document of this application.");
        }
        Instant now = now();
        jdbc.sql("insert into kyc_documents (application_id, merchant_id, requirement_key, state, declared_ready_at, updated_at) "
                        + "values (:a, :m, :k, :s, :d, :now) on conflict (application_id, requirement_key) do update set state = excluded.state, "
                        + "declared_ready_at = excluded.declared_ready_at, updated_at = excluded.updated_at")
                .param("a", applicationId).param("m", merchantId).param("k", key).param("s", request.declaredReady() ? "DECLARED_READY" : "NOT_PROVIDED")
                .param("d", request.declaredReady() ? Timestamp.from(now) : null).param("now", Timestamp.from(now)).update();
        bump(applicationId, now);
        event(merchantId, applicationId, "DOCUMENT_TRACKED", actor.userId(), app.status(), app.status(), key + (request.declaredReady() ? " declared ready" : " not ready"), now);
        audit.record(merchantId, actor.userId(), "KYC_DOCUMENT_TRACKED", "kyc_application", applicationId, "A document requirement was marked in the Equity activation application.");
        return toDto(load(merchantId, applicationId, false));
    }

    /** Uploads are unavailable until secure private storage exists. Nothing is stored, and nothing is claimed as received. */
    @Transactional(readOnly = true)
    public void upload(UUID merchantId, UUID applicationId, String key) {
        access.require(merchantId, Permission.KYC_MANAGE);
        AppRow app = load(merchantId, applicationId, false);
        if (set(app).document(key) == null) {
            throw ApiException.validation("That is not a document of this application.");
        }
        throw ApiException.notImplemented("Document upload is not available yet: OuPay has no secure private storage for identity documents. "
                + "Nothing was received. You can mark a document as ready so it can be requested later.");
    }

    @Transactional
    public KycDtos.ApplicationDto consent(UUID merchantId, UUID applicationId, KycDtos.ConsentRequest request) {
        Actor actor = access.require(merchantId, Permission.KYC_MANAGE);
        AppRow app = load(merchantId, applicationId, true);
        requireDraft(app);
        requireVersion(app, request.expectedVersion());
        KycRequirements.RequirementSet set = set(app);
        if (!request.affirmed()) {
            throw ApiException.validation("Consent needs an explicit confirmation.");
        }
        if (!set.definition().consent().textVersion().equals(request.consentTextVersion())) {
            throw ApiException.conflict("consent_text_changed", "The consent wording changed. Read the current text and confirm it again.");
        }
        Map<String, String> values = values(app);
        List<String> missing = missingFields(set, values);
        if (!missing.isEmpty()) {
            throw ApiException.invalidState("application_incomplete", "Complete the required information before giving consent.");
        }
        Instant now = now();
        UUID id = UUID.randomUUID();
        int inserted = jdbc.sql("insert into kyc_consents (id, application_id, merchant_id, user_id, consenting_name, requirement_set_version, consent_text_version, "
                        + "consent_text_sha256, answers_sha256, affirmed, affirmation_method, given_at) "
                        + "values (:id, :a, :m, :u, :n, :sv, :tv, :th, :ah, true, 'EXPLICIT_AFFIRMATION', :now) "
                        + "on conflict (application_id, consent_text_version, answers_sha256) do nothing")
                .param("id", id).param("a", applicationId).param("m", merchantId).param("u", actor.userId()).param("n", actor.user().getFullName())
                .param("sv", set.version()).param("tv", set.definition().consent().textVersion()).param("th", sha256(set.definition().consent().text()))
                .param("ah", answersHash(app, set, values)).param("now", Timestamp.from(now)).update();
        if (inserted == 1) {
            bump(applicationId, now);
            event(merchantId, applicationId, "CONSENT_RECORDED", actor.userId(), KycApplicationStatus.DRAFT, KycApplicationStatus.DRAFT,
                    "consent text " + set.definition().consent().textVersion(), now);
            audit.record(merchantId, actor.userId(), "KYC_CONSENT_RECORDED", "kyc_application", applicationId, "Consent recorded for the Equity activation application.");
        }
        return toDto(load(merchantId, applicationId, false));
    }

    /** DRAFT to COLLECTED: given to OuPay for review. A repeat of the same submission returns the same result. */
    @Transactional
    public Written submit(UUID merchantId, UUID applicationId, KycDtos.SubmitRequest request) {
        Actor actor = access.require(merchantId, Permission.KYC_MANAGE);
        AppRow app = load(merchantId, applicationId, true);
        if (app.status() != KycApplicationStatus.DRAFT) {
            if (request.submissionRequestId().equals(app.submissionRequestId())) {
                return new Written(toDto(app), false);
            }
            throw ApiException.invalidState("invalid_transition", "This application was already submitted to OuPay.");
        }
        requireVersion(app, request.expectedVersion());
        KycRequirements.RequirementSet set = set(app);
        Map<String, String> values = values(app);
        List<String> missing = missingFields(set, values);
        if (!missing.isEmpty()) {
            throw ApiException.invalidState("application_incomplete", "Complete the required information before submitting.");
        }
        if (!blockingDocuments(app, set, values).isEmpty()) {
            throw ApiException.invalidState("documents_required", "A document that must be received as a file is still missing. Marking it ready is not enough.");
        }
        String hash = answersHash(app, set, values);
        Optional<UUID> consentId = jdbc.sql("select id from kyc_consents where application_id = :a and answers_sha256 = :h and consent_text_version = :v "
                        + "order by given_at desc limit 1")
                .param("a", applicationId).param("h", hash).param("v", set.definition().consent().textVersion()).query(UUID.class).optional();
        if (consentId.isEmpty()) {
            throw ApiException.invalidState("consent_required", "Give consent to the current information before submitting. Any change after consent needs consent again.");
        }
        Instant now = now();
        String snapshot = json.writeValueAsString(snapshot(app, set, values, consentId.get(), now));
        Instant retention = retentionDays > 0 ? now.plus(retentionDays, ChronoUnit.DAYS) : null;
        jdbc.sql("update kyc_applications set status = 'COLLECTED', submission_request_id = :r, submitted_at = :now, submitted_by_user_id = :u, submitted_by_name = :n, "
                        + "answers_sha256 = :h, submission_snapshot = cast(:s as jsonb), retention_until = :ret, version = version + 1, updated_at = :now where id = :id")
                .param("r", request.submissionRequestId()).param("now", Timestamp.from(now)).param("u", actor.userId()).param("n", actor.user().getFullName())
                .param("h", hash).param("s", snapshot).param("ret", retention == null ? null : Timestamp.from(retention)).param("id", applicationId).update();
        event(merchantId, applicationId, "SUBMITTED_TO_OUPAY", actor.userId(), KycApplicationStatus.DRAFT, KycApplicationStatus.COLLECTED, null, now);
        audit.record(merchantId, actor.userId(), "KYC_SUBMITTED", "kyc_application", applicationId,
                "Equity activation application submitted to OuPay for review. It has not been sent to Equity.");
        return new Written(toDto(load(merchantId, applicationId, false)), true);
    }

    /** The owner answers a bank request. When the last open one is answered the application is back with OuPay (COLLECTED). */
    @Transactional
    public KycDtos.ApplicationDto respond(UUID merchantId, UUID applicationId, UUID requestId, KycDtos.InformationResponseRequest request) {
        Actor actor = access.require(merchantId, Permission.KYC_MANAGE);
        AppRow app = load(merchantId, applicationId, true);
        if (app.status() != KycApplicationStatus.MORE_INFO_REQUESTED) {
            throw ApiException.invalidState("invalid_transition", "No information has been requested for this application.");
        }
        String text = request.response().trim();
        if (text.isEmpty() || text.chars().anyMatch(c -> Character.isISOControl(c) && c != '\n' && c != '\r' && c != '\t')) {
            throw ApiException.validation("Write your answer as plain text.");
        }
        Instant now = now();
        int updated = jdbc.sql("update kyc_information_requests set status = 'RESPONDED', response_text = :t, responded_by_user_id = :u, responded_at = :now "
                        + "where id = :r and application_id = :a and merchant_id = :m and status = 'OPEN'")
                .param("t", text).param("u", actor.userId()).param("now", Timestamp.from(now)).param("r", requestId).param("a", applicationId).param("m", merchantId).update();
        if (updated != 1) {
            throw ApiException.notFound("This information request could not be found, or was already answered.");
        }
        event(merchantId, applicationId, "INFORMATION_PROVIDED", actor.userId(), app.status(), app.status(), null, now);
        boolean stillOpen = jdbc.sql("select count(*) from kyc_information_requests where application_id = :a and status = 'OPEN'").param("a", applicationId)
                .query(Integer.class).single() > 0;
        if (!stillOpen) {
            jdbc.sql("update kyc_applications set status = 'COLLECTED', version = version + 1, updated_at = :now where id = :id")
                    .param("now", Timestamp.from(now)).param("id", applicationId).update();
            event(merchantId, applicationId, "RETURNED_TO_OUPAY", actor.userId(), KycApplicationStatus.MORE_INFO_REQUESTED, KycApplicationStatus.COLLECTED, null, now);
        } else {
            bump(applicationId, now);
        }
        audit.record(merchantId, actor.userId(), "KYC_INFORMATION_PROVIDED", "kyc_application", applicationId, "Information requested for the Equity activation application was provided to OuPay.");
        return toDto(load(merchantId, applicationId, false));
    }

    /** Shows one sensitive value to the owner, and records that it was shown (the field, never the value). */
    @Transactional
    public KycDtos.Revealed reveal(UUID merchantId, UUID applicationId, String key) {
        Actor actor = access.require(merchantId, Permission.KYC_MANAGE);
        if (!revealEnabled) {
            throw ApiException.notImplemented("Showing a saved protected value is not available. It needs a separately secured workflow, "
                    + "which OuPay does not have yet. You can replace a value by typing a new one.");
        }
        AppRow app = load(merchantId, applicationId, false);
        KycRequirements.Field field = set(app).field(key);
        if (field == null || !field.sensitive()) {
            throw ApiException.validation("That is not a protected field.");
        }
        AnswerRow row = answerRows(applicationId).stream().filter(a -> a.key().equals(key)).findFirst()
                .orElseThrow(() -> ApiException.notFound("There is no saved value for this field."));
        if (!cipher.available()) {
            throw ApiException.invalidState("sensitive_storage_unavailable", "Protected values cannot be read: secure storage is not configured.");
        }
        // Decrypt FIRST: a value that cannot be read (a different key, damaged data) is reported safely and changes nothing, and is not
        // recorded as viewed because nothing was shown.
        String value;
        try {
            value = cipher.decrypt(row.ciphertext(), row.keyId(), context(merchantId, applicationId, key));
        } catch (IllegalStateException unreadable) {
            throw ApiException.invalidState("sensitive_value_unreadable", "This protected value cannot be read with the key that is configured now. "
                    + "Nothing was changed; type the value again to replace it.");
        }
        Instant now = now();
        event(merchantId, applicationId, "SENSITIVE_VALUE_VIEWED", actor.userId(), app.status(), app.status(), key, now);
        audit.record(merchantId, actor.userId(), "KYC_SENSITIVE_VIEWED", "kyc_application", applicationId, "A protected KYC value was viewed by the owner: " + key + ".");
        return new KycDtos.Revealed(key, value);
    }

    // ---- internals -----------------------------------------------------------------------------

    private static final String APP_SELECT = "select id, merchant_id, status, requirement_set_id, requirement_set_version, version, created_at, updated_at, submitted_at, "
            + "handed_off_at, decided_at, decision_reason, answers_sha256, submission_request_id, request_sha256 from kyc_applications";

    private static final org.springframework.jdbc.core.RowMapper<AppRow> APP_MAPPER = (rs, row) -> new AppRow(rs.getObject("id", UUID.class),
            rs.getObject("merchant_id", UUID.class), KycApplicationStatus.valueOf(rs.getString("status")), rs.getObject("requirement_set_id", UUID.class),
            rs.getInt("requirement_set_version"), rs.getLong("version"), instant(rs.getTimestamp("created_at")), instant(rs.getTimestamp("updated_at")),
            instant(rs.getTimestamp("submitted_at")), instant(rs.getTimestamp("handed_off_at")), instant(rs.getTimestamp("decided_at")),
            rs.getString("decision_reason"), rs.getString("answers_sha256"), rs.getObject("submission_request_id", UUID.class), rs.getString("request_sha256"));

    /** Every query is merchant-scoped: another business's application is simply "not found". */
    private AppRow load(UUID merchantId, UUID applicationId, boolean forUpdate) {
        return jdbc.sql(APP_SELECT + " where id = :id and merchant_id = :m" + (forUpdate ? " for update" : ""))
                .param("id", applicationId).param("m", merchantId).query(APP_MAPPER).optional()
                .orElseThrow(() -> ApiException.notFound("This application could not be found."));
    }

    private static void requireDraft(AppRow app) {
        if (app.status() != KycApplicationStatus.DRAFT) {
            throw ApiException.invalidState("application_not_editable", "This application was already submitted to OuPay and can no longer be edited.");
        }
    }

    private static void requireVersion(AppRow app, long expected) {
        if (app.version() != expected) {
            throw ApiException.conflict("version_conflict", "This application was changed elsewhere. Reload it and try again.");
        }
    }

    private KycRequirements.RequirementSet currentSet() {
        return jdbc.sql("select id, provider_id, version, provisional, effective_from, definition::text as definition from kyc_requirement_sets "
                        + "where provider_id = :p and effective_from <= :now order by version desc limit 1")
                .param("p", PROVIDER).param("now", Timestamp.from(now())).query((rs, row) -> readSet(rs)).optional()
                .orElseThrow(() -> new ApiException(HttpStatus.SERVICE_UNAVAILABLE, "service_unavailable", "No requirement set is published."));
    }

    private KycRequirements.RequirementSet set(AppRow app) {
        return jdbc.sql("select id, provider_id, version, provisional, effective_from, definition::text as definition from kyc_requirement_sets where id = :id")
                .param("id", app.setId()).query((rs, row) -> readSet(rs)).single();
    }

    private KycRequirements.RequirementSet readSet(java.sql.ResultSet rs) throws java.sql.SQLException {
        return new KycRequirements.RequirementSet(rs.getObject("id", UUID.class), rs.getString("provider_id"), rs.getInt("version"), rs.getBoolean("provisional"),
                instant(rs.getTimestamp("effective_from")), json.readValue(rs.getString("definition"), KycRequirements.Definition.class));
    }

    /** What the business registration already tells us, so nothing is asked twice. Kept apart from, and never written back to, the registration. */
    private Map<String, String> prefill(Merchant merchant, KycRequirements.RequirementSet set) {
        Map<String, String> known = new LinkedHashMap<>();
        put(known, "business.legalName", merchant.getLegalName());
        put(known, "business.type", merchant.getBusinessType());
        put(known, "business.registrationNumber", merchant.getRegistrationNumber());
        put(known, "business.tin", merchant.getTin());
        put(known, "business.physicalAddress", java.util.stream.Stream.of(merchant.getPhysicalAddress(), merchant.getSector(), merchant.getDistrict(), merchant.getProvince())
                .filter(s -> s != null && !s.isBlank()).collect(java.util.stream.Collectors.joining(", ")));
        put(known, "business.contactPhone", merchant.getContactPhone());
        put(known, "business.contactEmail", merchant.getContactEmail());
        put(known, "representative.fullName", merchant.getContactFullName());
        known.keySet().removeIf(k -> set.field(k) == null || set.field(k).sensitive());
        return known;
    }

    private static void put(Map<String, String> map, String key, String value) {
        if (value != null && !value.isBlank()) {
            map.put(key, value.trim());
        }
    }

    private void storeAnswer(UUID merchantId, UUID applicationId, KycRequirements.Field field, String value, String source, Instant now) {
        if (field.sensitive()) {
            String hint = "••••" + value.substring(Math.max(0, value.length() - 4));
            jdbc.sql("insert into kyc_answers (application_id, merchant_id, field_key, sensitive, value_text, ciphertext, key_id, value_hint, source, updated_at) "
                            + "values (:a, :m, :k, true, null, :c, :kid, :h, :s, :now) on conflict (application_id, field_key) do update set ciphertext = excluded.ciphertext, "
                            + "key_id = excluded.key_id, value_hint = excluded.value_hint, source = excluded.source, updated_at = excluded.updated_at")
                    .param("a", applicationId).param("m", merchantId).param("k", field.key()).param("c", cipher.encrypt(value, context(merchantId, applicationId, field.key())))
                    .param("kid", cipher.keyId()).param("h", hint).param("s", source).param("now", Timestamp.from(now)).update();
        } else {
            jdbc.sql("insert into kyc_answers (application_id, merchant_id, field_key, sensitive, value_text, source, updated_at) "
                            + "values (:a, :m, :k, false, :v, :s, :now) on conflict (application_id, field_key) do update set value_text = excluded.value_text, "
                            + "source = excluded.source, updated_at = excluded.updated_at")
                    .param("a", applicationId).param("m", merchantId).param("k", field.key()).param("v", value).param("s", source).param("now", Timestamp.from(now)).update();
        }
    }

    private static String context(UUID merchantId, UUID applicationId, String key) {
        return merchantId + "|" + applicationId + "|" + key;
    }

    private List<AnswerRow> answerRows(UUID applicationId) {
        return jdbc.sql("select field_key, sensitive, value_text, ciphertext, key_id, value_hint, source from kyc_answers where application_id = :a order by field_key")
                .param("a", applicationId)
                .query((rs, row) -> new AnswerRow(rs.getString("field_key"), rs.getBoolean("sensitive"), rs.getString("value_text"), rs.getBytes("ciphertext"),
                        rs.getString("key_id"), rs.getString("value_hint"), rs.getString("source")))
                .list();
    }

    /**
     * What is answered, for applicability and completeness. A protected answer is represented by a fixed marker, never decrypted: no code path
     * outside the audited reveal ever turns ciphertext back into plaintext, so a wrong or missing key cannot affect anything else.
     */
    private Map<String, String> values(AppRow app) {
        Map<String, String> values = new HashMap<>();
        for (AnswerRow row : answerRows(app.id())) {
            values.put(row.key(), row.sensitive() ? PROTECTED : row.value());
        }
        return values;
    }

    private static final String PROTECTED = "[protected]";

    /** Documents that must exist as a stored file before submission. Only STORED counts; "declared ready" never does. */
    private List<String> blockingDocuments(AppRow app, KycRequirements.RequirementSet set, Map<String, String> values) {
        Map<String, String> states = new HashMap<>();
        jdbc.sql("select requirement_key, state from kyc_documents where application_id = :a").param("a", app.id())
                .query((rs, row) -> Map.entry(rs.getString(1), rs.getString(2))).list().forEach(e -> states.put(e.getKey(), e.getValue()));
        return set.definition().documents().stream()
                .filter(d -> d.requiredAtSubmission() && KycRequirements.applies(d.appliesWhen(), values) && !"STORED".equals(states.get(d.key())))
                .map(KycRequirements.Document::key).toList();
    }

    private static List<String> missingFields(KycRequirements.RequirementSet set, Map<String, String> values) {
        List<String> missing = new ArrayList<>();
        for (KycRequirements.Field field : set.definition().fields()) {
            if (field.required() && KycRequirements.applies(field.appliesWhen(), values) && !values.containsKey(field.key())) {
                missing.add(field.key());
            }
        }
        return missing;
    }

    /**
     * The exact content a consent and a submission cover: only the fields that apply, in a canonical form. A protected answer contributes the
     * hash of its stored ciphertext (a fresh nonce per save), so saving it again, even unchanged, makes an earlier consent out of date: the
     * safe direction, and no plaintext is needed.
     */
    private String answersHash(AppRow app, KycRequirements.RequirementSet set, Map<String, String> values) {
        Map<String, String> applicable = new TreeMap<>();
        Map<String, AnswerRow> rows = new HashMap<>();
        answerRows(app.id()).forEach(r -> rows.put(r.key(), r));
        for (KycRequirements.Field field : set.definition().fields()) {
            if (values.containsKey(field.key()) && KycRequirements.applies(field.appliesWhen(), values)) {
                AnswerRow row = rows.get(field.key());
                applicable.put(field.key(), row.sensitive() ? "protected:" + sha256(HexFormat.of().formatHex(row.ciphertext())) : values.get(field.key()));
            }
        }
        return fingerprints.fingerprintOf("KYC_ANSWERS", Map.of("applicationId", app.id(), "requirementSetVersion", set.version()), applicable);
    }

    private Map<String, Object> snapshot(AppRow app, KycRequirements.RequirementSet set, Map<String, String> values, UUID consentId, Instant now) {
        Map<String, Object> answers = new LinkedHashMap<>();
        Map<String, String> sources = new HashMap<>();
        answerRows(app.id()).forEach(r -> sources.put(r.key(), r.source()));
        for (KycRequirements.Field field : set.definition().fields()) {
            if (!values.containsKey(field.key()) || !KycRequirements.applies(field.appliesWhen(), values)) {
                continue;
            }
            Map<String, Object> entry = new LinkedHashMap<>();
            if (field.sensitive()) {
                entry.put("provided", true);
            } else {
                entry.put("value", values.get(field.key()));
            }
            entry.put("source", sources.get(field.key()));
            answers.put(field.key(), entry);
        }
        Map<String, Object> documents = new LinkedHashMap<>();
        jdbc.sql("select requirement_key, state from kyc_documents where application_id = :a order by requirement_key").param("a", app.id())
                .query((rs, row) -> Map.entry(rs.getString(1), rs.getString(2))).list().forEach(e -> documents.put(e.getKey(), e.getValue()));
        Map<String, Object> snapshot = new LinkedHashMap<>();
        snapshot.put("providerId", PROVIDER);
        snapshot.put("requirementSetVersion", set.version());
        snapshot.put("requirementSetProvisional", set.provisional());
        snapshot.put("submittedAt", now.toString());
        snapshot.put("consentId", consentId.toString());
        snapshot.put("answers", answers);
        snapshot.put("documents", documents);
        snapshot.put("note", "Submitted to OuPay for review. Not sent to Equity.");
        return snapshot;
    }

    private void bump(UUID applicationId, Instant now) {
        jdbc.sql("update kyc_applications set version = version + 1, updated_at = :now where id = :id").param("now", Timestamp.from(now)).param("id", applicationId).update();
    }

    private void event(UUID merchantId, UUID applicationId, String kind, UUID actor, KycApplicationStatus from, KycApplicationStatus to, String detail, Instant now) {
        jdbc.sql("insert into kyc_events (application_id, merchant_id, kind, actor_user_id, from_status, to_status, detail, created_at) "
                        + "values (:a, :m, :k, :u, :f, :t, :d, :now)")
                .param("a", applicationId).param("m", merchantId).param("k", kind).param("u", actor).param("f", from == null ? null : from.name())
                .param("t", to == null ? null : to.name()).param("d", detail).param("now", Timestamp.from(now)).update();
    }

    private void lock(String key) {
        jdbc.sql("select pg_advisory_xact_lock(hashtextextended(:key, 0))").param("key", key).query((rs, row) -> Boolean.TRUE).single();
    }

    private Instant now() {
        return clock.instant().truncatedTo(ChronoUnit.MICROS);
    }

    private static Instant instant(Timestamp timestamp) {
        return timestamp == null ? null : timestamp.toInstant();
    }

    private static String sha256(String text) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    private KycDtos.ApplicationDto toDto(AppRow app) {
        KycRequirements.RequirementSet set = set(app);
        Map<String, String> values = values(app);
        List<KycDtos.AnswerDto> answers = answerRows(app.id()).stream().map(r -> new KycDtos.AnswerDto(r.key(), r.sensitive(), r.sensitive() ? null : r.value(),
                true, r.sensitive() ? r.hint() : null, r.source())).toList();
        Map<String, KycDtos.DocumentDto> docState = new HashMap<>();
        jdbc.sql("select requirement_key, state, declared_ready_at from kyc_documents where application_id = :a").param("a", app.id())
                .query((rs, row) -> Map.entry(rs.getString(1), new Object[] {rs.getString(2), instant(rs.getTimestamp(3))})).list()
                .forEach(e -> docState.put(e.getKey(), new KycDtos.DocumentDto(e.getKey(), null, false, true, (String) e.getValue()[0], (Instant) e.getValue()[1], false)));
        List<KycDtos.DocumentDto> documents = new ArrayList<>();
        List<String> outstanding = new ArrayList<>();
        List<String> blocking = new ArrayList<>();
        for (KycRequirements.Document d : set.definition().documents()) {
            boolean applies = KycRequirements.applies(d.appliesWhen(), values);
            KycDtos.DocumentDto saved = docState.get(d.key());
            String state = saved == null ? "NOT_PROVIDED" : saved.state();
            documents.add(new KycDtos.DocumentDto(d.key(), d.label(), d.required(), applies, state, saved == null ? null : saved.declaredReadyAt(), false));
            if (applies && d.required() && !"STORED".equals(state)) {
                outstanding.add(d.key());
            }
            // A file that is mandatory at submission is satisfied only by a stored file, never by "ready".
            if (applies && d.requiredAtSubmission() && !"STORED".equals(state)) {
                blocking.add(d.key());
            }
        }
        String hash = app.status() == KycApplicationStatus.DRAFT || app.answersSha256() == null ? answersHash(app, set, values) : app.answersSha256();
        KycDtos.ConsentDto consent = jdbc.sql("select id, given_at, consent_text_version, requirement_set_version, consenting_name, answers_sha256 from kyc_consents "
                        + "where application_id = :a order by given_at desc limit 1").param("a", app.id())
                .query((rs, row) -> new KycDtos.ConsentDto(rs.getObject("id", UUID.class), instant(rs.getTimestamp("given_at")), rs.getString("consent_text_version"),
                        rs.getInt("requirement_set_version"), rs.getString("consenting_name"),
                        rs.getString("answers_sha256").equals(hash) && rs.getString("consent_text_version").equals(set.definition().consent().textVersion())))
                .optional().orElse(null);
        List<String> missing = app.status() == KycApplicationStatus.DRAFT ? missingFields(set, values) : List.of();
        String consentState = consent == null ? "NONE" : consent.current() ? "CURRENT" : "OUTDATED";
        boolean canSubmit = app.status() == KycApplicationStatus.DRAFT && missing.isEmpty() && blocking.isEmpty() && consent != null && consent.current();
        List<KycDtos.InformationRequestDto> requests = jdbc.sql("select id, message, field_key, status, requested_at, response_text, responded_at from kyc_information_requests "
                        + "where application_id = :a order by requested_at desc, id").param("a", app.id())
                .query((rs, row) -> new KycDtos.InformationRequestDto(rs.getObject("id", UUID.class), rs.getString("message"), rs.getString("field_key"),
                        rs.getString("status"), instant(rs.getTimestamp("requested_at")), rs.getString("response_text"), instant(rs.getTimestamp("responded_at"))))
                .list();
        return new KycDtos.ApplicationDto(app.id(), PROVIDER, app.status(), app.setVersion(), app.version(), app.createdAt(), app.updatedAt(), app.submittedAt(),
                app.handedOffAt(), app.decidedAt(), app.decisionReason(), answers, documents, consent, requests,
                new KycDtos.Readiness(missing, consentState, outstanding, app.status() == KycApplicationStatus.DRAFT ? blocking : List.of(), canSubmit));
    }
}
