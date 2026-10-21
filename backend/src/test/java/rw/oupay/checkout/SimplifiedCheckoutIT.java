package rw.oupay.checkout;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Duration;
import java.time.Instant;
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
import org.springframework.http.HttpMethod;
import rw.oupay.support.IntegrationTest;
import rw.oupay.support.TestApi;
import rw.oupay.support.World;

/**
 * R4 against a real PostgreSQL: amount-only checkout for a SIMPLIFIED business, end to end through HTTP, authentication,
 * R2 idempotency, R3 durable identity, the existing payment-request infrastructure and the real bank-event processor.
 */
class SimplifiedCheckoutIT extends IntegrationTest {

    World w;

    @BeforeEach
    void world() {
        w = World.create(this);
        setMode(w.merchantId, "SIMPLIFIED");
    }

    // ---- helpers -------------------------------------------------------------------------------

    private void setMode(UUID merchantId, String mode) {
        jdbc.update("insert into merchant_settings (merchant_id, operating_mode, updated_at, version) values (?, ?, now(), 0) "
                + "on conflict (merchant_id) do update set operating_mode = excluded.operating_mode", merchantId, mode);
    }

    private String base() {
        return "/api/v1/merchants/" + w.merchantId + "/checkout/simple";
    }

    private Map<String, Object> sale(Object amount, String description, UUID clientRequestId) {
        Map<String, Object> body = new HashMap<>();
        body.put("amountRwf", amount);
        if (description != null) {
            body.put("description", description);
        }
        body.put("clientRequestId", clientRequestId.toString());
        return body;
    }

    private TestApi.Response bill(TestApi api, String key, Map<String, Object> body) {
        return api.send(HttpMethod.POST, base(), body, Map.of("Idempotency-Key", key));
    }

    private TestApi.Response bill(TestApi api, Object amount) {
        return bill(api, "key-" + UUID.randomUUID(), sale(amount, null, UUID.randomUUID()));
    }

    /** Creates an active business-wide payment link on the linked bank account. */
    private void ensureProfile() {
        UUID destination = jdbc.queryForObject("select id from payment_destinations where merchant_id = ?", UUID.class, w.merchantId);
        var created = w.owner.post("/api/v1/merchants/" + w.merchantId + "/payment-profiles",
                Map.of("label", "Counter", "paymentDestinationId", destination.toString()));
        assertThat(created.status()).as(created.body()).isEqualTo(201);
    }

    private int count(String table) {
        return jdbc.queryForObject("select count(*) from " + table, Integer.class);
    }

    private TestApi.Response invoice(UUID invoiceId) {
        return w.owner.get("/api/v1/merchants/" + w.merchantId + "/invoices/" + invoiceId);
    }

    // ---- the happy path ------------------------------------------------------------------------

