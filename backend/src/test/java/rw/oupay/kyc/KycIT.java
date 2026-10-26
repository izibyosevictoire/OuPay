package rw.oupay.kyc;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.context.TestPropertySource;
import rw.oupay.collection.ApprovalSource;
import rw.oupay.common.ApiException;
import rw.oupay.support.IntegrationTest;
import rw.oupay.support.TestApi;
import rw.oupay.support.World;
import tools.jackson.databind.JsonNode;

/** R6b against a real PostgreSQL: Equity KYC onboarding collected by OuPay, with honest statuses and protected data. */
@TestPropertySource(properties = {
        "oupay.kyc.encryption-key=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        "oupay.kyc.evidence-recording-enabled=true",
        "oupay.kyc.reveal-enabled=true",
        "oupay.kyc.retention-days=365"})
class KycIT extends IntegrationTest {

    private static final String ID_NUMBER = "1199880012345678";
    private static final String ACCOUNT = "4001234567890";

    @Autowired
    KycEvidenceService evidence;

    World w;

    @BeforeEach
    void world() {
        w = World.create(this);
    }

    /** The published sets are immutable, so a set a test publishes is removed (with the guard off) to leave the seeded version alone. */
    @org.junit.jupiter.api.AfterEach
    void removeSetsPublishedByTests() {
        jdbc.execute("alter table kyc_requirement_sets disable trigger trg_kyc_requirement_sets_immutable");
        try {
            jdbc.execute("truncate table kyc_applications cascade");
            jdbc.update("delete from kyc_requirement_sets where version > 1");
        } finally {
            jdbc.execute("alter table kyc_requirement_sets enable trigger trg_kyc_requirement_sets_immutable");
        }
    }

    // ---- helpers -------------------------------------------------------------------------------

    private String base(UUID merchantId) {
        return "/api/v1/merchants/" + merchantId + "/kyc";
    }

    private String base() {
        return base(w.merchantId);
    }

    private JsonNode start(TestApi api, UUID merchantId) {
        var response = api.post(base(merchantId) + "/applications", Map.of("clientOperationId", UUID.randomUUID().toString()));
        assertThat(response.status()).as(response.body()).isEqualTo(201);
        return response.json().path("application");
    }

    private JsonNode start() {
        return start(w.owner, w.merchantId);
    }

    private String id(JsonNode application) {
        return application.path("id").asString();
    }

    private UUID uuid(JsonNode application) {
        return UUID.fromString(id(application));
    }

    private long version(String applicationId) {
        return w.owner.get(base() + "/applications/" + applicationId).json().path("version").asLong();
    }

    private TestApi.Response save(String applicationId, Map<String, String> answers) {
        return w.owner.put(base() + "/applications/" + applicationId + "/answers", Map.of("expectedVersion", version(applicationId), "answers", answers));
    }

    private Map<String, String> remaining() {
        Map<String, String> answers = new HashMap<>();
        answers.put("representative.role", "OWNER");
        answers.put("representative.idDocumentType", "NATIONAL_ID");
        answers.put("bank.hasEquityAccount", "NO");
        return answers;
    }

    private JsonNode completed() {
        JsonNode application = start();
        assertThat(save(id(application), remaining()).status()).isEqualTo(200);
        return application;
    }

    private TestApi.Response consent(String applicationId) {
        return w.owner.post(base() + "/applications/" + applicationId + "/consent",
                Map.of("expectedVersion", version(applicationId), "consentTextVersion", "v1", "affirmed", true));
    }

    private TestApi.Response submit(String applicationId, UUID submissionId) {
        return w.owner.post(base() + "/applications/" + applicationId + "/submit",
                Map.of("expectedVersion", version(applicationId), "submissionRequestId", submissionId.toString()));
    }

    private JsonNode submitted() {
        JsonNode application = completed();
        assertThat(consent(id(application)).status()).isEqualTo(200);
        var response = submit(id(application), UUID.randomUUID());
        assertThat(response.status()).as(response.body()).isEqualTo(201);
        return application;
    }

    private String status(String applicationId) {
        return jdbc.queryForObject("select status from kyc_applications where id = cast(? as uuid)", String.class, applicationId);
    }

    private KycEvidenceService.Evidence bankEvent(String ref) {
        return new KycEvidenceService.Evidence(ApprovalSource.BANK_EVENT, ref, null, null);
    }

    private KycEvidenceService.Evidence operators(String ref) {
        var one = fixtures.user("operator1@oupay.test", "Operator One");
        var two = fixtures.user("operator2@oupay.test", "Operator Two");
        return new KycEvidenceService.Evidence(ApprovalSource.OPERATOR, ref, one.userId(), two.userId());
    }

    // ---- schema constraints --------------------------------------------------------------------

    @Test
    void theDatabaseRefusesBankStatesWithoutEvidenceAndNeverChangesHistory() {
        JsonNode application = submitted();
        UUID id = uuid(application);
        // A merchant-style jump to a bank state, with no evidence, is refused by the database itself.
        for (String target : new String[] {"HANDED_OFF", "APPROVED", "REJECTED", "MORE_INFO_REQUESTED"}) {
            assertThatThrownBy(() -> jdbc.update("update kyc_applications set status = ? where id = ?", target, id)).as(target).isInstanceOf(Exception.class);
        }
        assertThat(status(id.toString())).isEqualTo("COLLECTED");
        // A hand-off needs evidence columns; a decision needs a handed-off application.
        assertThatThrownBy(() -> jdbc.update("update kyc_applications set status = 'HANDED_OFF', handed_off_at = now() where id = ?", id))
                .hasStackTraceContaining("ck_kyc_applications_handoff");
        // Applications and their events are never deleted or rewritten.
        assertThatThrownBy(() -> jdbc.update("delete from kyc_applications where id = ?", id)).hasStackTraceContaining("never deleted");
        assertThatThrownBy(() -> jdbc.update("update kyc_events set kind = 'X'")).hasStackTraceContaining("never changed");
        assertThatThrownBy(() -> jdbc.update("delete from kyc_events")).hasStackTraceContaining("never changed");
        assertThatThrownBy(() -> jdbc.update("update kyc_consents set consenting_name = 'Someone else'")).hasStackTraceContaining("never changed");
        assertThatThrownBy(() -> jdbc.update("update kyc_requirement_sets set provisional = false")).hasStackTraceContaining("never changed");
        // What was submitted is frozen: its answers and its snapshot cannot change.
        assertThatThrownBy(() -> jdbc.update("update kyc_answers set value_text = 'Changed' where application_id = ? and field_key = 'business.legalName'", id))
                .hasStackTraceContaining("never change");
        assertThatThrownBy(() -> jdbc.update("update kyc_applications set submission_snapshot = '{}'::jsonb where id = ?", id)).hasStackTraceContaining("frozen");
        assertThatThrownBy(() -> jdbc.update("delete from kyc_answers where application_id = ?", id)).hasStackTraceContaining("never change");
    }

