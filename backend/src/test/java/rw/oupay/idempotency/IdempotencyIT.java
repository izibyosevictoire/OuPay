package rw.oupay.idempotency;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.sql.Timestamp;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.TestComponent;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.http.HttpMethod;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Controller;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseBody;
import rw.oupay.common.ApiException;
import rw.oupay.common.Housekeeping;
import rw.oupay.membership.MerchantAccess;
import rw.oupay.membership.Permission;
import rw.oupay.support.IntegrationTest;
import rw.oupay.support.TestApi;
import rw.oupay.support.World;

/**
 * The idempotency infrastructure against a real PostgreSQL, driven through a small test-only HTTP endpoint that behaves
 * the way a billing endpoint will: it authorises, creates one durable row, and rebuilds its response on replay.
 */
class IdempotencyIT extends IntegrationTest {

    private static final String KEY = "billing-key-0001";

    /** A test-only endpoint. Registered by this test's own configuration, so no other test context ever sees it. */
    @TestConfiguration
    static class Endpoints {
        @Bean
        TestOperationEndpoint testOperationEndpoint(IdempotencyService idempotency, MerchantAccess access, JdbcClient jdbc) {
            return new TestOperationEndpoint(idempotency, access, jdbc);
        }
    }

    // Since Spring 6 a type-level @RequestMapping alone does not make a bean a web handler: @Controller is required.
    // @TestComponent keeps component scanning from ever picking this class up outside this test's own configuration.
    @Controller
    @TestComponent
    @RequestMapping("/api/v1/merchants/{merchantId}/idempotency-test")
    @ResponseBody
    static class TestOperationEndpoint {

        private final IdempotencyService idempotency;
        private final MerchantAccess access;
        private final JdbcClient jdbc;
        /** Counted down once the action has inserted its row but not yet committed: lets a test act at exactly that moment. */
        volatile CountDownLatch insertedButNotCommitted;

        TestOperationEndpoint(IdempotencyService idempotency, MerchantAccess access, JdbcClient jdbc) {
            this.idempotency = idempotency;
            this.access = access;
            this.jdbc = jdbc;
        }

        @PostMapping
        ResponseEntity<Map<String, Object>> create(@PathVariable UUID merchantId,
                                                   @RequestHeader(value = IdempotencyService.HEADER, required = false) String key,
                                                   @RequestBody Map<String, Object> body) {
            String fingerprint = idempotency.fingerprintOf("TEST_CREATE", Map.of("merchantId", merchantId), body);
            var outcome = idempotency.executeOnce(merchantId, "TEST_CREATE", key, fingerprint,
                    () -> perform(merchantId, body), stored -> load(merchantId, stored.entityId()));
            return ResponseEntity.status(outcome.replayed() ? 200 : 201)
                    .header("Idempotent-Replayed", String.valueOf(outcome.replayed()))
                    .body(outcome.response());
        }

        private IdempotencyService.Created<Map<String, Object>> perform(UUID merchantId, Map<String, Object> body) {
            access.require(merchantId, Permission.INVOICES_CREATE);
            UUID id = UUID.randomUUID();
            String label = String.valueOf(body.get("label"));
            jdbc.sql("insert into idem_test_operations (id, merchant_id, label) values (:id, :m, :label)")
                    .param("id", id).param("m", merchantId).param("label", label).update();
            CountDownLatch signal = insertedButNotCommitted;
            if (signal != null) {
                signal.countDown();
            }
            if (body.get("delayMs") instanceof Number delay) {
                pause(delay.longValue());
            }
            if (Boolean.TRUE.equals(body.get("fail"))) {
                throw ApiException.conflict("test_failure", "The test operation failed.");
            }
            if (Boolean.TRUE.equals(body.get("overflow"))) {
                jdbc.sql("select cast(1e30 as numeric(20,6))").query(java.math.BigDecimal.class).single();
            }
            if (Boolean.TRUE.equals(body.get("contend"))) {
                jdbc.sql("select merchant_id from merchant_settings where merchant_id = :m for update nowait")
                        .param("m", merchantId).query(UUID.class).single();
            }
            return new IdempotencyService.Created<>(Map.of("id", id.toString(), "label", label), "test_operation", id);
        }