    @Test
    void aSimplifiedBusinessBillsAnAmountAndGetsAnIssuedInvoiceAndAFixedAmountRequest() {
        ensureProfile();
        UUID clientRequestId = UUID.randomUUID();
        Instant before = Instant.now();
        var response = bill(w.cashier, "key-happy-0001", sale(25_000, "Moto ride", clientRequestId));
        assertThat(response.status()).as(response.body()).isEqualTo(201);
        var json = response.json();
        assertThat(json.path("amountRwf").asLong()).isEqualTo(25_000);
        assertThat(json.path("currency").asString()).isEqualTo("RWF");
        assertThat(json.path("description").asString()).isEqualTo("Moto ride");
        assertThat(json.path("merchantDisplayName").asString()).isEqualTo("Sample Shop Ltd");
        assertThat(json.path("status").asString()).isIn("CREATED", "AWAITING_PAYMENT");
        String reference = json.path("publicReference").asString();
        assertThat(reference).startsWith("OP-");
        assertThat(json.path("paymentPath").asString()).isEqualTo("/p/" + json.path("profileToken").asString() + "/r/" + reference);
        Instant expires = Instant.parse(json.path("expiresAt").asString());
        assertThat(Duration.between(Instant.parse(json.path("createdAt").asString()), expires)).isEqualTo(Duration.ofMinutes(30));
        assertThat(expires).isAfter(before.plus(Duration.ofMinutes(29)));

        // The invoice: issued, one line of quantity 1 for the entered amount, a walk-in customer, no tax, not paid.
        UUID invoiceId = UUID.fromString(json.path("invoiceId").asString());
        var stored = invoice(invoiceId).json();
        assertThat(stored.path("status").asString()).isEqualTo("ISSUED");
        assertThat(stored.path("saleChannel").asString()).isEqualTo("SIMPLIFIED");
        assertThat(stored.path("grandTotal").asLong()).isEqualTo(25_000);
        assertThat(stored.path("taxTotal").asLong()).isZero();
        assertThat(stored.path("paymentStatus").asString()).isEqualTo("UNPAID");
        assertThat(stored.path("customer").path("name").asString()).isEqualTo("Walk-in customer");
        assertThat(stored.path("items").size()).isEqualTo(1);
        assertThat(stored.path("items").get(0).path("quantity").asLong()).isEqualTo(1);
        assertThat(stored.path("items").get(0).path("unitPrice").asLong()).isEqualTo(25_000);
        assertThat(stored.path("items").get(0).path("description").asString()).isEqualTo("Moto ride");

        // Provenance and attribution as recorded in the database.
        var row = jdbc.queryForMap("select sale_channel, client_request_id, client_request_sha256, branch_id, created_by_user_id, "
                + "assigned_to_user_id from invoices where id = ?", invoiceId);
        assertThat(row.get("sale_channel")).isEqualTo("SIMPLIFIED");
        assertThat(row.get("client_request_id")).isEqualTo(clientRequestId);
        assertThat((String) row.get("client_request_sha256")).matches("^[0-9a-f]{64}$");
        assertThat(row.get("branch_id")).isEqualTo(w.branchId);
        assertThat(row.get("created_by_user_id")).isEqualTo(w.cashierPerson.userId());
        assertThat(row.get("assigned_to_user_id")).isEqualTo(w.cashierPerson.userId());
        var request = jdbc.queryForMap("select source, branch_id, created_by_user_id, requested_amount_rwf from payment_requests where invoice_id = ?", invoiceId);
        assertThat(request.get("source")).isEqualTo("SIMPLIFIED");
        assertThat(request.get("branch_id")).isEqualTo(w.branchId);
        assertThat(request.get("created_by_user_id")).isEqualTo(w.cashierPerson.userId());
        assertThat(((Number) request.get("requested_amount_rwf")).longValue()).isEqualTo(25_000);
        assertThat(jdbc.queryForObject("select count(*) from audit_log where kind = 'SIMPLE_CHECKOUT_BILLED'", Integer.class)).isEqualTo(1);
    }

    @Test
    void anEmptyDescriptionUsesTheDefaultAndClientFieldsThatAreNotTheirsAreIgnored() {
        ensureProfile();
        Map<String, Object> body = sale(1_000, "   ", UUID.randomUUID());
        body.put("saleChannel", "POS");
        body.put("status", "SETTLED");
        body.put("expiresInMinutes", 99_999);
        body.put("taxRate", Map.of("category", "STANDARD", "rateBp", 1800));
        body.put("createdByUserId", w.ownerPerson.userId().toString());
        var response = bill(w.manager, "key-ignored-01", body);
        assertThat(response.status()).as(response.body()).isEqualTo(201);
        assertThat(response.json().path("description").asString()).isEqualTo("Payment");
        UUID id = UUID.fromString(response.json().path("invoiceId").asString());
        var stored = invoice(id).json();
        assertThat(stored.path("saleChannel").asString()).isEqualTo("SIMPLIFIED");
        assertThat(stored.path("taxTotal").asLong()).isZero();
        assertThat(stored.path("paymentStatus").asString()).isEqualTo("UNPAID");
        assertThat(stored.path("createdByName").asString()).isEqualTo("Grace Manager");
        assertThat(Duration.between(Instant.parse(response.json().path("createdAt").asString()), Instant.parse(response.json().path("expiresAt").asString())))
                .isEqualTo(Duration.ofMinutes(30));
    }

    // ---- who may use it ------------------------------------------------------------------------