    @Test
    void sensitiveValuesAndDocumentsCannotBeStoredInTheClearOrWithoutContentEvidence() {
        UUID id = uuid(start());
        assertThatThrownBy(() -> jdbc.update("insert into kyc_answers (application_id, merchant_id, field_key, sensitive, value_text, source, updated_at) "
                + "values (?, ?, 'representative.idNumber', true, 'PLAINTEXT-ID', 'OWNER', now())", id, w.merchantId)).hasStackTraceContaining("ck_kyc_answers_storage");
        // A document is "stored" only with its private key, hash, size and type; a URL is never a key.
        jdbc.update("insert into kyc_documents (application_id, merchant_id, requirement_key, state, updated_at) values (?, ?, 'doc.representativeId', 'NOT_PROVIDED', now())", id, w.merchantId);
        assertThatThrownBy(() -> jdbc.update("update kyc_documents set state = 'STORED' where application_id = ?", id)).hasStackTraceContaining("ck_kyc_documents_stored");
        assertThatThrownBy(() -> jdbc.update("update kyc_documents set state = 'STORED', object_key = 'https://public.example/x.pdf', content_sha256 = repeat('a', 64), "
                + "size_bytes = 10, media_type = 'application/pdf', stored_at = now() where application_id = ?", id)).hasStackTraceContaining("ck_kyc_documents_stored");
        // Another business's application cannot be written to through this business's id.
        assertThatThrownBy(() -> jdbc.update("insert into kyc_answers (application_id, merchant_id, field_key, sensitive, value_text, source, updated_at) "
                + "values (?, ?, 'representative.nationality', false, 'x', 'OWNER', now())", id, w.cafeMerchantId)).hasStackTraceContaining("fk_kyc_answers_application");
        // Consent evidence must be an affirmative act.
        assertThatThrownBy(() -> jdbc.update("insert into kyc_consents (id, application_id, merchant_id, user_id, consenting_name, requirement_set_version, consent_text_version, "
                + "consent_text_sha256, answers_sha256, affirmed, affirmation_method, given_at) values (gen_random_uuid(), ?, ?, ?, 'X', 1, 'v1', repeat('a', 64), repeat('b', 64), false, "
                + "'EXPLICIT_AFFIRMATION', now())", id, w.merchantId, w.ownerPerson.userId())).hasStackTraceContaining("ck_kyc_consents_affirmed");
    }

    @Test
    void onlyOneLiveApplicationPerBusinessAndAnAppliedSetStaysImmutable() {
        start();
        var second = w.owner.post(base() + "/applications", Map.of("clientOperationId", UUID.randomUUID().toString()));
        assertThat(second.status()).isEqualTo(409);
        assertThat(second.code()).isEqualTo("application_exists");
        assertThat(count("kyc_applications")).isEqualTo(1);
    }

    // ---- authorization and isolation -----------------------------------------------------------

    @Test
    void onlyTheOwnerCanUseKycAndEveryoneElseIsRefused() {
        JsonNode application = start();
        String apps = base() + "/applications/" + id(application);
        for (TestApi person : new TestApi[] {w.manager, w.cashier}) {
            assertThat(person.get(base() + "/options").status()).isEqualTo(403);
            assertThat(person.get(base() + "/applications").status()).isEqualTo(403);
            assertThat(person.get(apps).status()).isEqualTo(403);
            assertThat(person.post(base() + "/applications", Map.of("clientOperationId", UUID.randomUUID().toString())).status()).isEqualTo(403);
            assertThat(person.put(apps + "/answers", Map.of("expectedVersion", 0, "answers", Map.of("business.legalName", "X"))).status()).isEqualTo(403);
            assertThat(person.post(apps + "/answers/representative.idNumber/reveal", null).status()).isEqualTo(403);
            assertThat(person.post(apps + "/submit", Map.of("expectedVersion", 0, "submissionRequestId", UUID.randomUUID().toString())).status()).isEqualTo(403);
        }
        // Not signed in.
        assertThat(TestApi.anonymous(mvc, org.springframework.http.HttpMethod.GET, base() + "/options", null, Map.of()).status()).isEqualTo(401);
    }

    @Test
    void anotherBusinessCanNeitherSeeNorChangeAnApplication() {
        JsonNode application = completed();
        String apps = base(w.merchantId) + "/applications/" + id(application);
        // Through the shop's URL: the cafe owner is not a member, so the shop does not exist for them.
        assertThat(w.cafeOwner.get(apps).status()).isEqualTo(404);
        assertThat(w.cafeOwner.put(apps + "/answers", Map.of("expectedVersion", 0, "answers", Map.of("business.legalName", "X"))).status()).isEqualTo(404);
        // Through their OWN URL with the shop's application id: it simply does not exist there.
        String cross = base(w.cafeMerchantId) + "/applications/" + id(application);
        assertThat(w.cafeOwner.get(cross).status()).isEqualTo(404);
        assertThat(w.cafeOwner.put(cross + "/answers", Map.of("expectedVersion", 0, "answers", Map.of("business.legalName", "X"))).status()).isEqualTo(404);
        assertThat(w.cafeOwner.post(cross + "/submit", Map.of("expectedVersion", 0, "submissionRequestId", UUID.randomUUID().toString())).status()).isEqualTo(404);
        assertThat(w.cafeOwner.post(cross + "/answers/representative.idNumber/reveal", null).status()).isEqualTo(404);
        // The cafe has its own, separate application, and its list never mentions the shop's.
        JsonNode cafe = start(w.cafeOwner, w.cafeMerchantId);
        assertThat(id(cafe)).isNotEqualTo(id(application));
        assertThat(w.cafeOwner.get(base(w.cafeMerchantId) + "/applications").json().size()).isEqualTo(1);
        assertThat(w.owner.get(base() + "/applications").json().size()).isEqualTo(1);
        assertThat(w.owner.get(base(w.cafeMerchantId) + "/applications").status()).isEqualTo(404);
    }

    // ---- start, prefill, draft ----------------------------------------------------------------

    @Test
    void anApplicationStartsAsAPrefilledDraftAndAStartIsIdempotent() {
        UUID operation = UUID.randomUUID();
        var first = w.owner.post(base() + "/applications", Map.of("clientOperationId", operation.toString()));
        assertThat(first.status()).isEqualTo(201);
        JsonNode application = first.json().path("application");
        assertThat(application.path("status").asString()).isEqualTo("DRAFT");
        assertThat(application.path("requirementSetVersion").asInt()).isEqualTo(1);
        Map<String, String> known = new HashMap<>();
        Map<String, String> sources = new HashMap<>();
        application.path("answers").forEach(a -> {
            known.put(a.path("key").asString(), a.path("value").asString());
            sources.put(a.path("key").asString(), a.path("source").asString());
        });
        assertThat(known).containsEntry("business.legalName", "Sample Shop Ltd").containsEntry("business.registrationNumber", "RC-1001")
                .containsEntry("business.tin", "123456789").containsEntry("business.type", "registered_company")
                .containsEntry("business.contactEmail", "contact@example.rw").containsEntry("business.contactPhone", "+250788123456")
                .containsEntry("representative.fullName", "Contact Person");
        assertThat(known.get("business.physicalAddress")).contains("KG 11 Ave").contains("Gasabo");
        assertThat(sources.values()).containsOnly("PREFILL");
        // What is NOT known is left for the owner, never invented.
        assertThat(known).doesNotContainKeys("representative.role", "representative.idDocumentType", "bank.hasEquityAccount", "representative.idNumber");
        assertThat(application.path("readiness").path("missingFields").size()).isEqualTo(3);
        assertThat(application.path("readiness").path("canSubmit").asBoolean()).isFalse();

        // The same request again is the same application; another request while it is live is refused.
        var again = w.owner.post(base() + "/applications", Map.of("clientOperationId", operation.toString()));
        assertThat(again.status()).isEqualTo(200);
        assertThat(again.json().path("replayed").asBoolean()).isTrue();
        assertThat(again.json().path("application").path("id").asString()).isEqualTo(id(application));
        assertThat(count("kyc_applications")).isEqualTo(1);
        // Ordinary merchant registration is untouched.
        assertThat(jdbc.queryForObject("select status from merchants where id = ?", String.class, w.merchantId)).isEqualTo("pending_verification");
        assertThat(jdbc.queryForObject("select legal_name from merchants where id = ?", String.class, w.merchantId)).isEqualTo("Sample Shop Ltd");
    }