        private Map<String, Object> load(UUID merchantId, UUID id) {
            access.require(merchantId, Permission.INVOICES_CREATE);
            return jdbc.sql("select id, label from idem_test_operations where id = :id and merchant_id = :m")
                    .param("id", id).param("m", merchantId)
                    .query((rs, row) -> Map.<String, Object>of("id", rs.getObject("id", UUID.class).toString(), "label", rs.getString("label")))
                    .optional().orElseThrow(() -> ApiException.notFound("This operation could not be found."));
        }

        private static void pause(long milliseconds) {
            try {
                Thread.sleep(milliseconds);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
    }

    @Autowired
    Housekeeping housekeeping;

    @Autowired
    IdempotencyService idempotencyService;

    @Autowired
    TestOperationEndpoint endpoint;

    @Autowired
    PlatformTransactionManager transactionManager;

    World w;

    @BeforeEach
    void world() {
        jdbc.execute("create table if not exists idem_test_operations (id uuid primary key, merchant_id uuid not null, label text not null)");
        w = World.create(this);
    }

    @AfterEach
    void dropTestTable() {
        jdbc.execute("drop table if exists idem_test_operations");
    }

    private String url(UUID merchantId) {
        return "/api/v1/merchants/" + merchantId + "/idempotency-test";
    }

    private TestApi.Response post(TestApi api, UUID merchantId, String key, Object body) {
        return api.send(HttpMethod.POST, url(merchantId), body, key == null ? Map.of() : Map.of("Idempotency-Key", key));
    }

    private int operations() {
        return jdbc.queryForObject("select count(*) from idem_test_operations", Integer.class);
    }

    private int records() {
        return jdbc.queryForObject("select count(*) from idempotency_keys", Integer.class);
    }

    private static String id(TestApi.Response response) {
        return response.json().path("id").asString();
    }

    // ---- the basic contract --------------------------------------------------------------------

    @Test
    void theFirstRequestExecutesOnceAndRecordsItsResult() {
        var response = post(w.cashier, w.merchantId, KEY, Map.of("label", "first"));

        assertThat(response.status()).isEqualTo(201);
        assertThat(response.raw().getHeader("Idempotent-Replayed")).isEqualTo("false");
        assertThat(operations()).isEqualTo(1);
        assertThat(records()).isEqualTo(1);
        var record = jdbc.queryForMap("select actor_user_id, request_sha256, result_entity_type, result_entity_id::text as result_id "
                + "from idempotency_keys where merchant_id = ? and scope = 'TEST_CREATE' and idem_key = ?", w.merchantId, KEY);
        assertThat(record.get("actor_user_id")).isEqualTo(w.cashierPerson.userId());
        assertThat((String) record.get("request_sha256")).matches("^[0-9a-f]{64}$");
        assertThat(record.get("result_entity_type")).isEqualTo("test_operation");
        assertThat(record.get("result_id")).isEqualTo(id(response));
    }

    @Test
    void anIdenticalRetryReplaysTheOriginalResultWithoutRunningAgain() {
        var first = post(w.cashier, w.merchantId, KEY, "{\"label\":\"first\",\"note\":\"n\"}");
        // Same request, fields in another order: still the same request.
        var retry = post(w.cashier, w.merchantId, KEY, "{\"note\":\"n\",\"label\":\"first\"}");

        assertThat(retry.status()).isEqualTo(200);
        assertThat(retry.raw().getHeader("Idempotent-Replayed")).isEqualTo("true");
        assertThat(id(retry)).isEqualTo(id(first));
        assertThat(retry.json().path("label").asString()).isEqualTo("first");
        assertThat(operations()).isEqualTo(1);
        assertThat(records()).isEqualTo(1);
    }

    @Test
    void theSameKeyWithDifferentDataIsRefusedAndNothingChanges() {
        var first = post(w.cashier, w.merchantId, KEY, Map.of("label", "first"));
        var different = post(w.cashier, w.merchantId, KEY, Map.of("label", "something else"));

        assertThat(different.status()).isEqualTo(409);
        assertThat(different.code()).isEqualTo("idempotency_key_reuse");
        assertThat(operations()).isEqualTo(1);
        assertThat(jdbc.queryForObject("select label from idem_test_operations", String.class)).isEqualTo("first");
        // The honest retry still works afterwards.
        assertThat(id(post(w.cashier, w.merchantId, KEY, Map.of("label", "first")))).isEqualTo(id(first));
    }

    @Test
    void theSameKeyUsedByAnotherPersonIsRefusedEvenForIdenticalData() {
        post(w.cashier, w.merchantId, KEY, Map.of("label", "first"));
        var other = post(w.manager, w.merchantId, KEY, Map.of("label", "first"));

        assertThat(other.status()).isEqualTo(409);
        assertThat(other.code()).isEqualTo("idempotency_key_reuse");
        assertThat(operations()).isEqualTo(1);
    }

    @Test
    void keysAreScopedToTheBusiness() {
        var shop = post(w.owner, w.merchantId, KEY, Map.of("label", "shop"));
        var cafe = post(w.cafeOwner, w.cafeMerchantId, KEY, Map.of("label", "cafe"));

        assertThat(shop.status()).isEqualTo(201);
        assertThat(cafe.status()).isEqualTo(201);
        assertThat(id(cafe)).isNotEqualTo(id(shop));
        assertThat(operations()).isEqualTo(2);
        assertThat(records()).isEqualTo(2);
    }

    @Test
    void aStrangerCannotUseOrProbeAnotherBusinessKey() {
        var shop = post(w.owner, w.merchantId, KEY, Map.of("label", "shop"));
        var stranger = post(w.cafeOwner, w.merchantId, KEY, Map.of("label", "shop"));

        assertThat(stranger.status()).isEqualTo(404);
        assertThat(stranger.body()).doesNotContain(id(shop)).doesNotContain("shop");
        // Nothing was written on the stranger's behalf.
        assertThat(records()).isEqualTo(1);
        assertThat(jdbc.queryForObject("select actor_user_id from idempotency_keys", java.util.UUID.class)).isEqualTo(w.ownerPerson.userId());
    }

    @Test
    void invalidKeysAreRejectedBeforeAnythingHappens() {
        assertThat(post(w.cashier, w.merchantId, null, Map.of("label", "x")).status()).isEqualTo(422);
        assertThat(post(w.cashier, w.merchantId, "short", Map.of("label", "x")).status()).isEqualTo(422);
        assertThat(post(w.cashier, w.merchantId, "has spaces in it!", Map.of("label", "x")).status()).isEqualTo(422);
        assertThat(post(w.cashier, w.merchantId, "x".repeat(81), Map.of("label", "x")).status()).isEqualTo(422);
        assertThat(operations()).isZero();
        assertThat(records()).isZero();
    }

    // ---- transaction correctness ---------------------------------------------------------------

    @Test
    void aFailedOperationLeavesNeitherItsRowNorAReplayRecordAndTheKeyStaysUsable() {
        var failed = post(w.cashier, w.merchantId, KEY, Map.of("label", "doomed", "fail", true));

        assertThat(failed.status()).isEqualTo(409);
        assertThat(failed.code()).isEqualTo("test_failure");
        // The business row and the idempotency record were rolled back together.
        assertThat(operations()).isZero();
        assertThat(records()).isZero();

        var retried = post(w.cashier, w.merchantId, KEY, Map.of("label", "doomed"));
        assertThat(retried.status()).isEqualTo(201);
        assertThat(operations()).isEqualTo(1);
        assertThat(records()).isEqualTo(1);
    }

    @Test
    void aRecordCannotCommitWithoutItsResult() {
        var tx = new TransactionTemplate(transactionManager);
        assertThatThrownBy(() -> tx.executeWithoutResult(status -> jdbc.update(
                "insert into idempotency_keys (merchant_id, scope, idem_key, actor_user_id, request_sha256, created_at) "
                        + "values (?, 'TEST_CREATE', 'incomplete-key', ?, ?, now())",
                w.merchantId, w.ownerPerson.userId(), "a".repeat(64))))
                .hasStackTraceContaining("must carry its result");
        assertThat(records()).isZero();
    }

    @Test
    void theDatabaseRejectsMalformedAndAlteredRecords() {
        String insert = "insert into idempotency_keys (merchant_id, scope, idem_key, actor_user_id, request_sha256, result_entity_type, result_entity_id, created_at) "
                + "values (?, ?, ?, ?, ?, 'test_operation', gen_random_uuid(), now())";
        UUID owner = w.ownerPerson.userId();
        assertThatThrownBy(() -> jdbc.update(insert, w.merchantId, "test_create", "valid-key-0001", owner, "a".repeat(64)))
                .hasStackTraceContaining("ck_idempotency_scope");
        assertThatThrownBy(() -> jdbc.update(insert, w.merchantId, "TEST_CREATE", "short", owner, "a".repeat(64)))
                .hasStackTraceContaining("ck_idempotency_key");
        assertThatThrownBy(() -> jdbc.update(insert, w.merchantId, "TEST_CREATE", "valid-key-0001", owner, "NOT-A-DIGEST"))
                .hasStackTraceContaining("ck_idempotency_sha256");
        assertThatThrownBy(() -> jdbc.update(insert, UUID.randomUUID(), "TEST_CREATE", "valid-key-0001", owner, "a".repeat(64)))
                .hasStackTraceContaining("idempotency_keys_merchant_id_fkey");

        assertThat(jdbc.update(insert, w.merchantId, "TEST_CREATE", "valid-key-0001", owner, "a".repeat(64))).isEqualTo(1);
        assertThatThrownBy(() -> jdbc.update("update idempotency_keys set request_sha256 = ?", "b".repeat(64)))
                .hasStackTraceContaining("immutable");
        assertThatThrownBy(() -> jdbc.update("update idempotency_keys set result_entity_id = gen_random_uuid()"))
                .hasStackTraceContaining("already has its result");
    }

    @Test
    void anInFlightOperationIsInvisibleToEveryoneElseAndAConcurrentRetryWaitsForItsOutcome() throws Exception {
        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            TestApi first = fixtures.signIn(mvc, w.cashierPerson);
            TestApi retry = fixtures.signIn(mvc, w.cashierPerson);
            CountDownLatch actionStarted = new CountDownLatch(1);
            endpoint.insertedButNotCommitted = actionStarted;
            Future<TestApi.Response> original = pool.submit(() -> post(first, w.merchantId, KEY, Map.of("label", "slow", "delayMs", 1200)));
            // Deterministic: wait until the first request has really inserted its row and is still uncommitted.
            assertThat(actionStarted.await(30, TimeUnit.SECONDS)).isTrue();

            // Mid-flight: neither the business row nor the idempotency record is visible, so nothing "half done" can be seen.
            assertThat(operations()).isZero();
            assertThat(records()).isZero();

            Future<TestApi.Response> retried = pool.submit(() -> post(retry, w.merchantId, KEY, Map.of("label", "slow", "delayMs", 1200)));
            TestApi.Response originalResponse = original.get(30, TimeUnit.SECONDS);
            TestApi.Response retriedResponse = retried.get(30, TimeUnit.SECONDS);

            assertThat(originalResponse.status()).isEqualTo(201);
            assertThat(retriedResponse.status()).isEqualTo(200);
            assertThat(id(retriedResponse)).isEqualTo(id(originalResponse));
            assertThat(operations()).isEqualTo(1);
            assertThat(records()).isEqualTo(1);
        } finally {
            endpoint.insertedButNotCommitted = null;
            pool.shutdownNow();
        }
    }