    @Test
    void aBusinessInBusinessModeCannotUseTheSimplifiedCheckout() {
        ensureProfile();
        setMode(w.merchantId, "BUSINESS");
        var response = bill(w.cashier, 5_000);
        assertThat(response.status()).isEqualTo(409);
        assertThat(response.code()).isEqualTo("checkout_not_available");
        assertThat(count("invoices")).isZero();
        assertThat(count("payment_requests")).isZero();
        assertThat(count("idempotency_keys")).isZero();
        // A business with no settings row at all reads as BUSINESS too.
        jdbc.update("delete from merchant_settings where merchant_id = ?", w.merchantId);
        assertThat(bill(w.cashier, 5_000).code()).isEqualTo("checkout_not_available");
    }

    @Test
    void strangersAndOtherBusinessesAreRejected() {
        ensureProfile();
        var body = sale(5_000, null, UUID.randomUUID());
        // Not signed in (a write without a session also lacks the CSRF token, so it may be refused even earlier).
        assertThat(TestApi.anonymous(mvc, HttpMethod.GET, base() + "/options", null, Map.of()).status()).isEqualTo(401);
        assertThat(TestApi.anonymous(mvc, HttpMethod.POST, base(), body,
                Map.of("Idempotency-Key", "key-anonymous-1")).status()).isIn(401, 403);
        // Another business's owner reaching into this one: the business simply does not exist for them.
        assertThat(bill(w.cafeOwner, "key-cross-0001", body).status()).isEqualTo(404);
        assertThat(w.cafeOwner.get(base() + "/options").status()).isEqualTo(404);
        // A member whose membership was suspended.
        jdbc.update("update memberships set status = 'SUSPENDED' where id = ?", w.cashierMembershipId);
        assertThat(bill(w.cashier, "key-suspended-1", body).status()).isEqualTo(404);
        assertThat(count("invoices")).isZero();
    }

    // ---- amount validation ---------------------------------------------------------------------

    @Test
    void theServerRefusesAmountsOutsideTheRangeAndAnythingThatIsNotAWholeNumberOfFrancs() {
        ensureProfile();
        for (Object bad : List.<Object>of(99, 0, -500, 10_000_001L, 100.5, "abc", "12 000")) {
            var response = bill(w.cashier, bad);
            assertThat(response.status()).as("amount " + bad + ": " + response.body()).isIn(400, 422);
        }
        var missing = new HashMap<String, Object>();
        missing.put("clientRequestId", UUID.randomUUID().toString());
        assertThat(bill(w.cashier, "key-missing-amt", missing).status()).isIn(400, 422);
        assertThat(count("invoices")).isZero();
        assertThat(count("idempotency_keys")).isZero();
        // The limits themselves are accepted, and 5000.0 is the whole number 5000.
        assertThat(bill(w.cashier, 100).status()).isEqualTo(201);
        assertThat(bill(w.cashier, 10_000_000).status()).isEqualTo(201);
        assertThat(bill(w.cashier, 5000.0).status()).isEqualTo(201);
    }

    @Test
    void theDescriptionIsLimitedAndSingleLine() {
        ensureProfile();
        assertThat(bill(w.cashier, "key-longdesc-01", sale(1_000, "x".repeat(121), UUID.randomUUID())).status()).isIn(400, 422);
        assertThat(bill(w.cashier, "key-newline-001", sale(1_000, "two\nlines", UUID.randomUUID())).status()).isIn(400, 422);
        assertThat(bill(w.cashier, "key-maxdesc-001", sale(1_000, "x".repeat(120), UUID.randomUUID())).status()).isEqualTo(201);
    }

    @Test
    void anIdempotencyKeyIsRequiredAndMustBeWellFormed() {
        ensureProfile();
        var noKey = w.cashier.post(base(), sale(1_000, null, UUID.randomUUID()));
        assertThat(noKey.status()).isEqualTo(422);
        assertThat(bill(w.cashier, "short", sale(1_000, null, UUID.randomUUID())).status()).isEqualTo(422);
        assertThat(count("invoices")).isZero();
    }

    // ---- branches ------------------------------------------------------------------------------