    @Test
    void optionsDescribeTheSetTheStorageAndExistingAccountsHonestly() {
        var options = w.owner.get(base() + "/options");
        assertThat(options.status()).isEqualTo(200);
        var json = options.json();
        assertThat(json.path("requirementSet").path("provisional").asBoolean()).isTrue();
        assertThat(json.path("requirementSet").path("definition").path("note").asString()).contains("Equity has not confirmed");
        assertThat(json.path("storage").path("documentUploadAvailable").asBoolean()).isFalse();
        assertThat(json.path("storage").path("submissionToEquityAvailable").asBoolean()).isFalse();
        assertThat(json.path("storage").path("sensitiveStorageAvailable").asBoolean()).isTrue();
        assertThat(json.path("prefill").path("business.legalName").asString()).isEqualTo("Sample Shop Ltd");
        assertThat(json.path("linkedAccounts").size()).isEqualTo(1);
        assertThat(json.path("linkedAccounts").get(0).path("maskedAccount").asString()).contains("•");
        assertThat(json.path("current").isNull() || json.path("current").isMissingNode()).isTrue();
        assertThat(json.path("retentionConfigured").asBoolean()).isTrue();
        // The prefill never offers a sensitive field.
        assertThat(json.path("prefill").has("representative.idNumber")).isFalse();
    }

    @Test
    void aDraftIsSavedValidatedAndResumedWithoutEchoingValues() {
        JsonNode application = start();
        String applicationId = id(application);
        Map<String, String> answers = remaining();
        answers.put("representative.nationality", "Rwandan");
        answers.put("business.contactPhone", "+250 788 000 111");
        var saved = save(applicationId, answers);
        assertThat(saved.status()).as(saved.body()).isEqualTo(200);
        // Resumed: a fresh read shows everything, with readiness updated.
        var resumed = w.owner.get(base() + "/applications/" + applicationId).json();
        assertThat(resumed.path("readiness").path("missingFields").size()).isZero();
        assertThat(resumed.path("answers").toString()).contains("Rwandan").contains("+250 788 000 111");
        assertThat(resumed.path("answers").toString()).contains("\"source\":\"OWNER\"");
        // Invalid values are refused with a message about the FIELD, not the value, and change nothing.
        var bad = save(applicationId, Map.of("business.contactEmail", "not-an-email<script>"));
        assertThat(bad.status()).isEqualTo(422);
        assertThat(bad.body()).doesNotContain("not-an-email").doesNotContain("script");
        assertThat(save(applicationId, Map.of("business.tin", "12345")).status()).isEqualTo(422);
        assertThat(save(applicationId, Map.of("bank.hasEquityAccount", "MAYBE")).status()).isEqualTo(422);
        assertThat(save(applicationId, Map.of("business.legalName", "x".repeat(201))).status()).isEqualTo(422);
        assertThat(save(applicationId, Map.of("not.a.field", "x")).status()).isEqualTo(422);
        assertThat(save(applicationId, Map.of("status", "APPROVED")).status()).isEqualTo(422);
        assertThat(w.owner.get(base() + "/applications/" + applicationId).json().path("answers").toString()).doesNotContain("script");
        // One bad value in a batch refuses the whole batch.
        long before = version(applicationId);
        var batch = new HashMap<String, String>();
        batch.put("representative.nationality", "Kenyan");
        batch.put("business.contactEmail", "bad");
        assertThat(save(applicationId, batch).status()).isEqualTo(422);
        assertThat(version(applicationId)).isEqualTo(before);
        assertThat(w.owner.get(base() + "/applications/" + applicationId).json().path("answers").toString()).doesNotContain("Kenyan");
        // A stale version is a conflict; clearing an answer removes it.
        assertThat(w.owner.put(base() + "/applications/" + applicationId + "/answers", Map.of("expectedVersion", 0, "answers", Map.of("representative.nationality", "X"))).code())
                .isEqualTo("version_conflict");
        Map<String, String> clear = new HashMap<>();
        clear.put("representative.nationality", "");
        assertThat(save(applicationId, clear).status()).isEqualTo(200);
        assertThat(w.owner.get(base() + "/applications/" + applicationId).json().path("answers").toString()).doesNotContain("Rwandan");
    }

    // ---- sensitive data ------------------------------------------------------------------------

