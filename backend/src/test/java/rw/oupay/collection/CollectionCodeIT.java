package rw.oupay.collection;

import static org.assertj.core.api.Assertions.assertThat;

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
import rw.oupay.support.Bank;
import rw.oupay.support.IntegrationTest;
import rw.oupay.support.TestApi;
import rw.oupay.support.World;
import tools.jackson.databind.JsonNode;

/**
 * R6a: the internal collection-code registry through the real API and the trusted approval service. Approval is OFF by default (and refused at
 * startup in production); these tests switch it on to exercise the model, with operators who do not belong to the business.
 */
@TestPropertySource(properties = "oupay.collection-codes.approval-enabled=true")
class CollectionCodeIT extends IntegrationTest {

    @Autowired
    CollectionCodeApprovalService approvals;

    World w;
    UUID destination;
    UUID secondBranchId;
    UUID cashierMembership;
    UUID otherCashierMembership;
    UUID operatorA;
    UUID operatorB;

    @BeforeEach
    void world() {
        w = World.create(this);
        destination = jdbc.queryForObject("select id from payment_destinations where merchant_id = ?", UUID.class, w.merchantId);
        secondBranchId = fixtures.branch(w.merchantId, "RM02", "ACTIVE");
        cashierMembership = w.cashierMembershipId;
        otherCashierMembership = jdbc.queryForObject("select id from memberships where user_id = ? and merchant_id = ?", UUID.class,
                w.otherCashierPerson.userId(), w.merchantId);
        // Operators are people outside the business that owns the code.
        operatorA = w.cafePerson.userId();
        operatorB = fixtures.user("operator@oupay.test", "Platform Operator").userId();
    }

    // --- helpers ----------------------------------------------------------------------------------------

    private String base() {
        return base(w.merchantId);
    }

    private static String base(UUID merchantId) {
        return "/api/v1/merchants/" + merchantId + "/collection-codes";
    }

    private Map<String, Object> request(String label, UUID branchId) {
        Map<String, Object> body = new HashMap<>();
        body.put("clientOperationId", UUID.randomUUID().toString());
        body.put("settlementDestinationId", destination.toString());
        body.put("displayLabel", label);
        if (branchId != null) {
            body.put("branchId", branchId.toString());
        }
        return body;
    }

    private JsonNode requested(String label, UUID branchId) {
        var response = w.owner.post(base(), request(label, branchId));
        assertThat(response.status()).as(response.body()).isEqualTo(201);
        return response.json().path("code");
    }

    private JsonNode pending(String label, UUID branchId) {
        JsonNode code = requested(label, branchId);
        var response = w.owner.post(base() + "/" + id(code) + "/submission",
                Map.of("expectedVersion", code.path("version").asLong(), "bankRequestRef", "EQ-REQ-" + label));
        assertThat(response.status()).as(response.body()).isEqualTo(200);
        return response.json();
    }

    private static UUID uuid(String text) {
        return UUID.fromString(text);
    }

    private static String id(JsonNode code) {
        return code.path("id").asString();
    }

    private CollectionCodeApprovalService.Evidence operatorEvidence() {
        return new CollectionCodeApprovalService.Evidence(ApprovalSource.OPERATOR, "Equity letter EQ-2026-014", operatorA, operatorB);
    }

    /** A code the (simulated) bank flow approved, through the trusted service. */
    private JsonNode active(String label, UUID branchId, String bankCode) {
        JsonNode code = pending(label, branchId);
        approvals.approve(w.merchantId, uuid(id(code)), bankCode, operatorEvidence());
        return w.owner.get(base() + "/" + id(code)).json();
    }

    private TestApi.Response assign(TestApi api, JsonNode code, UUID membershipId) {
        return api.post(base() + "/" + id(code) + "/assignments", Map.of("membershipId", membershipId.toString()));
    }

    private TestApi.Response assignPoint(TestApi api, JsonNode code, String label) {
        return api.post(base() + "/" + id(code) + "/assignments", Map.of("collectionPointLabel", label));
    }

    private TestApi.Response end(TestApi api, JsonNode code, String assignmentId, String reason) {
        return api.post(base() + "/" + id(code) + "/assignments/end", Map.of("expectedAssignmentId", assignmentId, "reason", reason));
    }

    private TestApi.Response reassign(TestApi api, JsonNode code, String expected, UUID membershipId, String reason) {
        return api.post(base() + "/" + id(code) + "/reassign",
                Map.of("expectedAssignmentId", expected, "membershipId", membershipId.toString(), "reason", reason));
    }

    private JsonNode ok(TestApi.Response response, int status) {
        assertThat(response.status()).as(response.body()).isEqualTo(status);
        return response.json();
    }

    private long count(String table) {
        return jdbc.queryForObject("select count(*) from " + table, Long.class);
    }

    private long auditCount(String kind) {
        return jdbc.queryForObject("select count(*) from audit_log where kind = ?", Long.class, kind);
    }

    private static boolean isAbsent(JsonNode node) {
        return node.isMissingNode() || node.isNull();
    }

    private long openAssignments(JsonNode code) {
        return jdbc.queryForObject("select count(*) from collection_code_assignments where code_id = ? and valid_to is null", Long.class, uuid(id(code)));
    }