    @Test
    void theOnlyEligibleBranchIsChosenAutomaticallyAndSeveralRequireAValidChoice() {
        ensureProfile();
        // One branch: automatic.
        assertThat(w.cashier.get(base() + "/options").json().path("branches").size()).isEqualTo(1);
        assertThat(bill(w.cashier, 2_000).status()).isEqualTo(201);

        // Two branches: the choice is required, must be one of theirs, and then it is used.
        UUID second = fixtures.branch(w.merchantId, "RM02", "ACTIVE");
        fixtures.assign(w.merchantId, w.cashierMembershipId, second);
        assertThat(w.cashier.get(base() + "/options").json().path("branches").size()).isEqualTo(2);
        var required = bill(w.cashier, 2_100);
        assertThat(required.status()).isEqualTo(422);
        assertThat(required.code()).isEqualTo("branch_required");

        Map<String, Object> chosen = sale(2_200, null, UUID.randomUUID());
        chosen.put("branchId", second.toString());
        var ok = bill(w.cashier, "key-branch-0001", chosen);
        assertThat(ok.status()).as(ok.body()).isEqualTo(201);
        assertThat(ok.json().path("branchId").asString()).isEqualTo(second.toString());
        assertThat(jdbc.queryForObject("select branch_id from invoices where id = ?", UUID.class, UUID.fromString(ok.json().path("invoiceId").asString()))).isEqualTo(second);

        // Branches that are not theirs: another business's, an inactive one, one the cashier is not assigned to.
        UUID unassigned = fixtures.branch(w.merchantId, "RM03", "ACTIVE");
        for (UUID bad : List.of(w.cafeBranchId, w.inactiveBranchId, unassigned, UUID.randomUUID())) {
            Map<String, Object> forged = sale(2_300, null, UUID.randomUUID());
            forged.put("branchId", bad.toString());
            var response = bill(w.cashier, "key-forged-" + bad.toString().substring(0, 8), forged);
            assertThat(response.status()).as(bad + ": " + response.body()).isEqualTo(422);
            assertThat(response.code()).isEqualTo("branch_not_eligible");
        }
        assertThat(count("invoices")).isEqualTo(2);
    }

    @Test
    void aPersonWithNoEligibleBranchGetsAClearSetupMessageAndNothingIsCreated() {
        ensureProfile();
        // The owner is not assigned to any branch in this world.
        var owner = bill(w.owner, 5_000);
        assertThat(owner.status()).isEqualTo(409);
        assertThat(owner.code()).isEqualTo("no_eligible_branch");
        assertThat(owner.json().path("message").asString()).contains("Create a branch, or assign yourself");
        // The options say the same thing, without failing.
        var options = w.owner.get(base() + "/options");
        assertThat(options.status()).isEqualTo(200);
        assertThat(options.json().path("readiness").asString()).isEqualTo("NO_BRANCH");
        assertThat(options.json().path("branches").size()).isZero();

        // A cashier whose only branch becomes inactive.
        jdbc.update("update branches set status = 'INACTIVE' where id = ?", w.branchId);
        var cashier = bill(w.cashier, 5_000);
        assertThat(cashier.code()).isEqualTo("no_eligible_branch");
        assertThat(cashier.json().path("message").asString()).contains("Ask your manager");
        assertThat(count("invoices")).isZero();
        assertThat(count("payment_requests")).isZero();
        // Nothing was created or assigned silently.
        assertThat(count("branches")).isEqualTo(3);
    }

    @Test
    void theOptionsDescribeWhatIsReadyAndWhatIsMissing() {
        // No payment link yet.
        var options = w.cashier.get(base() + "/options").json();
        assertThat(options.path("operatingMode").asString()).isEqualTo("SIMPLIFIED");
        assertThat(options.path("readiness").asString()).isEqualTo("NO_PAYMENT_LINK");
        assertThat(options.path("minAmountRwf").asLong()).isEqualTo(100);
        assertThat(options.path("maxAmountRwf").asLong()).isEqualTo(10_000_000);
        assertThat(options.path("paymentLifetimeMinutes").asInt()).isEqualTo(30);
        assertThat(options.path("branches").get(0).path("paymentReady").asBoolean()).isFalse();
        ensureProfile();
        var ready = w.cashier.get(base() + "/options").json();
        assertThat(ready.path("readiness").asString()).isEqualTo("READY");
        assertThat(ready.path("branches").get(0).path("paymentReady").asBoolean()).isTrue();
        // A business in BUSINESS mode is told so (200), with no branches offered.
        setMode(w.merchantId, "BUSINESS");
        var business = w.cashier.get(base() + "/options");
        assertThat(business.status()).isEqualTo(200);
        assertThat(business.json().path("readiness").asString()).isEqualTo("NOT_SIMPLIFIED");
        assertThat(business.json().path("branches").size()).isZero();
    }