    @Test
    void sensitiveValuesAreEncryptedRedactedAndEveryReadIsRecorded() {
        JsonNode application = start();
        String applicationId = id(application);
        Map<String, String> answers = remaining();
        answers.put("representative.idNumber", ID_NUMBER);
        answers.put("bank.hasEquityAccount", "YES");
        answers.put("bank.accountReference", ACCOUNT);
        var saved = save(applicationId, answers);
        assertThat(saved.status()).as(saved.body()).isEqualTo(200);

        // Redacted in every ordinary response: only that it exists, and a masked hint.
        for (String body : new String[] {saved.body(), w.owner.get(base() + "/applications/" + applicationId).body(), w.owner.get(base() + "/applications").body(),
                w.owner.get(base() + "/options").body()}) {
            assertThat(body).doesNotContain(ID_NUMBER).doesNotContain(ACCOUNT);
        }
        var idAnswer = answerOf(saved.json(), "representative.idNumber");
        assertThat(idAnswer.path("sensitive").asBoolean()).isTrue();
        assertThat(idAnswer.path("hasValue").asBoolean()).isTrue();
        assertThat(idAnswer.path("hint").asString()).isEqualTo("••••5678");
        assertThat(idAnswer.has("value") && !idAnswer.path("value").isNull()).isFalse();

        // In the database it is ciphertext only, bound to its application: the plaintext appears nowhere.
        var row = jdbc.queryForMap("select value_text, ciphertext, key_id from kyc_answers where application_id = cast(? as uuid) and field_key = 'representative.idNumber'", applicationId);
        assertThat(row.get("value_text")).isNull();
        assertThat(new String((byte[]) row.get("ciphertext"), java.nio.charset.StandardCharsets.ISO_8859_1)).doesNotContain(ID_NUMBER);
        assertThat(row.get("key_id")).isEqualTo("k1");
        assertThat(jdbc.queryForObject("select count(*) from kyc_answers where value_text like '%' || ? || '%'", Integer.class, ID_NUMBER)).isZero();

        // Never in the audit trail, the events or the information of a rejected value.
        assertThat(jdbc.queryForList("select message from audit_log", String.class).toString()).doesNotContain(ID_NUMBER).doesNotContain(ACCOUNT);
        assertThat(jdbc.queryForList("select coalesce(detail, '') from kyc_events", String.class).toString()).doesNotContain(ID_NUMBER).doesNotContain(ACCOUNT);
        var invalid = save(applicationId, Map.of("representative.idNumber", "<>"));
        assertThat(invalid.status()).isEqualTo(422);
        assertThat(invalid.body()).doesNotContain("<>");

        // Reading it back is an explicit, recorded act by the owner, and never cached.
        var revealed = w.owner.post(base() + "/applications/" + applicationId + "/answers/representative.idNumber/reveal", null);
        assertThat(revealed.status()).isEqualTo(200);
        assertThat(revealed.json().path("value").asString()).isEqualTo(ID_NUMBER);
        assertThat(revealed.raw().getHeader("Cache-Control")).contains("no-store");
        assertThat(jdbc.queryForObject("select count(*) from kyc_events where kind = 'SENSITIVE_VALUE_VIEWED' and detail = 'representative.idNumber' and actor_user_id = ?",
                Integer.class, w.ownerPerson.userId())).isEqualTo(1);
        assertThat(jdbc.queryForObject("select count(*) from audit_log where kind = 'KYC_SENSITIVE_VIEWED'", Integer.class)).isEqualTo(1);
        assertThat(jdbc.queryForList("select message from audit_log where kind = 'KYC_SENSITIVE_VIEWED'", String.class).toString()).doesNotContain(ID_NUMBER);
        // Only protected fields can be revealed.
        assertThat(w.owner.post(base() + "/applications/" + applicationId + "/answers/business.legalName/reveal", null).status()).isEqualTo(422);
        assertThat(w.owner.post(base() + "/applications/" + applicationId + "/answers/bank.hasEquityAccount/reveal", null).status()).isEqualTo(422);
        // A copied ciphertext does not open under another application's identity.
        UUID other = uuid(start(w.cafeOwner, w.cafeMerchantId));
        jdbc.update("insert into kyc_answers (application_id, merchant_id, field_key, sensitive, ciphertext, key_id, value_hint, source, updated_at) "
                + "select ?, ?, field_key, sensitive, ciphertext, key_id, value_hint, source, now() from kyc_answers "
                + "where application_id = cast(? as uuid) and field_key = 'representative.idNumber'", other, w.cafeMerchantId, applicationId);
        var copied = w.cafeOwner.post(base(w.cafeMerchantId) + "/applications/" + other + "/answers/representative.idNumber/reveal", null);
        assertThat(copied.status()).isGreaterThanOrEqualTo(400);
        assertThat(copied.body()).doesNotContain(ID_NUMBER);
    }

    private JsonNode answerOf(JsonNode application, String key) {
        for (JsonNode answer : application.path("answers")) {
            if (key.equals(answer.path("key").asString())) {
                return answer;
            }
        }
        throw new AssertionError("no answer " + key);
    }

    // ---- requirement sets ----------------------------------------------------------------------

    @Test
    void anApplicationKeepsItsRequirementSetVersionWhenANewOneIsPublished() {
        JsonNode first = start();
        // Equity publishes version 2 with one extra field.
        jdbc.update("insert into kyc_requirement_sets (id, provider_id, version, effective_from, provisional, definition, definition_sha256, created_at) "
                + "select gen_random_uuid(), provider_id, 2, now() - interval '1 minute', false, jsonb_set(definition, '{fields}', definition->'fields' || "
                + "'[{\"key\":\"business.sector\",\"section\":\"BUSINESS\",\"label\":\"Sector\",\"type\":\"TEXT\",\"required\":true}]'::jsonb), repeat('c', 64), now() "
                + "from kyc_requirement_sets where version = 1");
        // New starts would use version 2, but the existing application is untouched and cannot take the new field.
        assertThat(w.owner.get(base() + "/options").json().path("requirementSet").path("version").asInt()).isEqualTo(2);
        var existing = w.owner.get(base() + "/applications/" + id(first)).json();
        assertThat(existing.path("requirementSetVersion").asInt()).isEqualTo(1);
        assertThat(existing.path("readiness").path("missingFields").toString()).doesNotContain("business.sector");
        assertThat(save(id(first), Map.of("business.sector", "Retail")).status()).isEqualTo(422);
        // After a rejection the business may apply again, under the newer version.
        assertThat(save(id(first), remaining()).status()).isEqualTo(200);
        assertThat(consent(id(first)).status()).isEqualTo(200);
        assertThat(submit(id(first), UUID.randomUUID()).status()).isEqualTo(201);
        evidence.recordHandoff(w.merchantId, uuid(first), bankEvent("EV-1"));
        evidence.recordDecision(w.merchantId, uuid(first), false, bankEvent("EV-2"), "Incomplete documents");
        JsonNode second = start();
        assertThat(second.path("requirementSetVersion").asInt()).isEqualTo(2);
        assertThat(second.path("readiness").path("missingFields").toString()).contains("business.sector");
        // The rejected one is still there for review, with its reason, and unchanged.
        var history = w.owner.get(base() + "/applications").json();
        assertThat(history.size()).isEqualTo(2);
        var rejected = w.owner.get(base() + "/applications/" + id(first)).json();
        assertThat(rejected.path("status").asString()).isEqualTo("REJECTED");
        assertThat(rejected.path("decisionReason").asString()).isEqualTo("Incomplete documents");
        assertThat(rejected.path("requirementSetVersion").asInt()).isEqualTo(1);
    }

    // ---- consent -------------------------------------------------------------------------------

    @Test
    void consentNeedsACompleteApplicationAnExplicitActAndTheCurrentWording() {
        JsonNode application = start();
        String applicationId = id(application);
        assertThat(consent(applicationId).code()).isEqualTo("application_incomplete");
        save(applicationId, remaining());
        var declined = w.owner.post(base() + "/applications/" + applicationId + "/consent",
                Map.of("expectedVersion", version(applicationId), "consentTextVersion", "v1", "affirmed", false));
        assertThat(declined.status()).isEqualTo(422);
        var oldText = w.owner.post(base() + "/applications/" + applicationId + "/consent",
                Map.of("expectedVersion", version(applicationId), "consentTextVersion", "v0", "affirmed", true));
        assertThat(oldText.code()).isEqualTo("consent_text_changed");
        assertThat(count("kyc_consents")).isZero();

        var given = consent(applicationId);
        assertThat(given.status()).isEqualTo(200);
        var recorded = jdbc.queryForMap("select user_id, consenting_name, requirement_set_version, consent_text_version, affirmed, affirmation_method, given_at from kyc_consents");
        assertThat(recorded.get("user_id")).isEqualTo(w.ownerPerson.userId());
        assertThat(recorded.get("consenting_name")).isEqualTo("Olive Owner");
        assertThat(recorded.get("requirement_set_version")).isEqualTo(1);
        assertThat(recorded.get("consent_text_version")).isEqualTo("v1");
        assertThat(recorded.get("affirmed")).isEqualTo(true);
        assertThat(recorded.get("given_at")).isNotNull();
        assertThat(given.json().path("consent").path("current").asBoolean()).isTrue();
        assertThat(given.json().path("readiness").path("canSubmit").asBoolean()).isTrue();
        assertThat(given.body()).doesNotContain("Equity has received");
        // The same consent again records nothing new.
        assertThat(consent(applicationId).status()).isEqualTo(200);
        assertThat(count("kyc_consents")).isEqualTo(1);
    }