    @Test
    void callingItInsideATransactionIsRefusedBecauseTheOutcomeWouldNotYetBeCommitted() {
        UUID merchantId = w.merchantId;
        var tx = new TransactionTemplate(transactionManager);
        assertThatThrownBy(() -> tx.executeWithoutResult(status -> idempotencyService.executeOnce(merchantId, "TEST_CREATE", KEY,
                idempotencyService.fingerprintOf("TEST_CREATE", Map.of("merchantId", merchantId), Map.of("label", "x")),
                () -> new IdempotencyService.Created<>("never", "test_operation", UUID.randomUUID()),
                stored -> "never")))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("outside a transaction");
        // The refusal happens before anything is claimed or executed.
        assertThat(records()).isZero();
        assertThat(operations()).isZero();
    }

    @Test
    void aLostResponseFollowedByARetryReturnsTheCommittedResult() {
        // The first call commits; the client never sees the response and sends the same request again.
        var committed = post(w.cashier, w.merchantId, KEY, Map.of("label", "paid-once"));
        var afterLoss = post(w.cashier, w.merchantId, KEY, Map.of("label", "paid-once"));

        assertThat(afterLoss.status()).isEqualTo(200);
        assertThat(id(afterLoss)).isEqualTo(id(committed));
        assertThat(operations()).isEqualTo(1);
    }