    // ---- atomicity -----------------------------------------------------------------------------

    @Test
    void withoutAPaymentLinkTheWholeOperationRollsBackAndTheSameRequestWorksOnceItExists() {
        UUID clientRequestId = UUID.randomUUID();
        var body = sale(7_000, "Moto ride", clientRequestId);
        var failed = bill(w.cashier, "key-rollback-01", body);
        assertThat(failed.status()).isEqualTo(409);
        assertThat(failed.code()).isEqualTo("no_active_profile");
        assertNothingLeftBehind();

        // Fix the setup; the very same request (same key, same sale) now succeeds: nothing blocked it.
        ensureProfile();
        var retried = bill(w.cashier, "key-rollback-01", body);
        assertThat(retried.status()).as(retried.body()).isEqualTo(201);
        assertThat(count("invoices")).isEqualTo(1);
        // The invoice number was not burned by the failed attempt.
        assertThat(retried.json().path("invoiceNumber").asString()).isEqualTo("INV-0001");
    }

    @Test
    void withoutAConnectedDestinationTheWholeOperationRollsBack() {
        ensureProfile();
        jdbc.update("update bank_connections set status = 'DISABLED' where merchant_id = ?", w.merchantId);
        var failed = bill(w.cashier, 7_000);
        assertThat(failed.status()).isEqualTo(409);
        assertThat(failed.code()).isEqualTo("no_active_profile");
        assertNothingLeftBehind();
        assertThat(w.cashier.get(base() + "/options").json().path("readiness").asString()).isEqualTo("NO_PAYMENT_LINK");
    }

    private void assertNothingLeftBehind() {
        assertThat(count("invoices")).isZero();
        assertThat(count("invoice_items")).isZero();
        assertThat(count("payment_requests")).isZero();
        assertThat(count("idempotency_keys")).isZero();
        assertThat(count("invoice_number_sequences")).isZero();
        assertThat(jdbc.queryForObject("select count(*) from audit_log where kind in ('SIMPLE_CHECKOUT_BILLED', 'INVOICE_ISSUED', "
                + "'INVOICE_DRAFT_CREATED', 'PAYMENT_REQUEST_CREATED')", Integer.class)).isZero();
    }

    // ---- idempotency and concurrency -----------------------------------------------------------

    @Test
    void theSameKeyAndTheSameSaleReplayTheOriginalAnswerWithoutAnotherSale() {
        ensureProfile();
        var body = sale(9_000, "Moto ride", UUID.randomUUID());
        var first = bill(w.cashier, "key-replay-0001", body);
        var again = bill(w.cashier, "key-replay-0001", body);
        assertThat(first.status()).isEqualTo(201);
        assertThat(again.status()).isEqualTo(200);
        assertThat(again.json().path("invoiceId").asString()).isEqualTo(first.json().path("invoiceId").asString());
        assertThat(again.json().path("paymentRequestId").asString()).isEqualTo(first.json().path("paymentRequestId").asString());
        assertThat(again.json().path("publicReference").asString()).isEqualTo(first.json().path("publicReference").asString());
        assertThat(count("invoices")).isEqualTo(1);
        assertThat(count("payment_requests")).isEqualTo(1);
        assertThat(count("idempotency_keys")).isEqualTo(1);
    }