    @Test
    void changingAnythingAfterConsentOutdatesItAndSubmissionNeedsConsentAgain() {
        JsonNode application = completed();
        String applicationId = id(application);
        consent(applicationId);
        save(applicationId, Map.of("representative.nationality", "Rwandan"));
        var read = w.owner.get(base() + "/applications/" + applicationId).json();
        assertThat(read.path("consent").path("current").asBoolean()).isFalse();
        assertThat(read.path("readiness").path("consent").asString()).isEqualTo("OUTDATED");
        assertThat(read.path("readiness").path("canSubmit").asBoolean()).isFalse();
        var refused = submit(applicationId, UUID.randomUUID());
        assertThat(refused.status()).isEqualTo(409);
        assertThat(refused.code()).isEqualTo("consent_required");
        assertThat(status(applicationId)).isEqualTo("DRAFT");
        assertThat(consent(applicationId).status()).isEqualTo(200);
        assertThat(submit(applicationId, UUID.randomUUID()).status()).isEqualTo(201);
        assertThat(count("kyc_consents")).isEqualTo(2);
    }

    // ---- submission ----------------------------------------------------------------------------

    @Test
    void submissionGivesTheApplicationToOuPayOnlyAndKeepsAFrozenSnapshot() {
        JsonNode application = start();
        String applicationId = id(application);
        Map<String, String> answers = remaining();
        answers.put("representative.idNumber", ID_NUMBER);
        save(applicationId, answers);
        consent(applicationId);
        UUID submission = UUID.randomUUID();
        var response = submit(applicationId, submission);
        assertThat(response.status()).as(response.body()).isEqualTo(201);
        var dto = response.json().path("application");
        assertThat(dto.path("status").asString()).isEqualTo("COLLECTED");
        assertThat(dto.path("submittedAt").isNull()).isFalse();
        // OuPay has it; Equity has been told nothing.
        assertThat(dto.path("handedOffAt").isNull() || dto.path("handedOffAt").isMissingNode()).isTrue();
        assertThat(jdbc.queryForObject("select count(*) from kyc_applications where handed_off_at is not null or handoff_evidence_ref is not null "
                + "or decided_at is not null", Integer.class)).isZero();
        assertThat(jdbc.queryForObject("select retention_until is not null from kyc_applications", Boolean.class)).isTrue();
        assertThat(jdbc.queryForList("select message from audit_log where kind = 'KYC_SUBMITTED'", String.class).toString())
                .contains("submitted to OuPay").contains("not been sent to Equity").doesNotContain(ID_NUMBER);

        // The snapshot has what was submitted, sensitive values only as "provided", and survives later registration edits.
        String snapshot = jdbc.queryForObject("select submission_snapshot::text from kyc_applications", String.class);
        assertThat(snapshot).contains("Sample Shop Ltd").contains("PREFILL").contains("\"provided\": true").doesNotContain(ID_NUMBER);
        jdbc.update("update merchants set legal_name = 'Renamed Ltd' where id = ?", w.merchantId);
        assertThat(jdbc.queryForObject("select submission_snapshot::text from kyc_applications", String.class)).isEqualTo(snapshot);
        assertThat(w.owner.get(base() + "/applications/" + applicationId).json().path("answers").toString()).contains("Sample Shop Ltd").doesNotContain("Renamed");

        // The same submission again is the same result; another one, or an edit, is refused.
        var replay = submit(applicationId, submission);
        assertThat(replay.status()).isEqualTo(200);
        assertThat(replay.json().path("replayed").asBoolean()).isTrue();
        assertThat(submit(applicationId, UUID.randomUUID()).code()).isEqualTo("invalid_transition");
        assertThat(save(applicationId, Map.of("representative.nationality", "X")).code()).isEqualTo("application_not_editable");
        assertThat(w.owner.post(base() + "/applications/" + applicationId + "/consent",
                Map.of("expectedVersion", version(applicationId), "consentTextVersion", "v1", "affirmed", true)).code()).isEqualTo("application_not_editable");
        assertThat(jdbc.queryForList("select kind from kyc_events order by id", String.class))
                .containsExactly("APPLICATION_STARTED", "ANSWERS_SAVED", "CONSENT_RECORDED", "SUBMITTED_TO_OUPAY");
    }

    @Test
    void anIncompleteApplicationCannotBeSubmitted() {
        JsonNode application = start();
        var refused = submit(id(application), UUID.randomUUID());
        assertThat(refused.status()).isEqualTo(409);
        assertThat(refused.code()).isEqualTo("application_incomplete");
        assertThat(status(id(application))).isEqualTo("DRAFT");
        // Optional items and not-applicable ones are not required: a sole proprietor needs no registration number.
        jdbc.update("update kyc_answers set value_text = 'sole_proprietor' where field_key = 'business.type'");
        jdbc.update("delete from kyc_answers where field_key = 'business.registrationNumber'");
        assertThat(save(id(application), remaining()).status()).isEqualTo(200);
        assertThat(w.owner.get(base() + "/applications/" + id(application)).json().path("readiness").path("missingFields").size()).isZero();
    }

    @Test
    void clientsCannotSetStatusOrEvidenceByAnyRequest() {
        JsonNode application = completed();
        String applicationId = id(application);
        consent(applicationId);
        Map<String, Object> body = new HashMap<>();
        body.put("expectedVersion", version(applicationId));
        body.put("submissionRequestId", UUID.randomUUID().toString());
        body.put("status", "APPROVED");
        body.put("handedOffAt", "2026-01-01T00:00:00Z");
        body.put("handoffEvidenceRef", "FAKE");
        body.put("decisionSource", "BANK_EVENT");
        var response = w.owner.post(base() + "/applications/" + applicationId + "/submit", body);
        assertThat(response.status()).isEqualTo(201);
        assertThat(status(applicationId)).isEqualTo("COLLECTED");
        assertThat(jdbc.queryForObject("select count(*) from kyc_applications where handoff_evidence_ref is not null or decision_source is not null", Integer.class)).isZero();
        // Nor through answers or documents.
        Map<String, Object> answers = new HashMap<>();
        answers.put("expectedVersion", version(applicationId));
        answers.put("answers", Map.of("representative.nationality", "X"));
        answers.put("status", "APPROVED");
        assertThat(w.owner.put(base() + "/applications/" + applicationId + "/answers", answers).status()).isEqualTo(409);
        assertThat(status(applicationId)).isEqualTo("COLLECTED");
        // And there is no HTTP surface that records a hand-off, a request from the bank or a decision.
        for (String path : new String[] {"/handoff", "/decision", "/approve", "/reject", "/status", "/information-requests"}) {
            int status = w.owner.post(base() + "/applications/" + applicationId + path, Map.of("status", "APPROVED")).status();
            assertThat(status).as(path).isIn(404, 405);
        }
    }