    @Test
    void tenIdenticalConcurrentRequestsProduceOneOperation() throws Exception {
        List<TestApi> clients = new ArrayList<>();
        for (int i = 0; i < 10; i++) {
            clients.add(fixtures.signIn(mvc, w.cashierPerson));
        }
        List<Callable<TestApi.Response>> requests = new ArrayList<>();
        for (TestApi client : clients) {
            requests.add(() -> post(client, w.merchantId, KEY, Map.of("label", "contested", "delayMs", 400)));
        }

        List<TestApi.Response> responses = concurrently(requests);

        assertThat(responses).extracting(TestApi.Response::status).containsOnly(200, 201);
        assertThat(responses).filteredOn(r -> r.status() == 201).hasSize(1);
        assertThat(responses).extracting(IdempotencyIT::id).containsOnly(id(responses.stream().filter(r -> r.status() == 201).findFirst().orElseThrow()));
        assertThat(operations()).isEqualTo(1);
        assertThat(records()).isEqualTo(1);
    }

    // ---- authorisation on replay ---------------------------------------------------------------

    @Test
    void replayRechecksAccessAndNeverLeaksStoredData() {
        var created = post(w.cashier, w.merchantId, KEY, Map.of("label", "private-label"));
        assertThat(created.status()).isEqualTo(201);

        // The person loses access to the business; holding the key must reveal nothing.
        jdbc.update("update memberships set status = 'REVOKED' where id = ?", w.cashierMembershipId);
        var replay = post(w.cashier, w.merchantId, KEY, Map.of("label", "private-label"));

        assertThat(replay.status()).isEqualTo(404);
        assertThat(replay.body()).doesNotContain("private-label").doesNotContain(id(created));
    }