    @Test
    void aDifferentSaleUnderTheSameKeyOrTheSameSaleIdentifierIsAConflict() {
        ensureProfile();
        UUID clientRequestId = UUID.randomUUID();
        assertThat(bill(w.cashier, "key-conflict-001", sale(9_000, "Moto ride", clientRequestId)).status()).isEqualTo(201);

        // Same HTTP key, another amount: R2's check.
        var sameKey = bill(w.cashier, "key-conflict-001", sale(9_500, "Moto ride", clientRequestId));
        assertThat(sameKey.status()).isEqualTo(409);
        assertThat(sameKey.code()).isEqualTo("idempotency_key_reuse");
        // A new HTTP key but the same durable sale identifier with another amount or note: R3's check.
        var otherAmount = bill(w.cashier, "key-conflict-002", sale(9_500, "Moto ride", clientRequestId));
        assertThat(otherAmount.status()).isEqualTo(409);
        assertThat(otherAmount.code()).isEqualTo("client_request_id_reuse");
        var otherNote = bill(w.cashier, "key-conflict-003", sale(9_000, "Taxi", clientRequestId));
        assertThat(otherNote.code()).isEqualTo("client_request_id_reuse");
        // Another person cannot take over the identifier either.
        var otherPerson = bill(w.otherCashier, "key-conflict-004", sale(9_000, "Moto ride", clientRequestId));
        assertThat(otherPerson.status()).isEqualTo(409);
        assertThat(otherPerson.code()).isEqualTo("client_request_id_reuse");

        assertThat(count("invoices")).isEqualTo(1);
        assertThat(count("payment_requests")).isEqualTo(1);
        // The failed attempts left no idempotency records of their own.
        assertThat(count("idempotency_keys")).isEqualTo(1);
    }

    @Test
    void tenIdenticalConcurrentRequestsProduceOneSale() throws Exception {
        ensureProfile();
        var body = sale(12_000, "Moto ride", UUID.randomUUID());
        List<Callable<TestApi.Response>> requests = new ArrayList<>();
        for (int i = 0; i < 10; i++) {
            TestApi client = fixtures.signIn(mvc, w.cashierPerson);
            requests.add(() -> bill(client, "key-concurrent-1", body));
        }
        List<TestApi.Response> responses = concurrently(requests);
        assertThat(responses).filteredOn(r -> r.status() == 201).hasSize(1);
        assertThat(responses).filteredOn(r -> r.status() == 200).hasSize(9);
        assertThat(responses.stream().map(r -> r.json().path("invoiceId").asString()).distinct()).hasSize(1);
        assertThat(responses.stream().map(r -> r.json().path("publicReference").asString()).distinct()).hasSize(1);
        assertThat(count("invoices")).isEqualTo(1);
        assertThat(count("payment_requests")).isEqualTo(1);
        assertThat(count("idempotency_keys")).isEqualTo(1);
        assertThat(jdbc.queryForObject("select last_value from invoice_number_sequences", Integer.class)).isEqualTo(1);
    }

    @Test
    void tenConcurrentRequestsWithDifferentKeysButTheSameSaleIdentifierAlsoProduceOneSale() throws Exception {
        ensureProfile();
        var body = sale(12_000, "Moto ride", UUID.randomUUID());
        List<Callable<TestApi.Response>> requests = new ArrayList<>();
        for (int i = 0; i < 10; i++) {
            TestApi client = fixtures.signIn(mvc, w.cashierPerson);
            String key = "key-parallel-" + i + "-000";
            requests.add(() -> bill(client, key, body));
        }
        List<TestApi.Response> responses = concurrently(requests);
        assertThat(responses).filteredOn(r -> r.status() == 201).hasSize(1);
        assertThat(responses).filteredOn(r -> r.status() == 200).hasSize(9);
        assertThat(responses.stream().map(r -> r.json().path("invoiceId").asString()).distinct()).hasSize(1);
        assertThat(count("invoices")).isEqualTo(1);
        assertThat(count("payment_requests")).isEqualTo(1);
    }

    @Test
    void aRepeatedRequestAfterTheHttpRecordsArePrunedStillCannotDuplicateOrChangeTheSale() {
        ensureProfile();
        UUID clientRequestId = UUID.randomUUID();
        var body = sale(15_000, "Moto ride", clientRequestId);
        var first = bill(w.cashier, "key-prune-000001", body);
        assertThat(first.status()).isEqualTo(201);

        jdbc.update("delete from idempotency_keys");
        // The same key and the same sale (a lost response retried after a long time): the existing sale, again.
        var sameKey = bill(w.cashier, "key-prune-000001", body);
        assertThat(sameKey.status()).isEqualTo(200);
        assertThat(sameKey.json().path("invoiceId").asString()).isEqualTo(first.json().path("invoiceId").asString());
        assertThat(sameKey.json().path("paymentRequestId").asString()).isEqualTo(first.json().path("paymentRequestId").asString());

        jdbc.update("delete from idempotency_keys");
        var newKey = bill(w.cashier, "key-prune-000002", body);
        assertThat(newKey.status()).isEqualTo(200);
        assertThat(newKey.json().path("invoiceId").asString()).isEqualTo(first.json().path("invoiceId").asString());

        // A different sale under the same identifier is still refused.
        jdbc.update("delete from idempotency_keys");
        assertThat(bill(w.cashier, "key-prune-000003", sale(15_500, "Moto ride", clientRequestId)).code()).isEqualTo("client_request_id_reuse");
        assertThat(count("invoices")).isEqualTo(1);
        assertThat(count("payment_requests")).isEqualTo(1);
    }