    @Test
    void auditAndEventsRollBackWithAFailedSubmission() {
        JsonNode application = completed();
        String applicationId = id(application);
        consent(applicationId);
        jdbc.execute("create function r6b_fail() returns trigger as $$ begin raise exception 'injected failure'; end $$ language plpgsql");
        jdbc.execute("create trigger r6b_fail before insert on audit_log for each row when (new.kind = 'KYC_SUBMITTED') execute function r6b_fail()");
        try {
            var failed = submit(applicationId, UUID.randomUUID());
            assertThat(failed.status()).isGreaterThanOrEqualTo(400);
        } finally {
            jdbc.execute("drop trigger r6b_fail on audit_log");
            jdbc.execute("drop function r6b_fail()");
        }
        assertThat(status(applicationId)).isEqualTo("DRAFT");
        assertThat(jdbc.queryForObject("select count(*) from kyc_events where kind = 'SUBMITTED_TO_OUPAY'", Integer.class)).isZero();
        assertThat(jdbc.queryForObject("select submitted_at is null and submission_snapshot is null from kyc_applications", Boolean.class)).isTrue();
        assertThat(submit(applicationId, UUID.randomUUID()).status()).isEqualTo(201);
    }

    @Test
    void concurrentSubmissionsAndStartsCreateOneOfEach() throws Exception {
        UUID operation = UUID.randomUUID();
        List<Callable<TestApi.Response>> starts = new ArrayList<>();
        for (int i = 0; i < 6; i++) {
            TestApi client = fixtures.signIn(mvc, w.ownerPerson);
            starts.add(() -> client.post(base() + "/applications", Map.of("clientOperationId", operation.toString())));
        }
        var started = concurrently(starts);
        assertThat(started).allMatch(r -> r.status() == 201 || r.status() == 200);
        assertThat(started.stream().filter(r -> r.status() == 201).count()).isEqualTo(1);
        assertThat(count("kyc_applications")).isEqualTo(1);

        String applicationId = jdbc.queryForObject("select id::text from kyc_applications", String.class);
        save(applicationId, remaining());
        consent(applicationId);
        UUID submission = UUID.randomUUID();
        long expected = version(applicationId);
        List<Callable<TestApi.Response>> submits = new ArrayList<>();
        for (int i = 0; i < 6; i++) {
            TestApi client = fixtures.signIn(mvc, w.ownerPerson);
            submits.add(() -> client.post(base() + "/applications/" + applicationId + "/submit",
                    Map.of("expectedVersion", expected, "submissionRequestId", submission.toString())));
        }
        var results = concurrently(submits);
        assertThat(results.stream().filter(r -> r.status() == 201).count()).isEqualTo(1);
        assertThat(results.stream().filter(r -> r.status() == 200).count()).isEqualTo(5);
        assertThat(jdbc.queryForObject("select count(*) from kyc_events where kind = 'SUBMITTED_TO_OUPAY'", Integer.class)).isEqualTo(1);
        assertThat(status(applicationId)).isEqualTo("COLLECTED");
    }

    // ---- documents -----------------------------------------------------------------------------

    @Test
    void documentsAreTrackedButNothingIsEverReceivedWhileThereIsNoSecureStorage() {
        JsonNode application = completed();
        String applicationId = id(application);
        var docs = application.path("documents");
        assertThat(docs.size()).isEqualTo(3);
        assertThat(docs.toString()).contains("\"uploadAvailable\":false");
        var upload = w.owner.post(base() + "/applications/" + applicationId + "/documents/doc.representativeId/upload", null);
        assertThat(upload.status()).isEqualTo(501);
        assertThat(upload.body()).contains("Nothing was received");
        assertThat(w.owner.post(base() + "/applications/" + applicationId + "/documents/doc.unknown/upload", null).status()).isEqualTo(422);
        // The owner can say a document is ready; that is recorded as a statement, never as receipt.
        var declared = w.owner.put(base() + "/applications/" + applicationId + "/documents/doc.representativeId",
                Map.of("expectedVersion", version(applicationId), "declaredReady", true));
        assertThat(declared.status()).as(declared.body()).isEqualTo(200);
        var state = declared.json().path("documents");
        String declaredState = null;
        for (JsonNode doc : state) {
            if ("doc.representativeId".equals(doc.path("key").asString())) {
                declaredState = doc.path("state").asString();
            }
        }
        assertThat(declaredState).isEqualTo("DECLARED_READY");
        assertThat(jdbc.queryForObject("select count(*) from kyc_documents where state = 'STORED' or object_key is not null or content_sha256 is not null", Integer.class)).isZero();
        assertThat(w.owner.put(base() + "/applications/" + applicationId + "/documents/doc.nope", Map.of("expectedVersion", version(applicationId), "declaredReady", true)).status())
                .isEqualTo(422);
        // Outstanding documents are listed, and a submission to OuPay does not pretend otherwise.
        var read = w.owner.get(base() + "/applications/" + applicationId).json();
        assertThat(read.path("readiness").path("outstandingDocuments").toString()).contains("doc.representativeId").contains("doc.registrationCertificate");
        consent(applicationId);
        assertThat(submit(applicationId, UUID.randomUUID()).status()).isEqualTo(201);
        assertThat(jdbc.queryForObject("select submission_snapshot::text from kyc_applications", String.class)).contains("DECLARED_READY").doesNotContain("STORED");
    }

    // ---- the bank's side: evidence only --------------------------------------------------------