    @Test
    void replayOfAResourceThatNoLongerExistsGivesTheOrdinaryNotFound() {
        var created = post(w.cashier, w.merchantId, KEY, Map.of("label", "private-label"));
        jdbc.update("delete from idem_test_operations");

        var replay = post(w.cashier, w.merchantId, KEY, Map.of("label", "private-label"));

        assertThat(replay.status()).isEqualTo(404);
        assertThat(replay.code()).isEqualTo("not_found");
        assertThat(replay.body()).doesNotContain("private-label").doesNotContain(id(created));
        // The record itself is untouched: a failed replay changes nothing.
        assertThat(records()).isEqualTo(1);
    }

    // ---- database errors over HTTP -------------------------------------------------------------

    @Test
    void aNumericOverflowIsAGenericServerErrorThatLeaksNothingAndLeavesNoRecord() {
        var response = post(w.cashier, w.merchantId, KEY, Map.of("label", "overflow", "overflow", true));

        assertThat(response.status()).isEqualTo(500);
        assertThat(response.json().path("code").asString()).isEqualTo("service_unavailable");
        assertThat(response.json().has("message")).isTrue();
        assertThat(response.json().path("fields").isArray()).isTrue();
        assertThat(response.body()).doesNotContain("numeric").doesNotContain("overflow").doesNotContain("precision").doesNotContain("22003");
        assertThat(operations()).isZero();
        assertThat(records()).isZero();
    }

    @Test
    void lockContentionIsARetryableResponseAndTheRetryWithTheSameKeySucceeds() throws Exception {
        ExecutorService pool = Executors.newSingleThreadExecutor();
        CountDownLatch locked = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        try {
            // Another connection holds the row lock the operation will try to take (without waiting).
            Future<?> holder = pool.submit(() -> new TransactionTemplate(transactionManager).executeWithoutResult(status -> {
                jdbc.queryForObject("select merchant_id from merchant_settings where merchant_id = ? for update", UUID.class, w.merchantId);
                locked.countDown();
                awaitQuietly(release);
            }));
            assertThat(locked.await(10, TimeUnit.SECONDS)).isTrue();

            var busy = post(w.cashier, w.merchantId, KEY, Map.of("label", "contended", "contend", true));

            assertThat(busy.status()).isEqualTo(503);
            assertThat(busy.raw().getHeader("Retry-After")).isEqualTo("1");
            assertThat(busy.json().path("code").asString()).isEqualTo("try_again");
            assertThat(busy.body()).doesNotContain("merchant_settings").doesNotContain("lock").doesNotContain("55P03");
            // The aborted attempt left no trace, so nothing blocks the retry.
            assertThat(operations()).isZero();
            assertThat(records()).isZero();

            release.countDown();
            holder.get(10, TimeUnit.SECONDS);
            var retried = post(w.cashier, w.merchantId, KEY, Map.of("label", "contended", "contend", true));
            assertThat(retried.status()).isEqualTo(201);
            assertThat(operations()).isEqualTo(1);
        } finally {
            release.countDown();
            pool.shutdownNow();
        }
    }