    @Test
    void aReplayRechecksWhoIsAskingAndWhereTheyBelong() {
        ensureProfile();
        var body = sale(4_000, null, UUID.randomUUID());
        assertThat(bill(w.cashier, "key-authz-000001", body).status()).isEqualTo(201);

        // Someone else cannot read the result by presenting the same key.
        var otherCashier = bill(w.otherCashier, "key-authz-000001", body);
        assertThat(otherCashier.status()).isEqualTo(409);
        assertThat(otherCashier.code()).isEqualTo("idempotency_key_reuse");
        // Another business cannot either.
        assertThat(bill(w.cafeOwner, "key-authz-000001", body).status()).isEqualTo(404);
        // A person removed from the business gets nothing, even with the right key.
        jdbc.update("update memberships set status = 'SUSPENDED' where id = ?", w.cashierMembershipId);
        assertThat(bill(w.cashier, "key-authz-000001", body).status()).isEqualTo(404);
    }

    // ---- compatibility and payment handling ----------------------------------------------------

    @Test
    void aTraditionalInvoiceStillGetsItsSevenDayRequestAndItsOwnProvenance() {
        ensureProfile();
        UUID invoiceId = w.issuedInvoice(30_000);
        var request = w.owner.post("/api/v1/merchants/" + w.merchantId + "/invoices/" + invoiceId + "/payment-requests", null);
        assertThat(request.status()).isEqualTo(200);
        assertThat(Duration.between(Instant.parse(request.json().path("createdAt").asString()), Instant.parse(request.json().path("expiresAt").asString())))
                .isEqualTo(Duration.ofDays(7));
        assertThat(jdbc.queryForObject("select source from payment_requests where invoice_id = ?", String.class, invoiceId)).isEqualTo("INVOICE");
        assertThat(jdbc.queryForObject("select sale_channel from invoices where id = ?", String.class, invoiceId)).isEqualTo("INVOICE");
        // The simplified checkout in the same business does not disturb it.
        assertThat(bill(w.cashier, 1_500).status()).isEqualTo(201);
        assertThat(jdbc.queryForObject("select count(*) from payment_requests where invoice_id = ?", Integer.class, invoiceId)).isEqualTo(1);
    }

    @Test
    void aVerifiedBankPaymentReconcilesTheSaleExactlyOnce() {
        ensureProfile();
        var request = sale(20_000, null, UUID.randomUUID());
        var sale = bill(w.cashier, "key-paid-0000001", request).json();
        UUID invoiceId = UUID.fromString(sale.path("invoiceId").asString());
        String reference = sale.path("publicReference").asString();

        // Nothing is paid because a sale was created, or because a customer says so.
        assertThat(invoice(invoiceId).json().path("paymentStatus").asString()).isEqualTo("UNPAID");

        var paid = w.bank.send("POSTED", 20_000, reference, "tx-simple-1", "evt-simple-1", w.bank.at(1));
        assertThat(paid.outcome()).isEqualTo("APPLIED");
        assertThat(invoice(invoiceId).json().path("paymentStatus").asString()).isEqualTo("PAID");
        var requests = w.cashier.get("/api/v1/merchants/" + w.merchantId + "/invoices/" + invoiceId + "/payment-requests").json();
        assertThat(requests.get(0).path("status").asString()).isEqualTo("SETTLED");

        // A replayed event, and the same transaction under a new event id, change nothing.
        assertThat(w.bank.send("POSTED", 20_000, reference, "tx-simple-1", "evt-simple-1", w.bank.at(1)).outcome()).isEqualTo("DUPLICATE");
        assertThat(w.bank.send("POSTED", 20_000, reference, "tx-simple-1", "evt-simple-2", w.bank.at(2)).outcome()).isEqualTo("DUPLICATE");
        assertThat(count("payment_allocations")).isEqualTo(1);
        assertThat(count("bank_transactions")).isEqualTo(1);

        // Retrying the sale now returns its current state, and does not open another request for a paid invoice.
        var retried = bill(w.cashier, "key-paid-0000001", request);
        assertThat(retried.status()).isEqualTo(200);
        assertThat(retried.json().path("status").asString()).isEqualTo("SETTLED");
        assertThat(retried.json().path("invoiceId").asString()).isEqualTo(invoiceId.toString());
        assertThat(count("payment_requests")).isEqualTo(1);
        jdbc.update("delete from idempotency_keys");
        var afterPruning = bill(w.cashier, "key-paid-0000002", request);
        assertThat(afterPruning.status()).isEqualTo(200);
        assertThat(afterPruning.json().path("status").asString()).isEqualTo("SETTLED");
        assertThat(count("payment_requests")).isEqualTo(1);
    }