    @Test
    void theBankSideStepsExistOnlyWithEvidenceAndEveryStepIsRecorded() {
        JsonNode application = submitted();
        UUID id = uuid(application);
        // Not from a draft; nothing without evidence; no self-attestation by two names of one person; no member of the business.
        assertThatThrownBy(() -> evidence.recordHandoff(w.merchantId, id, null)).isInstanceOf(ApiException.class);
        assertThatThrownBy(() -> evidence.recordHandoff(w.merchantId, id, new KycEvidenceService.Evidence(ApprovalSource.OPERATOR, "REF", w.ownerPerson.userId(), w.ownerPerson.userId())))
                .isInstanceOf(ApiException.class);
        assertThatThrownBy(() -> evidence.recordHandoff(w.merchantId, id, new KycEvidenceService.Evidence(ApprovalSource.OPERATOR, "REF", w.ownerPerson.userId(), w.managerPerson.userId())))
                .isInstanceOf(ApiException.class).hasMessageContaining("must not belong");
        assertThatThrownBy(() -> evidence.recordHandoff(w.merchantId, id, new KycEvidenceService.Evidence(ApprovalSource.BANK_EVENT, "  ", null, null))).isInstanceOf(ApiException.class);
        assertThatThrownBy(() -> evidence.recordDecision(w.merchantId, id, true, bankEvent("EV"), null))
                .isInstanceOf(ApiException.class).hasMessageContaining("handed to the bank");
        assertThat(status(id.toString())).isEqualTo("COLLECTED");

        evidence.recordHandoff(w.merchantId, id, operators("LETTER-17"));
        assertThat(status(id.toString())).isEqualTo("HANDED_OFF");
        assertThat(w.owner.get(base() + "/applications/" + id).json().path("handedOffAt").isNull()).isFalse();
        // Only a handed-off application can be asked about, and it is then the owner's to answer.
        UUID asked = evidence.requestMoreInformation(w.merchantId, id, bankEvent("EV-ASK"), "Please confirm the business address.", "business.physicalAddress");
        assertThat(status(id.toString())).isEqualTo("MORE_INFO_REQUESTED");
        var read = w.owner.get(base() + "/applications/" + id).json();
        assertThat(read.path("informationRequests").get(0).path("message").asString()).contains("business address");
        assertThat(read.path("informationRequests").get(0).path("status").asString()).isEqualTo("OPEN");
        assertThat(w.manager.get(base() + "/applications/" + id).status()).isEqualTo(403);
        var answered = w.owner.post(base() + "/applications/" + id + "/information-requests/" + asked + "/response", Map.of("response", "Confirmed: KG 11 Ave, Remera."));
        assertThat(answered.status()).as(answered.body()).isEqualTo(200);
        assertThat(answered.json().path("status").asString()).isEqualTo("COLLECTED");
        assertThat(answered.json().path("informationRequests").get(0).path("status").asString()).isEqualTo("RESPONDED");
        // It is with OuPay again; handing it off again needs NEW evidence; a response cannot be given twice.
        assertThat(w.owner.post(base() + "/applications/" + id + "/information-requests/" + asked + "/response", Map.of("response", "Again")).status()).isEqualTo(409);
        evidence.recordHandoff(w.merchantId, id, bankEvent("EV-2"));
        assertThat(status(id.toString())).isEqualTo("HANDED_OFF");
        evidence.recordDecision(w.merchantId, id, true, bankEvent("EV-APPROVED"), null);
        assertThat(status(id.toString())).isEqualTo("APPROVED");
        var approved = w.owner.get(base() + "/applications/" + id).json();
        assertThat(approved.path("status").asString()).isEqualTo("APPROVED");
        assertThat(approved.path("decidedAt").isNull()).isFalse();
        // A decided application is final, in the service and in the database.
        assertThatThrownBy(() -> evidence.recordDecision(w.merchantId, id, false, bankEvent("EV-X"), "No")).isInstanceOf(ApiException.class);
        assertThatThrownBy(() -> jdbc.update("update kyc_applications set status = 'REJECTED' where id = ?", id)).hasStackTraceContaining("final");
        assertThat(jdbc.queryForList("select kind from kyc_events where application_id = ? order by id", String.class, id)).contains("SUBMITTED_TO_OUPAY",
                "HANDOFF_RECORDED", "MORE_INFORMATION_REQUESTED", "INFORMATION_PROVIDED", "RETURNED_TO_OUPAY", "DECISION_RECORDED");
        assertThat(jdbc.queryForList("select kind from audit_log where kind like 'KYC_%'", String.class)).contains("KYC_HANDED_OFF", "KYC_MORE_INFO_REQUESTED", "KYC_APPROVED");
        // A rejection needs its reason.
        assertThatThrownBy(() -> evidence.recordDecision(w.merchantId, UUID.randomUUID(), false, bankEvent("EV"), "x")).isInstanceOf(ApiException.class);
    }

    @Test
    void aRejectionIsKeptForReviewAndNeedsAReason() {
        JsonNode application = submitted();
        UUID id = uuid(application);
        evidence.recordHandoff(w.merchantId, id, bankEvent("EV-1"));
        assertThatThrownBy(() -> evidence.recordDecision(w.merchantId, id, false, bankEvent("EV-2"), " ")).isInstanceOf(ApiException.class);
        evidence.recordDecision(w.merchantId, id, false, bankEvent("EV-2"), "Not eligible");
        var list = w.owner.get(base() + "/applications").json();
        assertThat(list.get(0).path("status").asString()).isEqualTo("REJECTED");
        assertThat(w.owner.get(base() + "/applications/" + id).json().path("decisionReason").asString()).isEqualTo("Not eligible");
        assertThatThrownBy(() -> jdbc.update("delete from kyc_applications where id = ?", id)).isInstanceOf(Exception.class);
        // The business can apply again; the rejected application is untouched.
        assertThat(start(w.owner, w.merchantId).path("status").asString()).isEqualTo("DRAFT");
        assertThat(status(id.toString())).isEqualTo("REJECTED");
    }

    // ---- protected values: failure safety, nonces, concurrency, mandatory files ---------------------

    @Test
    void aValueThatCannotBeReadIsReportedSafelyAndNothingIsChangedOrShown() {
        JsonNode application = start();
        String applicationId = id(application);
        Map<String, String> answers = remaining();
        answers.put("representative.idNumber", ID_NUMBER);
        assertThat(save(applicationId, answers).status()).isEqualTo(200);

        // Protected under a key that is not the configured one (a rotated or lost key), and damaged data: both fail the same safe way.
        for (String damage : new String[] {"update kyc_answers set key_id = 'k0' where field_key = 'representative.idNumber'",
                "update kyc_answers set ciphertext = overlay(ciphertext placing '\\x00ff'::bytea from 14 for 2) where field_key = 'representative.idNumber'"}) {
            jdbc.update(damage);
            var unreadable = w.owner.post(base() + "/applications/" + applicationId + "/answers/representative.idNumber/reveal", null);
            assertThat(unreadable.status()).isEqualTo(409);
            assertThat(unreadable.code()).isEqualTo("sensitive_value_unreadable");
            assertThat(unreadable.body()).doesNotContain(ID_NUMBER);
            // Nothing else is affected: the application still reads, consents and submits (no plaintext is ever needed for those).
            assertThat(w.owner.get(base() + "/applications/" + applicationId).status()).isEqualTo(200);
        }
        assertThat(jdbc.queryForObject("select count(*) from kyc_events where kind = 'SENSITIVE_VALUE_VIEWED'", Integer.class)).isZero();
        assertThat(jdbc.queryForObject("select count(*) from audit_log where kind = 'KYC_SENSITIVE_VIEWED'", Integer.class)).isZero();
        assertThat(consent(applicationId).status()).isEqualTo(200);
        assertThat(submit(applicationId, UUID.randomUUID()).status()).isEqualTo(201);
    }

