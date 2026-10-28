package rw.oupay.checkout;

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
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpMethod;
import rw.oupay.collection.ApprovalSource;
import rw.oupay.collection.CollectionCodeApprovalService;
import rw.oupay.support.IntegrationTest;
import rw.oupay.support.TestApi;
import rw.oupay.support.World;
import tools.jackson.databind.JsonNode;

/** Shared set-up for the R6c integration tests: the sample world, collection codes, assignments and payment links. */
abstract class CodeCheckoutTestSupport extends IntegrationTest {

    @Autowired
    CollectionCodeApprovalService approvals;

    World w;
    UUID destination;
    UUID cashierMembership;
    UUID otherCashierMembership;
    UUID operatorA;
    UUID operatorB;

    @BeforeEach
    void codeWorld() {
        w = World.create(this);
        destination = jdbc.queryForObject("select id from payment_destinations where merchant_id = ?", UUID.class, w.merchantId);
        cashierMembership = w.cashierMembershipId;
        otherCashierMembership = jdbc.queryForObject("select id from memberships where user_id = ? and merchant_id = ?", UUID.class,
                w.otherCashierPerson.userId(), w.merchantId);
        operatorA = w.cafePerson.userId();
        operatorB = fixtures.user("operator@oupay.test", "Platform Operator").userId();
    }

    // ---- urls and bodies -----------------------------------------------------------------------

    String codes() {
        return "/api/v1/merchants/" + w.merchantId + "/collection-codes";
    }

    String sale() {
        return "/api/v1/merchants/" + w.merchantId + "/checkout/code-sale";
    }

    Map<String, Object> body(Object amount, String description, UUID codeId, UUID clientRequestId) {
        Map<String, Object> body = new HashMap<>();
        body.put("amountRwf", amount);
        if (description != null) {
            body.put("description", description);
        }
        if (codeId != null) {
            body.put("collectionCodeId", codeId.toString());
        }
        body.put("clientRequestId", clientRequestId.toString());
        return body;
    }

    TestApi.Response bill(TestApi api, String key, Map<String, Object> body) {
        return api.send(HttpMethod.POST, sale(), body, Map.of("Idempotency-Key", key));
    }

    TestApi.Response bill(TestApi api, Object amount) {
        return bill(api, "key-" + UUID.randomUUID(), body(amount, null, null, UUID.randomUUID()));
    }

    TestApi.Response publicSale(String reference) {
        return TestApi.anonymous(mvc, HttpMethod.GET, "/api/v1/public/code-sales/" + reference, null, Map.of());
    }

    // ---- fixtures ------------------------------------------------------------------------------

    /** An active business-wide payment link on the linked bank account (the request of a sale rides on one). */
    UUID ensureProfile() {
        return ensureProfile(destination);
    }

    UUID ensureProfile(UUID destinationId) {
        var created = w.owner.post("/api/v1/merchants/" + w.merchantId + "/payment-profiles",
                Map.of("label", "Counter", "paymentDestinationId", destinationId.toString()));
        assertThat(created.status()).as(created.body()).isEqualTo(201);
        return UUID.fromString(created.json().path("id").asString());
    }

    /** A code REQUESTED on the shop's account (simulated unless the account was made real first), with its branch when given. */
    JsonNode requestedCode(String label, UUID branchId, UUID destinationId) {
        Map<String, Object> request = new HashMap<>();
        request.put("clientOperationId", UUID.randomUUID().toString());
        request.put("settlementDestinationId", destinationId.toString());
        request.put("displayLabel", label);
        if (branchId != null) {
            request.put("branchId", branchId.toString());
        }
        var response = w.owner.post(codes(), request);
        assertThat(response.status()).as(response.body()).isEqualTo(201);
        return response.json().path("code");
    }

    JsonNode requestedCode(String label) {
        return requestedCode(label, w.branchId, destination);
    }

    JsonNode pendingCode(String label) {
        JsonNode code = requestedCode(label);
        var response = w.owner.post(codes() + "/" + id(code) + "/submission", Map.of("expectedVersion", code.path("version").asLong(), "bankRequestRef", "EQ-" + label));
        assertThat(response.status()).as(response.body()).isEqualTo(200);
        return response.json();
    }

    /** A bank-approved code (through the trusted service); real only when the account was made non-simulated before it was requested. */
    JsonNode activeCode(String label, String bankCode) {
        JsonNode code = pendingCode(label);
        approvals.approve(w.merchantId, UUID.fromString(id(code)), bankCode,
                new CollectionCodeApprovalService.Evidence(ApprovalSource.OPERATOR, "Equity letter EQ-2026-014", operatorA, operatorB));
        return w.owner.get(codes() + "/" + id(code)).json();
    }

    TestApi.Response assign(JsonNode code, UUID membershipId) {
        return w.owner.post(codes() + "/" + id(code) + "/assignments", Map.of("membershipId", membershipId.toString()));
    }

    TestApi.Response reassign(JsonNode code, String expectedAssignmentId, UUID membershipId, String reason) {
        return w.owner.post(codes() + "/" + id(code) + "/reassign",
                Map.of("expectedAssignmentId", expectedAssignmentId, "membershipId", membershipId.toString(), "reason", reason));
    }

    static String id(JsonNode node) {
        return node.path("id").asString();
    }

    /** The shop's account becomes a REAL one (codes requested afterwards are not simulated). */
    void makeAccountReal() {
        jdbc.update("update payment_destinations set is_simulated = false where merchant_id = ?", w.merchantId);
    }

    int count(String table) {
        return jdbc.queryForObject("select count(*) from " + table, Integer.class);
    }

    <T> List<T> concurrently(List<Callable<T>> tasks) throws Exception {
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
}