    // ---- retention cleanup ---------------------------------------------------------------------

    @Test
    void housekeepingRemovesOnlyOldIdempotencyRecordsAndNeverBusinessRecords() {
        UUID invoiceId = w.issuedInvoice(5_000);
        post(w.cashier, w.merchantId, KEY, Map.of("label", "recent-business-row"));
        insertRecords("OLD_SCOPE", 3, Instant.now().minus(31, ChronoUnit.DAYS));
        insertRecords("MID_SCOPE", 2, Instant.now().minus(29, ChronoUnit.DAYS));
        int audit = jdbc.queryForObject("select count(*) from audit_log", Integer.class);
        int invoices = jdbc.queryForObject("select count(*) from invoices", Integer.class);
        int sessions = jdbc.queryForObject("select count(*) from auth_sessions", Integer.class);
        int memberships = jdbc.queryForObject("select count(*) from memberships", Integer.class);

        int[] removed = housekeeping.runOnce();

        assertThat(removed[4]).isEqualTo(3);
        assertThat(jdbc.queryForObject("select count(*) from idempotency_keys where scope = 'OLD_SCOPE'", Integer.class)).isZero();
        assertThat(jdbc.queryForObject("select count(*) from idempotency_keys where scope = 'MID_SCOPE'", Integer.class)).isEqualTo(2);
        assertThat(jdbc.queryForObject("select count(*) from idempotency_keys where scope = 'TEST_CREATE'", Integer.class)).isEqualTo(1);
        // Pruning replay records never touches durable business or financial data.
        assertThat(operations()).isEqualTo(1);
        assertThat(jdbc.queryForObject("select count(*) from audit_log", Integer.class)).isEqualTo(audit);
        assertThat(jdbc.queryForObject("select count(*) from invoices", Integer.class)).isEqualTo(invoices);
        assertThat(jdbc.queryForObject("select status from invoices where id = ?", String.class, invoiceId)).isEqualTo("ISSUED");
        assertThat(jdbc.queryForObject("select count(*) from auth_sessions", Integer.class)).isEqualTo(sessions);
        assertThat(jdbc.queryForObject("select count(*) from memberships", Integer.class)).isEqualTo(memberships);
        // A second run finds nothing more to do.
        assertThat(housekeeping.runOnce()[4]).isZero();
    }

    @Test
    void housekeepingWorksThroughALargeBacklogInBoundedBatches() {
        insertRecords("OLD_SCOPE", 1_100, Instant.now().minus(45, ChronoUnit.DAYS));
        insertRecords("MID_SCOPE", 10, Instant.now().minus(1, ChronoUnit.DAYS));

        int[] removed = housekeeping.runOnce();

        assertThat(removed[4]).isEqualTo(1_100);
        assertThat(records()).isEqualTo(10);
    }

    private void insertRecords(String scope, int count, Instant createdAt) {
        jdbc.update("insert into idempotency_keys (merchant_id, scope, idem_key, actor_user_id, request_sha256, result_entity_type, result_entity_id, created_at) "
                + "select cast(? as uuid), ?, 'seeded-key-' || n, cast(? as uuid), repeat('a', 64), 'test_operation', gen_random_uuid(), cast(? as timestamptz) "
                + "from generate_series(1, cast(? as int)) as n", w.merchantId, scope, w.ownerPerson.userId(), Timestamp.from(createdAt), count);
    }

    private static void awaitQuietly(CountDownLatch latch) {
        try {
            latch.await(30, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    /** Runs all tasks at (nearly) the same instant and returns their results. */
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
}