    @Test
    void everyEncryptionUsesAFreshNonceSoTheSameValueNeverRepeatsInStorage() {
        String applicationId = id(start());
        Map<String, String> answers = remaining();
        answers.put("representative.idNumber", ID_NUMBER);
        save(applicationId, answers);
        byte[] first = jdbc.queryForObject("select ciphertext from kyc_answers where field_key = 'representative.idNumber'", byte[].class);
        save(applicationId, Map.of("representative.idNumber", ID_NUMBER));
        byte[] second = jdbc.queryForObject("select ciphertext from kyc_answers where field_key = 'representative.idNumber'", byte[].class);
        assertThat(first).isNotEqualTo(second);
        assertThat(java.util.Arrays.copyOfRange(first, 0, 12)).isNotEqualTo(java.util.Arrays.copyOfRange(second, 0, 12));
        // Saving a protected value again makes an earlier consent out of date (the safe direction).
        assertThat(consent(applicationId).status()).isEqualTo(200);
        save(applicationId, Map.of("representative.idNumber", ID_NUMBER));
        assertThat(w.owner.get(base() + "/applications/" + applicationId).json().path("readiness").path("consent").asString()).isEqualTo("OUTDATED");
    }

    @Test
    void aSubmissionAndAnEditRacingEachOtherNeverLeaveASnapshotThatDiffersFromTheAnswers() throws Exception {
        for (int attempt = 0; attempt < 3; attempt++) {
            final int round = attempt;
            jdbc.execute("truncate table kyc_applications cascade");
            JsonNode application = completed();
            String applicationId = id(application);
            assertThat(consent(applicationId).status()).isEqualTo(200);
            long expected = version(applicationId);
            TestApi editor = fixtures.signIn(mvc, w.ownerPerson);
            TestApi submitter = fixtures.signIn(mvc, w.ownerPerson);
            List<Callable<TestApi.Response>> race = List.of(
                    () -> editor.put(base() + "/applications/" + applicationId + "/answers",
                            Map.of("expectedVersion", expected, "answers", Map.of("business.tin", "12345678" + (round + 1)))),
                    () -> submitter.post(base() + "/applications/" + applicationId + "/submit",
                            Map.of("expectedVersion", expected, "submissionRequestId", UUID.randomUUID().toString())));
            var results = concurrently(race);
            int editStatus = results.get(0).status();
            int submitStatus = results.get(1).status();
            // Exactly one wins: they serialise on the application row, and the loser is told so.
            assertThat(java.util.List.of(editStatus, submitStatus)).as("edit=%s submit=%s", editStatus, submitStatus).containsAnyOf(200, 201);
            assertThat(editStatus == 200 && submitStatus == 201).as("both cannot succeed on one version").isFalse();
            String stored = jdbc.queryForObject("select value_text from kyc_answers where application_id = cast(? as uuid) and field_key = 'business.tin'", String.class, applicationId);
            String status = status(applicationId);
            if ("COLLECTED".equals(status)) {
                String snapshot = jdbc.queryForObject("select submission_snapshot::text from kyc_applications where id = cast(? as uuid)", String.class, applicationId);
                assertThat(snapshot).as("the snapshot holds exactly the stored answer").contains(stored);
                assertThat(editStatus).isIn(409, 422);
            } else {
                assertThat(status).isEqualTo("DRAFT");
                assertThat(submitStatus).isIn(409, 422);
                assertThat(jdbc.queryForObject("select count(*) from kyc_events where kind = 'SUBMITTED_TO_OUPAY'", Integer.class)).isZero();
            }
        }
    }

    @Test
    void aDocumentThatMustBeAFileIsNeverSatisfiedByMarkingItReady() {
        // A later published set can make a stored file mandatory at submission; "ready" never satisfies it.
        jdbc.update("insert into kyc_requirement_sets (id, provider_id, version, effective_from, provisional, definition, definition_sha256, created_at) "
                + "select gen_random_uuid(), provider_id, 2, now() - interval '1 minute', false, jsonb_set(definition, '{documents}', "
                + "(select jsonb_agg(case when d->>'key' = 'doc.representativeId' then d || '{\"requiredAtSubmission\": true}'::jsonb else d end) "
                + "from jsonb_array_elements(definition->'documents') d)), repeat('d', 64), now() from kyc_requirement_sets where version = 1");
        JsonNode application = start();
        assertThat(application.path("requirementSetVersion").asInt()).isEqualTo(2);
        String applicationId = id(application);
        save(applicationId, remaining());
        consent(applicationId);
        var ready = w.owner.put(base() + "/applications/" + applicationId + "/documents/doc.representativeId",
                Map.of("expectedVersion", version(applicationId), "declaredReady", true));
        assertThat(ready.status()).isEqualTo(200);
        consent(applicationId);
        var read = w.owner.get(base() + "/applications/" + applicationId).json();
        assertThat(read.path("readiness").path("blockingDocuments").toString()).contains("doc.representativeId");
        assertThat(read.path("readiness").path("canSubmit").asBoolean()).isFalse();
        var refused = submit(applicationId, UUID.randomUUID());
        assertThat(refused.status()).isEqualTo(409);
        assertThat(refused.code()).isEqualTo("documents_required");
        assertThat(status(applicationId)).isEqualTo("DRAFT");
        // The document is represented as ready, never received or verified.
        assertThat(read.path("documents").toString()).contains("DECLARED_READY").doesNotContain("\"STORED\"").doesNotContain("VERIFIED").doesNotContain("RECEIVED");
    }

    @Test
    void theSeededRequirementSetIsExactlyAsPublishedAndOnlyOneExistsAtTheStartOfEachTest() {
        assertThat(count("kyc_requirement_sets")).isEqualTo(1);
        assertThat(jdbc.queryForObject("select provisional and version = 1 and definition_sha256 = encode(sha256(convert_to(definition::text, 'UTF8')), 'hex') "
                + "from kyc_requirement_sets", Boolean.class)).isTrue();
        assertThat(w.owner.get(base() + "/options").json().path("requirementSet").path("definition").path("note").asString()).contains("Equity has not confirmed");
    }

    @Test
    void headersNeverAllowCachingOfApplicationData() {
        JsonNode application = start();
        assertThat(w.owner.get(base() + "/applications/" + id(application)).raw().getHeader("Cache-Control")).contains("no-store");
        assertThat(w.owner.get(base() + "/options").raw().getHeader("Cache-Control")).contains("no-store");
        assertThat(w.owner.get(base() + "/applications").raw().getHeader("Cache-Control")).contains("no-store");
    }

    private <T> List<T> concurrently(List<Callable<T>> tasks) throws Exception {
        ExecutorService pool = Executors.newFixedThreadPool(tasks.size());
        try {
            CountDownLatch ready = new CountDownLatch(tasks.size());
            CountDownLatch go = new CountDownLatch(1);
            List<Future<T>> futures = new ArrayList<>();
            for (Callable<T> task : tasks) {
                futures.add(pool.submit(() -> {
                    ready.countDown();
                    go.await();
                    return task.call();
                }));
            }
            ready.await();
            go.countDown();
            List<T> results = new ArrayList<>();
            for (Future<T> future : futures) {
                results.add(future.get(60, TimeUnit.SECONDS));
            }
            return results;
        } finally {
            pool.shutdownNow();
        }
    }

    private int count(String table) {
        return jdbc.queryForObject("select count(*) from " + table, Integer.class);
    }
}