    @Test
    void lateAndInvalidBankEventsKeepTheirExistingSafeBehaviour() {
        ensureProfile();
        var sale = bill(w.cashier, 20_000).json();
        UUID invoiceId = UUID.fromString(sale.path("invoiceId").asString());
        String reference = sale.path("publicReference").asString();

        // A changed amount for an announced transaction, and an unknown account, are rejected and counted for nothing.
        w.bank.send("PENDING", 20_000, reference, "tx-simple-9", "evt-9a", w.bank.at(1));
        assertThat(w.bank.send("POSTED", 99_000, reference, "tx-simple-9", "evt-9b", w.bank.at(2)).outcome()).isEqualTo("REJECTED");
        assertThat(invoice(invoiceId).json().path("paymentStatus").asString()).isEqualTo("UNPAID");

        // An older confirmation arriving after a newer reversal is stale.
        w.bank.send("REVERSED", 20_000, reference, "tx-simple-8", "evt-8new", w.bank.at(10));
        assertThat(w.bank.send("POSTED", 20_000, reference, "tx-simple-8", "evt-8old", w.bank.at(3)).outcome()).isEqualTo("STALE");
        assertThat(invoice(invoiceId).json().path("paymentStatus").asString()).isEqualTo("UNPAID");

    }

    @Test
    void moneyConfirmedAfterTheRequestExpiredIsStillReconciled() {
        ensureProfile();
        var sale = bill(w.cashier, 20_000).json();
        UUID invoiceId = UUID.fromString(sale.path("invoiceId").asString());
        // Expiry only means "no longer collecting": money confirmed afterwards is still reconciled, never discarded.
        jdbc.update("update payment_requests set expires_at = now() - interval '1 minute' where invoice_id = ?", invoiceId);
        var requests = w.cashier.get("/api/v1/merchants/" + w.merchantId + "/invoices/" + invoiceId + "/payment-requests").json();
        assertThat(requests.get(0).path("status").asString()).isEqualTo("EXPIRED");
        var late = w.bank.send("POSTED", 20_000, sale.path("publicReference").asString(), "tx-simple-7", "evt-7", w.bank.at(20));
        assertThat(late.outcome()).isEqualTo("APPLIED");
        assertThat(invoice(invoiceId).json().path("paymentStatus").asString()).isEqualTo("PAID");
    }

    @Test
    void aCashierSeesOnlyTheirOwnSalesAndNoOneElsesCanBeReadThroughTheCheckout() {
        ensureProfile();
        var mine = bill(w.cashier, 3_000).json();
        var theirs = bill(w.otherCashier, 4_000).json();
        var list = w.cashier.get("/api/v1/merchants/" + w.merchantId + "/invoices").json().path("items");
        assertThat(list.size()).isEqualTo(1);
        assertThat(list.get(0).path("id").asString()).isEqualTo(mine.path("invoiceId").asString());
        assertThat(w.cashier.get("/api/v1/merchants/" + w.merchantId + "/invoices/" + theirs.path("invoiceId").asString()).status()).isEqualTo(404);
        // The manager sees both.
        assertThat(w.manager.get("/api/v1/merchants/" + w.merchantId + "/invoices").json().path("items").size()).isEqualTo(2);
    }

    // ---- infrastructure ------------------------------------------------------------------------

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