    private <T> List<T> runTogether(List<Callable<T>> tasks) throws Exception {
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

    // --- requesting a code ------------------------------------------------------------------------------

    @Test
    void aRequestedCodeIsOnlyAnInternalRecordNeverAPaymentCode() {
        JsonNode code = requested("Market stall", w.branchId);
        assertThat(code.path("status").asString()).isEqualTo("REQUESTED");
        assertThat(code.path("internalRef").asString()).matches("CC-[2-9A-HJKMNP-Z]{8}");
        assertThat(code.path("externalCodeState").asString()).isEqualTo("NOT_ISSUED");
        assertThat(isAbsent(code.path("externalCode"))).isTrue();
        assertThat(isAbsent(code.path("approval"))).isTrue();
        assertThat(code.path("payable").asBoolean()).isFalse();
        assertThat(code.path("simulated").asBoolean()).isTrue();
        assertThat(code.path("settlementAccountLabel").asString()).isEqualTo("Main account");
        assertThat(code.path("branchCode").asString()).isEqualTo("RM01");
        assertThat(auditCount("COLLECTION_CODE_REQUESTED")).isEqualTo(1);
        assertThat(jdbc.queryForObject("select external_code from collection_codes", String.class)).isNull();
        // Nothing was sent anywhere: no bank request is recorded.
        assertThat(isAbsent(code.path("bankRequestRef"))).isTrue();
    }

    @Test
    void aRepeatedRequestReturnsTheSameCodeAndAConflictingOneIsRefused() {
        Map<String, Object> body = request("Counter 1", w.branchId);
        var first = ok(w.owner.post(base(), body), 201);
        var again = ok(w.owner.post(base(), body), 200);
        assertThat(again.path("replayed").asBoolean()).isTrue();
        assertThat(id(again.path("code"))).isEqualTo(id(first.path("code")));
        assertThat(count("collection_codes")).isEqualTo(1);
        Map<String, Object> different = new HashMap<>(body);
        different.put("displayLabel", "Counter 2");
        var conflict = w.owner.post(base(), different);
        assertThat(conflict.status()).isEqualTo(409);
        assertThat(conflict.code()).isEqualTo("client_request_id_reuse");
        Map<String, Object> elsewhere = new HashMap<>(body);
        elsewhere.put("branchId", secondBranchId.toString());
        assertThat(w.owner.post(base(), elsewhere).code()).isEqualTo("client_request_id_reuse");
        assertThat(count("collection_codes")).isEqualTo(1);
    }

    @Test
    void concurrentIdenticalRequestsCreateOneCode() throws Exception {
        Map<String, Object> body = request("Racing", w.branchId);
        List<Callable<TestApi.Response>> tasks = new ArrayList<>();
        for (int i = 0; i < 5; i++) {
            tasks.add(() -> w.owner.post(base(), body));
        }
        List<TestApi.Response> results = runTogether(tasks);
        assertThat(results.stream().filter(r -> r.status() == 201).count()).isEqualTo(1);
        assertThat(results.stream().filter(r -> r.status() == 200).count()).isEqualTo(4);
        assertThat(count("collection_codes")).isEqualTo(1);
    }

    @Test
    void aRequestMustUseTheMerchantsOwnConnectedSettlementAccountAndAnActiveBranch() {
        // Another business's account.
        Bank.link(mvc, w.cafeOwner, w.cafeMerchantId);
        UUID cafeDestination = jdbc.queryForObject("select id from payment_destinations where merchant_id = ?", UUID.class, w.cafeMerchantId);
        Map<String, Object> foreign = request("Foreign", null);
        foreign.put("settlementDestinationId", cafeDestination.toString());
        assertThat(w.owner.post(base(), foreign).status()).isEqualTo(404);
        Map<String, Object> unknown = request("Unknown", null);
        unknown.put("settlementDestinationId", UUID.randomUUID().toString());
        assertThat(w.owner.post(base(), unknown).status()).isEqualTo(404);
        // A branch of another business, an inactive branch, a blank label.
        assertThat(w.owner.post(base(), request("Cafe branch", w.cafeBranchId)).status()).isEqualTo(404);
        var inactive = w.owner.post(base(), request("Closed", w.inactiveBranchId));
        assertThat(inactive.status()).isEqualTo(422);
        assertThat(inactive.code()).isEqualTo("branch_not_eligible");
        assertThat(w.owner.post(base(), request("   ", null)).status()).isEqualTo(422);
        // A settlement account whose connection is no longer connected.
        jdbc.update("update bank_connections set status = 'DISABLED' where merchant_id = ?", w.merchantId);
        var disabled = w.owner.post(base(), request("Disabled", null));
        assertThat(disabled.status()).isEqualTo(409);
        assertThat(disabled.code()).isEqualTo("settlement_account_unavailable");
        assertThat(count("collection_codes")).isZero();
    }

    // --- lifecycle --------------------------------------------------------------------------------------

    @Test
    void theOwnerCanRecordABankRequestButThatIsNotAnApproval() {
        JsonNode code = requested("Stall", w.branchId);
        var noRef = w.owner.post(base() + "/" + id(code) + "/submission", Map.of("expectedVersion", code.path("version").asLong(), "bankRequestRef", "  "));
        assertThat(noRef.status()).isEqualTo(422);
        JsonNode submitted = ok(w.owner.post(base() + "/" + id(code) + "/submission",
                Map.of("expectedVersion", code.path("version").asLong(), "bankRequestRef", "EQ-7781")), 200);
        assertThat(submitted.path("status").asString()).isEqualTo("REQUEST_DECLARED");
        assertThat(submitted.path("bankRequestRef").asString()).isEqualTo("EQ-7781");
        assertThat(submitted.path("externalCodeState").asString()).isEqualTo("NOT_ISSUED");
        assertThat(isAbsent(submitted.path("externalCode"))).isTrue();
        assertThat(submitted.path("payable").asBoolean()).isFalse();
        // Recording it twice is not a valid step.
        var twice = w.owner.post(base() + "/" + id(code) + "/submission",
                Map.of("expectedVersion", submitted.path("version").asLong(), "bankRequestRef", "EQ-7782"));
        assertThat(twice.code()).isEqualTo("code_status_invalid");
        // A stale view is a conflict.
        assertThat(w.owner.post(base() + "/" + id(code) + "/suspend", Map.of("expectedVersion", code.path("version").asLong(), "reason", "x")).code())
                .isEqualTo("version_conflict");
    }

    @Test
    void noMerchantEndpointCanApproveOrActivateOrSupplyABankIssuedCode() {
        JsonNode code = pending("Stall", w.branchId);
        for (String path : List.of("/approve", "/activate", "/external-code", "/status", "/resume")) {
            for (TestApi api : List.of(w.owner, w.manager)) {
                assertThat(api.post(base() + "/" + id(code) + path, Map.of("externalCode", "FAKE-1", "status", "ACTIVE")).status())
                        .as(path).isIn(404, 405);
                assertThat(api.put(base() + "/" + id(code) + path, Map.of("externalCode", "FAKE-1", "status", "ACTIVE")).status())
                        .as(path).isIn(404, 405);
            }
        }
        // Smuggled fields in the endpoints that do exist change nothing about approval.
        Map<String, Object> smuggled = new HashMap<>(Map.of("expectedVersion", code.path("version").asLong(), "bankRequestRef", "EQ-1"));
        smuggled.put("status", "ACTIVE");
        smuggled.put("externalCode", "FAKE-2");
        smuggled.put("approvalSource", "OPERATOR");
        var tried = w.owner.post(base() + "/" + id(code) + "/suspend", smuggled);
        assertThat(tried.status()).isIn(400, 409, 422);
        Map<String, Object> createSmuggled = request("Smuggle", null);
        createSmuggled.put("status", "ACTIVE");
        createSmuggled.put("externalCode", "FAKE-3");
        var created = w.owner.post(base(), createSmuggled);
        if (created.status() == 201) {
            assertThat(created.json().path("code").path("status").asString()).isEqualTo("REQUESTED");
            assertThat(isAbsent(created.json().path("code").path("externalCode"))).isTrue();
        }
        assertThat(jdbc.queryForObject("select count(*) from collection_codes where status = 'ACTIVE' or external_code is not null", Long.class)).isZero();
        assertThat(auditCount("COLLECTION_CODE_APPROVED")).isZero();
    }

    @Test
    void theTrustedApprovalActivatesACodeOnlyWithRealEvidence() {
        JsonNode code = pending("Stall", w.branchId);
        UUID codeId = uuid(id(code));
        // Not pending: refused.
        JsonNode fresh = requested("Fresh", w.branchId);
        assertCode("code_status_invalid", () -> approvals.approve(w.merchantId, uuid(id(fresh)), "TILL-1", operatorEvidence()));
        // Evidence rules.
        assertCode("validation", () -> approvals.approve(w.merchantId, codeId, "TILL-1", null));
        assertCode("validation", () -> approvals.approve(w.merchantId, codeId, "TILL-1",
                new CollectionCodeApprovalService.Evidence(ApprovalSource.OPERATOR, "  ", operatorA, operatorB)));
        assertCode("validation", () -> approvals.approve(w.merchantId, codeId, "TILL-1",
                new CollectionCodeApprovalService.Evidence(ApprovalSource.OPERATOR, "EV-1", operatorA, operatorA)));
        assertCode("validation", () -> approvals.approve(w.merchantId, codeId, "TILL-1",
                new CollectionCodeApprovalService.Evidence(ApprovalSource.OPERATOR, "EV-1", operatorA, null)));
        assertCode("validation", () -> approvals.approve(w.merchantId, codeId, "TILL-1",
                new CollectionCodeApprovalService.Evidence(ApprovalSource.OPERATOR, "EV-1", operatorA, UUID.randomUUID())));
        assertCode("validation", () -> approvals.approve(w.merchantId, codeId, "TILL-1",
                new CollectionCodeApprovalService.Evidence(ApprovalSource.BANK_EVENT, "EVT-1", operatorA, null)));
        // The bank-issued code itself.
        assertCode("validation", () -> approvals.approve(w.merchantId, codeId, "  ", operatorEvidence()));
        assertCode("validation", () -> approvals.approve(w.merchantId, codeId, code.path("internalRef").asString().toLowerCase(), operatorEvidence()));
        assertThat(w.owner.get(base() + "/" + id(code)).json().path("status").asString()).isEqualTo("REQUEST_DECLARED");

        approvals.approve(w.merchantId, codeId, "  TILL-1001 ", operatorEvidence());
        JsonNode approved = w.owner.get(base() + "/" + id(code)).json();
        assertThat(approved.path("status").asString()).isEqualTo("ACTIVE");
        assertThat(approved.path("externalCodeState").asString()).isEqualTo("BANK_APPROVED");
        assertThat(approved.path("externalCode").asString()).isEqualTo("TILL-1001");
        assertThat(approved.path("approval").path("source").asString()).isEqualTo("OPERATOR");
        assertThat(approved.path("approval").path("evidenceRef").asString()).isEqualTo("Equity letter EQ-2026-014");
        assertThat(approved.path("internalRef").asString()).isNotEqualTo("TILL-1001");
        // A simulated settlement account never yields a payable code, even when approved.
        assertThat(approved.path("simulated").asBoolean()).isTrue();
        assertThat(approved.path("payable").asBoolean()).isFalse();
        assertThat(auditCount("COLLECTION_CODE_APPROVED")).isEqualTo(1);
        // Approving again, or changing the code, is refused.
        assertCode("code_status_invalid", () -> approvals.approve(w.merchantId, codeId, "TILL-9999", operatorEvidence()));
    }

    private void assertCode(String code, Runnable call) {
        try {
            call.run();
        } catch (rw.oupay.common.ApiException e) {
            assertThat(e.code()).isEqualTo(code);
            return;
        }
        throw new AssertionError("expected " + code);
    }

    @Test
    void onlyANonSimulatedApprovedCodeIsPayableAndOnlyThenIsItShownToItsAgent() {
        jdbc.update("update payment_destinations set is_simulated = false where merchant_id = ?", w.merchantId);
        JsonNode code = active("Live stall", w.branchId, "TILL-2002");
        assertThat(code.path("simulated").asBoolean()).isFalse();
        // Bank-provisioned and real, but nobody holds it yet: not eligible for collection.
        assertThat(code.path("bankProvisioned").asBoolean()).isTrue();
        assertThat(code.path("payable").asBoolean()).isFalse();
        assertThat(code.path("eligibilityIssues").toString()).contains("NOT_ASSIGNED");
        ok(assign(w.owner, code, cashierMembership), 201);
        assertThat(w.owner.get(base() + "/" + id(code)).json().path("payable").asBoolean()).isTrue();
        var mine = w.cashier.get(base() + "/mine").json();
        assertThat(mine.path("code").path("payable").asBoolean()).isTrue();
        assertThat(mine.path("code").path("externalCode").asString()).isEqualTo("TILL-2002");

        // Suspending withdraws it at once.
        var suspended = ok(w.owner.post(base() + "/" + id(code) + "/suspend", Map.of("expectedVersion", code.path("version").asLong(), "reason", "Bank asked")), 200);
        assertThat(suspended.path("payable").asBoolean()).isFalse();
        var mineNow = w.cashier.get(base() + "/mine").json();
        assertThat(mineNow.path("code").path("payable").asBoolean()).isFalse();
        assertThat(isAbsent(mineNow.path("code").path("externalCode"))).isTrue();
        assertThat(mineNow.path("code").path("message").asString()).contains("suspended");
        // The owner cannot resume it: only the trusted process can.
        assertThat(w.owner.post(base() + "/" + id(code) + "/resume", Map.of("expectedVersion", suspended.path("version").asLong())).status()).isIn(404, 405);
        approvals.resume(w.merchantId, uuid(id(code)), "Equity email 2026-11-02", operatorA);
        assertThat(w.owner.get(base() + "/" + id(code)).json().path("payable").asBoolean()).isTrue();
    }

    /** A real (non-simulated), bank-approved code held by the cashier at the shop's branch: eligible for collection. */
    private JsonNode eligibleCode() {
        jdbc.update("update payment_destinations set is_simulated = false where merchant_id = ?", w.merchantId);
        JsonNode code = active("Eligible stall", w.branchId, "TILL-" + UUID.randomUUID().toString().substring(0, 8));
        ok(assign(w.owner, code, cashierMembership), 201);
        var detail = w.owner.get(base() + "/" + id(code)).json();
        assertThat(detail.path("payable").asBoolean()).as(detail.toString()).isTrue();
        assertThat(detail.path("eligibilityIssues").size()).isZero();
        return detail;
    }

    private JsonNode detail(JsonNode code) {
        return w.owner.get(base() + "/" + id(code)).json();
    }

    @Test
    void eligibilityForCollectionIsComputedLiveAndAnOpenAssignmentAloneNeverKeepsACodeUsable() {
        JsonNode code = eligibleCode();
        assertThat(w.cashier.get(base() + "/mine").json().path("code").path("externalCode").asString()).startsWith("TILL-");

        // 1. The agent's membership is suspended: the open assignment record remains, but the code is no longer eligible, and the agent loses it.
        jdbc.update("update memberships set status = 'SUSPENDED' where id = ?", cashierMembership);
        var suspendedAgent = detail(code);
        assertThat(suspendedAgent.path("payable").asBoolean()).isFalse();
        assertThat(suspendedAgent.path("eligibilityIssues").toString()).contains("ASSIGNEE_NOT_ACTIVE");
        assertThat(suspendedAgent.path("bankProvisioned").asBoolean()).isTrue();
        assertThat(isAbsent(suspendedAgent.path("currentAssignment"))).isFalse();
        assertThat(openAssignments(code)).isEqualTo(1);
        assertThat(w.cashier.get(base() + "/mine").status()).isIn(401, 404);
        jdbc.update("update memberships set status = 'REVOKED' where id = ?", cashierMembership);
        assertThat(detail(code).path("eligibilityIssues").toString()).contains("ASSIGNEE_NOT_ACTIVE");
        jdbc.update("update memberships set status = 'ACTIVE' where id = ?", cashierMembership);
        assertThat(detail(code).path("payable").asBoolean()).isTrue();

        // 2. The person's account is suspended.
        jdbc.update("update users set status = 'SUSPENDED' where id = ?", w.cashierPerson.userId());
        assertThat(detail(code).path("eligibilityIssues").toString()).contains("ASSIGNEE_NOT_ACTIVE");
        jdbc.update("update users set status = 'ACTIVE' where id = ?", w.cashierPerson.userId());

        // 3. The agent is no longer assigned to the branch.
        jdbc.update("update branch_assignments set status = 'ENDED', ended_at = now() where membership_id = ? and branch_id = ?", cashierMembership, w.branchId);
        assertThat(detail(code).path("eligibilityIssues").toString()).contains("ASSIGNEE_NOT_AT_BRANCH");
        assertThat(w.cashier.get(base() + "/mine").json().path("code").path("payable").asBoolean()).isFalse();
        assertThat(isAbsent(w.cashier.get(base() + "/mine").json().path("code").path("externalCode"))).isTrue();
        jdbc.update("update branch_assignments set status = 'ACTIVE', ended_at = null where membership_id = ? and branch_id = ?", cashierMembership, w.branchId);

        // 4. The branch is deactivated.
        jdbc.update("update branches set status = 'INACTIVE' where id = ?", w.branchId);
        assertThat(detail(code).path("eligibilityIssues").toString()).contains("BRANCH_INACTIVE");
        jdbc.update("update branches set status = 'ACTIVE' where id = ?", w.branchId);

        // 5. The settlement account is no longer connected.
        jdbc.update("update bank_connections set status = 'DISABLED' where merchant_id = ?", w.merchantId);
        assertThat(detail(code).path("eligibilityIssues").toString()).contains("SETTLEMENT_ACCOUNT_NOT_CONNECTED");
        assertThat(w.cashier.get(base() + "/mine").json().path("code").path("message").asString()).contains("settlement account");
        jdbc.update("update bank_connections set status = 'CONNECTED' where merchant_id = ?", w.merchantId);

        // 6. The code is suspended by the owner.
        assertThat(detail(code).path("payable").asBoolean()).isTrue();
        ok(w.owner.post(base() + "/" + id(code) + "/suspend", Map.of("expectedVersion", detail(code).path("version").asLong(), "reason", "Pause")), 200);
        assertThat(detail(code).path("eligibilityIssues").toString()).contains("NOT_BANK_APPROVED");

        // Through all of it the assignment history was neither deleted nor rewritten.
        var history = w.owner.get(base() + "/" + id(code) + "/assignments").json().path("items");
        assertThat(history.size()).isEqualTo(1);
        assertThat(history.get(0).path("assigneeName").asString()).isEqualTo(w.cashierPerson.fullName());
        assertThat(isAbsent(history.get(0).path("validTo"))).isTrue();
    }

    @Test
    void aCodeIsNeverEligibleForTwoAgentsAtOnceAndAPointNeedsNoPersonChecks() {
        JsonNode code = eligibleCode();
        var current = detail(code).path("currentAssignment");
        // Reassigning leaves exactly one eligible holder: the previous agent has no open assignment any more.
        ok(reassign(w.owner, code, current.path("id").asString(), otherCashierMembership, "Shift"), 200);
        assertThat(openAssignments(code)).isEqualTo(1);
        assertThat(detail(code).path("payable").asBoolean()).isTrue();
        assertThat(w.cashier.get(base() + "/mine").json().path("code").path("payable").isMissingNode()).isTrue();
        assertThat(w.otherCashier.get(base() + "/mine").json().path("code").path("payable").asBoolean()).isTrue();
        // A collection point has no person: only the code, account and branch conditions apply.
        JsonNode point = active("Point stall", w.branchId, "TILL-POINT-1");
        ok(assignPoint(w.owner, point, "Market stall 4"), 201);
        assertThat(detail(point).path("payable").asBoolean()).isTrue();
        jdbc.update("update branches set status = 'INACTIVE' where id = ?", w.branchId);
        assertThat(detail(point).path("eligibilityIssues").toString()).contains("BRANCH_INACTIVE");
    }

    @Test
    void aSimulatedCodeIsNeverEligibleWhateverElseIsTrue() {
        JsonNode code = active("Sim stall", w.branchId, "TILL-SIM-1");
        ok(assign(w.owner, code, cashierMembership), 201);
        var detail = detail(code);
        assertThat(detail.path("bankProvisioned").asBoolean()).isFalse();
        assertThat(detail.path("payable").asBoolean()).isFalse();
        assertThat(detail.path("eligibilityIssues").toString()).contains("SIMULATED");
        assertThat(isAbsent(w.cashier.get(base() + "/mine").json().path("code").path("externalCode"))).isTrue();
    }

    @Test
    void evidenceAndBankRequestReferencesAreVisibleToOwnersOnly() {
        JsonNode code = active("Stall", w.branchId, "TILL-EVID-1");
        var owner = detail(code);
        assertThat(owner.path("approval").path("evidenceRef").asString()).isEqualTo("Equity letter EQ-2026-014");
        assertThat(owner.path("bankRequestRef").asString()).startsWith("EQ-REQ-");
        for (var view : List.of(w.manager.get(base() + "/" + id(code)).json(), w.manager.get(base()).json().path("items").get(0))) {
            assertThat(view.path("approval").path("source").asString()).isEqualTo("OPERATOR");
            assertThat(isAbsent(view.path("approval").path("evidenceRef"))).isTrue();
            assertThat(isAbsent(view.path("bankRequestRef"))).isTrue();
            assertThat(view.toString()).doesNotContain("Equity letter").doesNotContain("EQ-REQ-");
        }
        // Nor does the audit trail carry the evidence reference.
        assertThat(String.join("\n", jdbc.queryForList("select message from audit_log", String.class))).doesNotContain("Equity letter").doesNotContain("EQ-REQ-");
        // Nothing exposes a full account identifier, an operator id or a credential.
        String everything = w.owner.get(base() + "/" + id(code)).body() + w.owner.get(base() + "/options").body();
        assertThat(everything).doesNotContain(operatorA.toString()).doesNotContain(operatorB.toString()).doesNotContain("secret");
    }

    @Test
    void aReplayedRequestRechecksAuthorisationBeforeAnythingIsReturned() {
        Map<String, Object> body = request("Counter", w.branchId);
        ok(w.owner.post(base(), body), 201);
        var byManager = w.manager.post(base(), body);
        assertThat(byManager.status()).isEqualTo(403);
        assertThat(byManager.body()).doesNotContain("internalRef").doesNotContain("CC-");
        assertThat(w.cashier.post(base(), body).status()).isEqualTo(403);
        assertThat(w.cafeOwner.post(base(), body).status()).isEqualTo(404);
        assertThat(new TestApi(mvc).post(base(), body).status()).isIn(401, 403);
        assertThat(w.owner.post(base(), body).status()).isEqualTo(200);
    }

    @Test
    void aMemberOfTheBusinessCanNeverApproveItsOwnCode() {
        JsonNode code = pending("Stall", w.branchId);
        UUID codeId = uuid(id(code));
        // The business's own staff are not independent of it, whatever the evidence.
        assertCode("validation", () -> approvals.approve(w.merchantId, codeId, "TILL-OWN-1",
                new CollectionCodeApprovalService.Evidence(ApprovalSource.OPERATOR, "EV", w.ownerPerson.userId(), operatorB)));
        assertCode("validation", () -> approvals.approve(w.merchantId, codeId, "TILL-OWN-1",
                new CollectionCodeApprovalService.Evidence(ApprovalSource.OPERATOR, "EV", operatorA, w.managerPerson.userId())));
        assertThat(detail(code).path("status").asString()).isEqualTo("REQUEST_DECLARED");
    }

    @Test
    void aSimulatedCodeNeverShowsABankCodeToItsAgent() {
        JsonNode code = active("Sim stall", w.branchId, "TILL-3003");
        ok(assign(w.owner, code, cashierMembership), 201);
        var mine = w.cashier.get(base() + "/mine").json().path("code");
        assertThat(mine.path("simulated").asBoolean()).isTrue();
        assertThat(mine.path("payable").asBoolean()).isFalse();
        assertThat(isAbsent(mine.path("externalCode"))).isTrue();
        assertThat(mine.path("message").asString()).contains("simulated");
    }

    @Test
    void aBankIssuedCodeBelongsToOneCodeForEverEvenAfterDeactivation() {
        JsonNode first = active("Stall A", w.branchId, "TILL-5005");
        JsonNode second = pending("Stall B", w.branchId);
        assertCode("external_code_taken", () -> approvals.approve(w.merchantId, uuid(id(second)), "till-5005", operatorEvidence()));
        ok(w.owner.post(base() + "/" + id(first) + "/deactivate", Map.of("expectedVersion", first.path("version").asLong(), "reason", "Closed")), 200);
        // The identity stays reserved: it cannot be reattributed to another code of this merchant ...
        assertCode("external_code_taken", () -> approvals.approve(w.merchantId, uuid(id(second)), "TILL-5005", operatorEvidence()));
        // ... or to a code of another merchant.
        Bank.link(mvc, w.cafeOwner, w.cafeMerchantId);
        UUID cafeDestination = jdbc.queryForObject("select id from payment_destinations where merchant_id = ?", UUID.class, w.cafeMerchantId);
        var cafeCode = w.cafeOwner.post(base(w.cafeMerchantId), Map.of("clientOperationId", UUID.randomUUID().toString(),
                "settlementDestinationId", cafeDestination.toString(), "displayLabel", "Cafe till")).json().path("code");
        w.cafeOwner.post(base(w.cafeMerchantId) + "/" + id(cafeCode) + "/submission", Map.of("expectedVersion", 0, "bankRequestRef", "EQ-CAFE"));
        assertCode("external_code_taken", () -> approvals.approve(w.cafeMerchantId, uuid(id(cafeCode)), "TILL-5005", new CollectionCodeApprovalService.Evidence(
                ApprovalSource.OPERATOR, "EV-9", w.ownerPerson.userId(), w.managerPerson.userId())));
        // A deactivated code is final.
        var after = w.owner.get(base() + "/" + id(first)).json();
        assertThat(after.path("status").asString()).isEqualTo("DEACTIVATED");
        assertThat(w.owner.post(base() + "/" + id(first) + "/suspend", Map.of("expectedVersion", after.path("version").asLong(), "reason", "x")).code())
                .isEqualTo("code_status_invalid");
        assertThat(assign(w.owner, after, cashierMembership).code()).isEqualTo("code_status_invalid");
    }

    @Test
    void rejectedAndDeactivatedCodesAreFinalAndEndTheirAssignment() {
        JsonNode code = requested("Doomed", w.branchId);
        ok(assign(w.owner, code, cashierMembership), 201);
        approvals.reject(w.merchantId, uuid(id(code)), "Bank declined", null);
        var rejected = w.owner.get(base() + "/" + id(code)).json();
        assertThat(rejected.path("status").asString()).isEqualTo("REJECTED");
        assertThat(rejected.path("statusReason").asString()).isEqualTo("Bank declined");
        assertThat(openAssignments(code)).isZero();
        assertCode("code_status_invalid", () -> approvals.reject(w.merchantId, uuid(id(code)), "again", null));

        JsonNode other = requested("Other", w.branchId);
        var held = ok(assign(w.owner, other, cashierMembership), 201);
        var deactivated = ok(w.owner.post(base() + "/" + id(other) + "/deactivate", Map.of("expectedVersion", other.path("version").asLong(), "reason", "Closed")), 200);
        assertThat(deactivated.path("status").asString()).isEqualTo("DEACTIVATED");
        assertThat(isAbsent(deactivated.path("currentAssignment"))).isTrue();
        var history = w.owner.get(base() + "/" + id(other) + "/assignments").json().path("items");
        assertThat(history.size()).isEqualTo(1);
        assertThat(history.get(0).path("id").asString()).isEqualTo(held.path("id").asString());
        assertThat(history.get(0).path("endReason").asString()).isEqualTo("Collection code deactivated");
        assertThat(history.get(0).path("endedByName").asString()).isEqualTo(w.ownerPerson.fullName());
    }

    // --- authorisation and isolation --------------------------------------------------------------------

    @Test
    void ownersProvisionManagersAssignOnlyTheirBranchesAndCashiersSeeOnlyTheirOwnCode() {
        JsonNode atBranch = requested("Branch code", w.branchId);
        JsonNode elsewhere = requested("Other branch code", secondBranchId);
        JsonNode noBranch = requested("Unbound code", null);
        // Provisioning is the owner's.
        assertThat(w.manager.post(base(), request("Mgr", w.branchId)).status()).isEqualTo(403);
        assertThat(w.cashier.post(base(), request("Cash", w.branchId)).status()).isEqualTo(403);
        assertThat(w.manager.post(base() + "/" + id(atBranch) + "/submission", Map.of("expectedVersion", 0, "bankRequestRef", "x")).status()).isEqualTo(403);
        assertThat(w.manager.post(base() + "/" + id(atBranch) + "/suspend", Map.of("expectedVersion", 0, "reason", "x")).status()).isEqualTo(403);
        assertThat(w.manager.post(base() + "/" + id(atBranch) + "/deactivate", Map.of("expectedVersion", 0, "reason", "x")).status()).isEqualTo(403);
        // Viewing: owner and manager yes, cashier no (they have /mine).
        assertThat(w.manager.get(base()).status()).isEqualTo(200);
        assertThat(w.manager.get(base() + "/" + id(atBranch)).status()).isEqualTo(200);
        assertThat(w.manager.get(base() + "/options").status()).isEqualTo(200);
        assertThat(w.cashier.get(base()).status()).isEqualTo(403);
        assertThat(w.cashier.get(base() + "/" + id(atBranch)).status()).isEqualTo(403);
        assertThat(w.cashier.get(base() + "/" + id(atBranch) + "/assignments").status()).isEqualTo(403);
        assertThat(w.cashier.get(base() + "/options").status()).isEqualTo(403);
        assertThat(w.cashier.get(base() + "/mine").status()).isEqualTo(200);
        // Assigning: the manager where assigned, never elsewhere, never for a code with no branch, never a cashier.
        ok(assign(w.manager, atBranch, cashierMembership), 201);
        assertThat(assign(w.manager, elsewhere, cashierMembership).status()).isEqualTo(403);
        assertThat(assign(w.manager, noBranch, cashierMembership).status()).isEqualTo(403);
        assertThat(assign(w.cashier, noBranch, cashierMembership).status()).isEqualTo(403);
        ok(assignPoint(w.owner, noBranch, "Market stall 4"), 201);
        assertThat(openAssignments(elsewhere)).isZero();
    }

    @Test
    void anotherBusinessCannotSeeOrChangeAnything() {
        JsonNode code = requested("Shop code", w.branchId);
        ok(assign(w.owner, code, cashierMembership), 201);
        for (String path : List.of("", "/options", "/mine", "/" + id(code), "/" + id(code) + "/assignments")) {
            assertThat(w.cafeOwner.get(base() + path).status()).as(path).isEqualTo(404);
        }
        assertThat(w.cafeOwner.post(base(), request("Intruder", null)).status()).isEqualTo(404);
        assertThat(assign(w.cafeOwner, code, otherCashierMembership).status()).isEqualTo(404);
        // Through its own URL the shop's code, destination and staff simply do not exist.
        Bank.link(mvc, w.cafeOwner, w.cafeMerchantId);
        UUID cafeDestination = jdbc.queryForObject("select id from payment_destinations where merchant_id = ?", UUID.class, w.cafeMerchantId);
        var cafeCode = w.cafeOwner.post(base(w.cafeMerchantId), Map.of("clientOperationId", UUID.randomUUID().toString(),
                "settlementDestinationId", cafeDestination.toString(), "displayLabel", "Cafe till")).json().path("code");
        assertThat(w.cafeOwner.get(base(w.cafeMerchantId) + "/" + id(code)).status()).isEqualTo(404);
        var staffOfAnother = w.cafeOwner.post(base(w.cafeMerchantId) + "/" + id(cafeCode) + "/assignments",
                Map.of("membershipId", cashierMembership.toString()));
        assertThat(staffOfAnother.status()).isEqualTo(422);
        assertThat(staffOfAnother.code()).isEqualTo("assignee_not_eligible");
        assertThat(w.cafeOwner.get(base(w.cafeMerchantId)).json().path("items").size()).isEqualTo(1);
        assertThat(w.cafeOwner.get(base(w.cafeMerchantId) + "/mine").json().path("code").isMissingNode()).isTrue();
        assertThat(new TestApi(mvc).get(base()).status()).isEqualTo(401);
    }

    // --- assignments ------------------------------------------------------------------------------------

    @Test
    void assigningSnapshotsWhoHoldsTheCodeAndAllowsOnlyOneAgent() {
        JsonNode code = requested("Stall", w.branchId);
        var assignment = ok(assign(w.owner, code, cashierMembership), 201);
        assertThat(assignment.path("assigneeKind").asString()).isEqualTo("MEMBER");
        assertThat(assignment.path("assigneeName").asString()).isEqualTo(w.cashierPerson.fullName());
        assertThat(assignment.path("assigneeRole").asString()).isEqualTo("CASHIER");
        assertThat(assignment.path("branchCode").asString()).isEqualTo("RM01");
        assertThat(assignment.path("assignedByName").asString()).isEqualTo(w.ownerPerson.fullName());
        assertThat(assignment.path("assigneeCurrentStatus").asString()).isEqualTo("ACTIVE");
        assertThat(isAbsent(assignment.path("validTo"))).isTrue();
        var again = assign(w.owner, code, otherCashierMembership);
        assertThat(again.status()).isEqualTo(409);
        assertThat(again.code()).isEqualTo("already_assigned");
        assertThat(openAssignments(code)).isEqualTo(1);
        var detail = w.owner.get(base() + "/" + id(code)).json();
        assertThat(detail.path("currentAssignment").path("assigneeName").asString()).isEqualTo(w.cashierPerson.fullName());
        assertThat(auditCount("COLLECTION_CODE_ASSIGNED")).isEqualTo(1);
    }

    @Test
    void onlyEligibleStaffCanBeAssigned() {
        JsonNode code = requested("Stall", w.branchId);
        // Not at the code's branch.
        JsonNode elsewhere = requested("Elsewhere", secondBranchId);
        assertThat(assign(w.owner, elsewhere, cashierMembership).code()).isEqualTo("assignee_not_eligible");
        // Unknown member, both kinds, neither kind, a mismatching branch.
        assertThat(assign(w.owner, code, UUID.randomUUID()).code()).isEqualTo("assignee_not_eligible");
        assertThat(w.owner.post(base() + "/" + id(code) + "/assignments",
                Map.of("membershipId", cashierMembership.toString(), "collectionPointLabel", "Stall")).status()).isEqualTo(422);
        assertThat(w.owner.post(base() + "/" + id(code) + "/assignments", Map.of()).status()).isEqualTo(422);
        assertThat(w.owner.post(base() + "/" + id(code) + "/assignments",
                Map.of("membershipId", cashierMembership.toString(), "branchId", secondBranchId.toString())).code()).isEqualTo("branch_not_eligible");
        // An inactive branch for a branchless code.
        JsonNode unbound = requested("Unbound", null);
        assertThat(w.owner.post(base() + "/" + id(unbound) + "/assignments",
                Map.of("collectionPointLabel", "Old shop", "branchId", w.inactiveBranchId.toString())).code()).isEqualTo("branch_not_eligible");
        // Suspended, revoked, invited members.
        for (String status : List.of("SUSPENDED", "REVOKED", "INVITED")) {
            jdbc.update("update memberships set status = ? where id = ?", status, cashierMembership);
            var refused = assign(w.owner, code, cashierMembership);
            assertThat(refused.status()).as(status).isEqualTo(422);
            assertThat(refused.code()).isEqualTo("assignee_not_eligible");
        }
        jdbc.update("update memberships set status = 'ACTIVE' where id = ?", cashierMembership);
        // A person whose account is suspended.
        jdbc.update("update users set status = 'SUSPENDED' where id = ?", w.cashierPerson.userId());
        assertThat(assign(w.owner, code, cashierMembership).code()).isEqualTo("assignee_not_eligible");
        jdbc.update("update users set status = 'ACTIVE' where id = ?", w.cashierPerson.userId());
        assertThat(openAssignments(code)).isZero();
        ok(assign(w.owner, code, cashierMembership), 201);
    }

    @Test
    void aCollectionPointCanHoldACodeAndEndingRecordsWhoAndWhy() {
        JsonNode code = requested("Kiosk", null);
        var point = ok(assignPoint(w.owner, code, "Market stall 4"), 201);
        assertThat(point.path("assigneeKind").asString()).isEqualTo("COLLECTION_POINT");
        assertThat(point.path("collectionPointLabel").asString()).isEqualTo("Market stall 4");
        assertThat(isAbsent(point.path("membershipId"))).isTrue();
        assertThat(end(w.owner, code, UUID.randomUUID().toString(), "Stall closed").code()).isEqualTo("assignment_changed");
        var ended = ok(end(w.owner, code, point.path("id").asString(), "Stall closed"), 200);
        assertThat(ended.path("endReason").asString()).isEqualTo("Stall closed");
        assertThat(ended.path("endedByName").asString()).isEqualTo(w.ownerPerson.fullName());
        assertThat(isAbsent(ended.path("validTo"))).isFalse();
        var nothing = end(w.owner, code, point.path("id").asString(), "Again");
        assertThat(nothing.status()).isEqualTo(409);
        assertThat(nothing.code()).isEqualTo("no_open_assignment");
        assertThat(end(w.owner, code, point.path("id").asString(), " ").status()).isEqualTo(422);
        assertThat(auditCount("COLLECTION_CODE_ASSIGNMENT_ENDED")).isEqualTo(1);
    }

    @Test
    void reassignmentEndsThePreviousAgentAndStartsTheNextAtomically() {
        JsonNode code = requested("Stall", w.branchId);
        var first = ok(assign(w.owner, code, cashierMembership), 201);
        var second = ok(reassign(w.owner, code, first.path("id").asString(), otherCashierMembership, "Shift change"), 200);
        assertThat(second.path("assigneeName").asString()).isEqualTo(w.otherCashierPerson.fullName());
        var history = w.owner.get(base() + "/" + id(code) + "/assignments").json().path("items");
        assertThat(history.size()).isEqualTo(2);
        assertThat(history.get(0).path("id").asString()).isEqualTo(second.path("id").asString());
        assertThat(isAbsent(history.get(0).path("validTo"))).isTrue();
        assertThat(history.get(1).path("id").asString()).isEqualTo(first.path("id").asString());
        assertThat(history.get(1).path("endReason").asString()).isEqualTo("Shift change");
        // The periods meet exactly, with no gap and no overlap.
        assertThat(history.get(1).path("validTo").asString()).isEqualTo(history.get(0).path("validFrom").asString());
        assertThat(openAssignments(code)).isEqualTo(1);
        assertThat(auditCount("COLLECTION_CODE_REASSIGNED")).isEqualTo(1);
        // Same agent again, a stale view, an ineligible target.
        assertThat(reassign(w.owner, code, second.path("id").asString(), otherCashierMembership, "Same").code()).isEqualTo("already_assigned");
        assertThat(reassign(w.owner, code, first.path("id").asString(), cashierMembership, "Stale").code()).isEqualTo("assignment_changed");
        jdbc.update("update memberships set status = 'SUSPENDED' where id = ?", cashierMembership);
        var refused = reassign(w.owner, code, second.path("id").asString(), cashierMembership, "Back");
        assertThat(refused.code()).isEqualTo("assignee_not_eligible");
        // The failed reassignment left the current agent in place: nothing was ended.
        assertThat(openAssignments(code)).isEqualTo(1);
        assertThat(w.owner.get(base() + "/" + id(code)).json().path("currentAssignment").path("id").asString()).isEqualTo(second.path("id").asString());
        assertThat(w.owner.get(base() + "/" + id(code) + "/assignments").json().path("items").size()).isEqualTo(2);
    }

    @Test
    void concurrentAssignmentsOfOneCodeCreateExactlyOneOpenAssignment() throws Exception {
        JsonNode code = requested("Contested", w.branchId);
        List<Callable<TestApi.Response>> tasks = new ArrayList<>();
        for (int i = 0; i < 6; i++) {
            TestApi api = i % 2 == 0 ? w.owner : w.manager;
            UUID member = i % 2 == 0 ? cashierMembership : otherCashierMembership;
            tasks.add(() -> assign(api, code, member));
        }
        List<TestApi.Response> results = runTogether(tasks);
        assertThat(results.stream().filter(r -> r.status() == 201).count()).isEqualTo(1);
        assertThat(results.stream().filter(r -> r.status() == 409 && "already_assigned".equals(r.code())).count()).isEqualTo(5);
        assertThat(openAssignments(code)).isEqualTo(1);
        assertThat(count("collection_code_assignments")).isEqualTo(1);
    }

    @Test
    void concurrentReassignmentsFromTheSameViewHaveOneWinner() throws Exception {
        JsonNode code = requested("Contested", w.branchId);
        var current = ok(assign(w.owner, code, cashierMembership), 201);
        UUID third = w.managerMembershipId;
        List<Callable<TestApi.Response>> tasks = new ArrayList<>();
        for (int i = 0; i < 4; i++) {
            UUID target = i % 2 == 0 ? otherCashierMembership : third;
            tasks.add(() -> reassign(w.owner, code, current.path("id").asString(), target, "Race"));
        }
        List<TestApi.Response> results = runTogether(tasks);
        assertThat(results.stream().filter(r -> r.status() == 200).count()).isEqualTo(1);
        assertThat(results.stream().filter(r -> r.status() == 409 && "assignment_changed".equals(r.code())).count()).isEqualTo(3);
        assertThat(openAssignments(code)).isEqualTo(1);
        assertThat(count("collection_code_assignments")).isEqualTo(2);
    }

    @Test
    void staffChangesNeverRewriteHistoricalAttribution() {
        JsonNode code = requested("Stall", w.branchId);
        ok(assign(w.owner, code, cashierMembership), 201);
        // The person is renamed, demoted and suspended; the branch is renamed.
        jdbc.update("update users set full_name = 'Renamed Person' where id = ?", w.cashierPerson.userId());
        jdbc.update("update memberships set role = 'MANAGER' where id = ?", cashierMembership);
        jdbc.update("update branches set name = 'Renamed Branch' where id = ?", w.branchId);
        jdbc.update("update memberships set status = 'SUSPENDED' where id = ?", cashierMembership);
        var detail = w.owner.get(base() + "/" + id(code)).json().path("currentAssignment");
        // The snapshot is what was true when the assignment was made ...
        assertThat(detail.path("assigneeName").asString()).isEqualTo(w.cashierPerson.fullName());
        assertThat(detail.path("assigneeRole").asString()).isEqualTo("CASHIER");
        assertThat(detail.path("branchName").asString()).isEqualTo("Branch RM01");
        // ... and the person's CURRENT status is reported alongside it, so the owner can act.
        assertThat(detail.path("assigneeCurrentStatus").asString()).isEqualTo("SUSPENDED");
        // A suspended agent no longer sees the code as theirs.
        assertThat(w.cashier.get(base() + "/mine").status()).isIn(401, 404);
        // The owner reassigns; the old row is untouched apart from being ended.
        var history = w.owner.get(base() + "/" + id(code) + "/assignments").json().path("items");
        assertThat(history.get(0).path("assigneeName").asString()).isEqualTo(w.cashierPerson.fullName());
        ok(reassign(w.owner, code, detail.path("id").asString(), otherCashierMembership, "Agent suspended"), 200);
        var after = w.owner.get(base() + "/" + id(code) + "/assignments").json().path("items");
        assertThat(after.get(1).path("assigneeName").asString()).isEqualTo(w.cashierPerson.fullName());
        assertThat(after.get(1).path("assigneeRole").asString()).isEqualTo("CASHIER");
    }

    @Test
    void anAgentSeesOnlyTheirOwnCodeAndNeverAPendingOne() {
        // A real (non-simulated) account, so the message describes the code's status rather than the simulation.
        jdbc.update("update payment_destinations set is_simulated = false where merchant_id = ?", w.merchantId);
        JsonNode mine = pending("My stall", w.branchId);
        JsonNode theirs = requested("Their stall", w.branchId);
        ok(assign(w.owner, mine, cashierMembership), 201);
        ok(assign(w.owner, theirs, otherCashierMembership), 201);
        var view = w.cashier.get(base() + "/mine").json();
        assertThat(view.path("code").path("id").asString()).isEqualTo(id(mine));
        assertThat(view.path("code").path("status").asString()).isEqualTo("REQUEST_DECLARED");
        assertThat(view.path("code").path("payable").asBoolean()).isFalse();
        assertThat(isAbsent(view.path("code").path("externalCode"))).isTrue();
        assertThat(view.path("code").path("message").asString()).contains("has not confirmed");
        assertThat(view.toString()).doesNotContain(id(theirs)).doesNotContain("Their stall");
        var none = w.manager.get(base() + "/mine").json();
        assertThat(isAbsent(none.path("code"))).isTrue();
        assertThat(isAbsent(none.path("assignment"))).isTrue();
    }

    // --- reads ------------------------------------------------------------------------------------------

    @Test
    void listsAreKeysetPagedAndFiltered() {
        List<JsonNode> created = new ArrayList<>();
        for (int i = 1; i <= 5; i++) {
            created.add(requested("Counter " + i, i % 2 == 0 ? secondBranchId : w.branchId));
        }
        ok(w.owner.post(base() + "/" + id(created.get(0)) + "/submission", Map.of("expectedVersion", 0, "bankRequestRef", "R1")), 200);
        var first = w.owner.get(base() + "?limit=2").json();
        assertThat(first.path("items").size()).isEqualTo(2);
        List<String> seen = new ArrayList<>();
        List<java.time.Instant> times = new ArrayList<>();
        first.path("items").forEach(c -> {
            seen.add(id(c));
            times.add(java.time.Instant.parse(c.path("createdAt").asString()));
        });
        String cursor = first.path("nextCursor").asString();
        while (!cursor.isEmpty()) {
            var next = w.owner.get(base() + "?limit=2&cursor=" + cursor).json();
            next.path("items").forEach(c -> {
                seen.add(id(c));
                times.add(java.time.Instant.parse(c.path("createdAt").asString()));
            });
            cursor = isAbsent(next.path("nextCursor")) ? "" : next.path("nextCursor").asString();
        }
        assertThat(seen).hasSize(5).doesNotHaveDuplicates();
        // Rows created in one clock tick are ordered by id, so what must hold is that creation times never increase down the list.
        for (int i = 1; i < times.size(); i++) {
            assertThat(times.get(i).isAfter(times.get(i - 1))).isFalse();
        }
        assertThat(w.owner.get(base() + "?status=REQUEST_DECLARED").json().path("items").size()).isEqualTo(1);
        assertThat(w.owner.get(base() + "?status=REQUESTED").json().path("items").size()).isEqualTo(4);
        assertThat(w.owner.get(base() + "?branchId=" + secondBranchId).json().path("items").size()).isEqualTo(2);
        assertThat(w.owner.get(base() + "?q=counter 3").json().path("items").size()).isEqualTo(1);
        String ref = created.get(2).path("internalRef").asString();
        assertThat(w.owner.get(base() + "?q=" + ref.toLowerCase()).json().path("items").size()).isEqualTo(1);
        assertThat(w.owner.get(base() + "?q=%").json().path("items").size()).isZero();
        assertThat(w.owner.get(base() + "?cursor=garbage").status()).isEqualTo(400);
        assertThat(w.owner.get(base() + "?status=BOGUS").status()).isEqualTo(400);
        assertThat(w.owner.get(base() + "/" + UUID.randomUUID()).status()).isEqualTo(404);
    }

    @Test
    void historyIsPagedNewestFirst() {
        JsonNode code = requested("Busy", w.branchId);
        var current = ok(assign(w.owner, code, cashierMembership), 201);
        for (int i = 0; i < 4; i++) {
            UUID next = i % 2 == 0 ? otherCashierMembership : cashierMembership;
            current = ok(reassign(w.owner, code, current.path("id").asString(), next, "Rotation " + i), 200);
        }
        var page = w.owner.get(base() + "/" + id(code) + "/assignments?limit=2").json();
        assertThat(page.path("items").size()).isEqualTo(2);
        assertThat(isAbsent(page.path("items").get(0).path("validTo"))).isTrue();
        List<String> seen = new ArrayList<>();
        page.path("items").forEach(a -> seen.add(a.path("id").asString()));
        String cursor = page.path("nextCursor").asString();
        while (!cursor.isEmpty()) {
            var next = w.owner.get(base() + "/" + id(code) + "/assignments?limit=2&cursor=" + cursor).json();
            next.path("items").forEach(a -> seen.add(a.path("id").asString()));
            cursor = isAbsent(next.path("nextCursor")) ? "" : next.path("nextCursor").asString();
        }
        assertThat(seen).hasSize(5).doesNotHaveDuplicates();
        // Period boundaries: every period starts strictly after the one before it started, and exactly when that one ended (no gap, no overlap),
        // however fast the rotations were made.
        var all = w.owner.get(base() + "/" + id(code) + "/assignments?limit=10").json().path("items");
        assertThat(all.size()).isEqualTo(5);
        for (int i = 0; i < all.size() - 1; i++) {
            var newer = all.get(i);
            var older = all.get(i + 1);
            assertThat(java.time.Instant.parse(newer.path("validFrom").asString())).isAfter(java.time.Instant.parse(older.path("validFrom").asString()));
            assertThat(older.path("validTo").asString()).isEqualTo(newer.path("validFrom").asString());
        }
    }

    @Test
    void optionsListOnlyWhatTheMerchantOwns() {
        var options = w.owner.get(base() + "/options").json();
        assertThat(options.path("destinations").size()).isEqualTo(1);
        assertThat(options.path("destinations").get(0).path("id").asString()).isEqualTo(destination.toString());
        assertThat(options.path("destinations").get(0).path("connectionStatus").asString()).isEqualTo("CONNECTED");
        assertThat(options.path("branches").size()).isGreaterThanOrEqualTo(3);
        boolean sawCashier = false;
        for (JsonNode member : options.path("members")) {
            assertThat(member.path("role").asString()).isIn("OWNER", "MANAGER", "CASHIER");
            if (member.path("membershipId").asString().equals(cashierMembership.toString())) {
                sawCashier = true;
                assertThat(member.path("branchIds").size()).isEqualTo(1);
            }
        }
        assertThat(sawCashier).isTrue();
        assertThat(options.toString()).doesNotContain(w.cafeMerchantId.toString());
    }

    // --- audit and rollback -----------------------------------------------------------------------------

    @Test
    void aFailureWhileAuditingRollsBackAnAssignmentAndARequest() {
        JsonNode code = requested("Stall", w.branchId);
        Map<String, Object> body = request("Second", w.branchId);
        jdbc.execute("create function fail_code_audit() returns trigger as $$ begin raise exception 'audit refused'; end; $$ language plpgsql");
        jdbc.execute("create trigger trg_fail_code_audit before insert on audit_log for each row "
                + "when (new.kind in ('COLLECTION_CODE_ASSIGNED', 'COLLECTION_CODE_REQUESTED')) execute function fail_code_audit()");
        try {
            assertThat(assign(w.owner, code, cashierMembership).status()).isGreaterThanOrEqualTo(400);
            assertThat(w.owner.post(base(), body).status()).isGreaterThanOrEqualTo(400);
            assertThat(count("collection_code_assignments")).isZero();
            assertThat(count("collection_codes")).isEqualTo(1);
        } finally {
            jdbc.execute("drop trigger trg_fail_code_audit on audit_log");
            jdbc.execute("drop function fail_code_audit()");
        }
        // Nothing was reserved by the failures: the same requests succeed once auditing works.
        ok(assign(w.owner, code, cashierMembership), 201);
        ok(w.owner.post(base(), body), 201);
        assertThat(count("collection_codes")).isEqualTo(2);
    }

    @Test
    void everyChangeIsAudited() {
        JsonNode code = pending("Stall", w.branchId);
        var held = ok(assign(w.owner, code, cashierMembership), 201);
        ok(reassign(w.owner, code, held.path("id").asString(), otherCashierMembership, "Swap"), 200);
        var current = w.owner.get(base() + "/" + id(code)).json();
        ok(end(w.owner, code, current.path("currentAssignment").path("id").asString(), "Done"), 200);
        approvals.approve(w.merchantId, uuid(id(code)), "TILL-7007", operatorEvidence());
        var latest = w.owner.get(base() + "/" + id(code)).json();
        ok(w.owner.post(base() + "/" + id(code) + "/suspend", Map.of("expectedVersion", latest.path("version").asLong(), "reason", "Paused")), 200);
        for (String kind : List.of("COLLECTION_CODE_REQUESTED", "COLLECTION_CODE_BANK_REQUEST_RECORDED", "COLLECTION_CODE_ASSIGNED", "COLLECTION_CODE_REASSIGNED",
                "COLLECTION_CODE_ASSIGNMENT_ENDED", "COLLECTION_CODE_APPROVED", "COLLECTION_CODE_SUSPENDED")) {
            assertThat(auditCount(kind)).as(kind).isEqualTo(1);
        }
        assertThat(jdbc.queryForObject("select actor_user_id from audit_log where kind = 'COLLECTION_CODE_APPROVED'", UUID.class))
                .isEqualTo(operatorA);
        // Refused operations leave no trace.
        long audits = count("audit_log");
        assign(w.cashier, code, cashierMembership);
        w.manager.post(base(), request("Nope", null));
        assertThat(count("audit_log")).isEqualTo(audits);
    }
}
