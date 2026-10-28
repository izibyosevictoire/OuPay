package rw.oupay.checkout;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Callable;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpMethod;
import org.springframework.test.context.TestPropertySource;
import rw.oupay.support.TestApi;
import tools.jackson.databind.JsonNode;

/**
 * R6c: an authorised agent bills an amount through the merchant's collection code. One ledger (the invoice and the payment request of R2-R4),
 * a demonstration unless the code is bank-approved and live collection is enabled, and a sale that can always be fetched again.
 */
@TestPropertySource(properties = {
        "oupay.collection-codes.approval-enabled=true",
        "oupay.code-checkout.live-enabled=true",
        "oupay.code-checkout.instructions=Open the bank app|Pay to the merchant code shown"})
class CodeCheckoutIT extends CodeCheckoutTestSupport {

    /** A simulated, bank-approved code held by the cashier, plus the payment link a sale rides on. */
    private JsonNode demoCodeForCashier() {
        ensureProfile();
        JsonNode code = activeCode("Counter", "EQ-DEMO-1");
        assertThat(assign(code, cashierMembership).status()).isEqualTo(201);
        return code;
    }

    /** A real (non-simulated) approved code held by the cashier: eligible for live collection. */
    private JsonNode liveCodeForCashier() {
        makeAccountReal();
        ensureProfile();
        JsonNode code = activeCode("Live", "EQ-LIVE-77");
        assertThat(assign(code, cashierMembership).status()).isEqualTo(201);
        return code;
    }

    private String ref(TestApi.Response response) {
        return response.json().path("saleReference").asString();
    }

    // ---- the demonstration happy path ----------------------------------------------------------

    @Test
    void aSimulatedCodeBillsADemonstrationSaleOnTheOrdinaryInvoiceAndPaymentRequest() {
        JsonNode code = demoCodeForCashier();
        UUID clientRequestId = UUID.randomUUID();
        var response = bill(w.cashier, "key-demo-0001", body(15_000, "Two coffees", null, clientRequestId));
        assertThat(response.status()).as(response.body()).isEqualTo(201);
        var json = response.json();
        assertThat(json.path("amountRwf").asLong()).isEqualTo(15_000);
        assertThat(json.path("currency").asString()).isEqualTo("RWF");
        assertThat(json.path("description").asString()).isEqualTo("Two coffees");
        assertThat(json.path("saleReference").asString()).startsWith("OP-");
        assertThat(json.path("code").path("mode").asString()).isEqualTo("DEMONSTRATION");
        assertThat(json.path("code").path("bankCode").isNull() || json.path("code").path("bankCode").asString().isEmpty()).isTrue();
        assertThat(json.path("code").path("notice").asString()).contains("DEMONSTRATION ONLY");
        assertThat(response.body()).doesNotContain("EQ-DEMO-1");
        Instant created = Instant.parse(json.path("createdAt").asString());
        assertThat(Duration.between(created, Instant.parse(json.path("expiresAt").asString()))).isEqualTo(Duration.ofMinutes(30));

        UUID invoiceId = UUID.fromString(json.path("invoiceId").asString());
        var invoice = w.owner.get("/api/v1/merchants/" + w.merchantId + "/invoices/" + invoiceId).json();
        assertThat(invoice.path("status").asString()).isEqualTo("ISSUED");
        assertThat(invoice.path("saleChannel").asString()).isEqualTo("CODE");
        assertThat(invoice.path("grandTotal").asLong()).isEqualTo(15_000);
        assertThat(invoice.path("paymentStatus").asString()).isEqualTo("UNPAID");

        var request = jdbc.queryForMap("select source, requested_amount_rwf from payment_requests where invoice_id = ?", invoiceId);
        assertThat(request.get("source")).isEqualTo("CODE");
        assertThat(((Number) request.get("requested_amount_rwf")).longValue()).isEqualTo(15_000);

        var snapshot = jdbc.queryForMap("select * from code_sales where invoice_id = ?", invoiceId);
        assertThat(snapshot.get("presentation_mode")).isEqualTo("DEMONSTRATION");
        assertThat(snapshot.get("agent_user_id")).isEqualTo(w.cashierPerson.userId());
        assertThat(snapshot.get("collection_code_id").toString()).isEqualTo(code.path("id").asString());
        assertThat(snapshot.get("code_external_code")).isNull();
        assertThat(snapshot.get("code_is_simulated")).isEqualTo(true);
        assertThat(snapshot.get("branch_id")).isEqualTo(w.branchId);
        assertThat(snapshot.get("assignee_name")).isEqualTo("Aline Cashier");
        assertThat(snapshot.get("sale_reference")).isEqualTo(json.path("saleReference").asString());
        assertThat(count("audit_log")).isPositive();
        assertThat(jdbc.queryForObject("select count(*) from audit_log where kind = 'CODE_SALE_BILLED'", Integer.class)).isEqualTo(1);
    }

    @Test
    void theSaleIsRetrievableAfterARefreshAndTheCustomerPageShowsOnlyWhatTheCustomerNeeds() {
        demoCodeForCashier();
        var created = bill(w.cashier, 9_000);
        assertThat(created.status()).as(created.body()).isEqualTo(201);
        UUID saleId = UUID.fromString(created.json().path("saleId").asString());
        var again = w.cashier.get(sale() + "/" + saleId);
        assertThat(again.status()).isEqualTo(200);
        assertThat(again.json().path("saleReference").asString()).isEqualTo(ref(created));
        assertThat(again.raw().getHeader("Cache-Control")).contains("no-store");

        var page = publicSale(ref(created));
        assertThat(page.status()).as(page.body()).isEqualTo(200);
        assertThat(page.json().path("status").asString()).isEqualTo("AWAITING_PAYMENT");
        assertThat(page.json().path("merchantDisplayName").asString()).isEqualTo("Sample Shop Ltd");
        assertThat(page.json().path("code").path("mode").asString()).isEqualTo("DEMONSTRATION");
        assertThat(page.json().path("instructions").size()).isZero();
        assertThat(page.body()).doesNotContain("Aline").doesNotContain("SIM-").doesNotContain("agent");
        assertThat(page.raw().getHeader("Cache-Control")).contains("no-store");

        // The ordinary public payment pages never serve a code sale.
        String token = jdbc.queryForObject("select pp.public_token from payment_profiles pp join payment_requests pr on pr.payment_profile_id = pp.id "
                + "where pr.public_reference = ?", String.class, ref(created));
        var ordinary = TestApi.anonymous(mvc, HttpMethod.GET, "/api/v1/public/payment-profiles/" + token + "/requests/" + ref(created), null, Map.of());
        assertThat(ordinary.status()).isEqualTo(404);
        assertThat(publicSale("OP-NOSUCHREF1").status()).isEqualTo(404);
        assertThat(publicSale("not-a-reference").status()).isEqualTo(404);
    }

    // ---- authorization and isolation -----------------------------------------------------------

    @Test
    void onlyThePeopleHoldingACodeCanBillAndOthersAreToldTheyHaveNone() {
        demoCodeForCashier();
        assertThat(bill(w.owner, 1_000).code()).isEqualTo("no_assigned_code");
        assertThat(bill(w.manager, 1_000).code()).isEqualTo("no_assigned_code");
        assertThat(bill(w.otherCashier, 1_000).code()).isEqualTo("no_assigned_code");
        assertThat(count("code_sales")).isZero();
        assertThat(count("invoices")).isZero();
    }

    @Test
    void aSuspendedMemberAndAnotherBusinessCannotBill() {
        demoCodeForCashier();
        jdbc.update("update memberships set status = 'SUSPENDED' where id = ?", cashierMembership);
        var suspended = bill(w.cashier, 1_000);
        assertThat(suspended.status()).isIn(401, 403, 404);
        jdbc.update("update memberships set status = 'ACTIVE' where id = ?", cashierMembership);
        var cafe = bill(w.cafeOwner, 1_000);
        assertThat(cafe.status()).isIn(403, 404);
        assertThat(count("code_sales")).isZero();
    }

    @Test
    void optionsListOnlyTheCallersOwnCodesAndSayWhenThereAreNone() {
        demoCodeForCashier();
        var mine = w.cashier.get(sale() + "/options").json();
        assertThat(mine.path("readiness").asString()).isEqualTo("READY");
        assertThat(mine.path("codes").size()).isEqualTo(1);
        assertThat(mine.path("codes").get(0).path("mode").asString()).isEqualTo("DEMONSTRATION");
        assertThat(mine.path("codes").get(0).path("paymentReady").asBoolean()).isTrue();
        assertThat(w.cashier.get(sale() + "/options").body()).doesNotContain("EQ-DEMO-1");
        var none = w.otherCashier.get(sale() + "/options").json();
        assertThat(none.path("readiness").asString()).isEqualTo("NO_ASSIGNED_CODE");
        assertThat(none.path("codes").size()).isZero();
    }

    @Test
    void anAgentCannotFetchAnotherAgentsSaleOrAnotherBusinesssSale() {
        demoCodeForCashier();
        var created = bill(w.cashier, 2_000);
        UUID saleId = UUID.fromString(created.json().path("saleId").asString());
        assertThat(w.cafeOwner.get("/api/v1/merchants/" + w.cafeMerchantId + "/checkout/code-sale/" + saleId).status()).isEqualTo(404);
        assertThat(w.cafeOwner.get(sale() + "/" + saleId).status()).isIn(403, 404);
        assertThat(w.otherCashier.get(sale() + "/" + saleId).status()).isIn(403, 404);
        assertThat(w.owner.get(sale() + "/" + saleId).status()).isEqualTo(200);
        assertThat(w.cashier.get(sale() + "/" + UUID.randomUUID()).status()).isEqualTo(404);
    }

    // ---- eligibility and live collection -------------------------------------------------------

    @Test
    void aSimulatedCodeIsNeverPresentedAsLiveEvenWhenLiveCollectionIsEnabled() {
        demoCodeForCashier();
        var response = bill(w.cashier, 3_000);
        assertThat(response.json().path("code").path("mode").asString()).isEqualTo("DEMONSTRATION");
        assertThat(publicSale(ref(response)).json().path("instructions").size()).isZero();
    }

    @Test
    void anApprovedRealCodeBillsALiveSaleWithTheBankCodeAndOnlyConfiguredInstructions() {
        liveCodeForCashier();
        var response = bill(w.cashier, 4_000);
        assertThat(response.status()).as(response.body()).isEqualTo(201);
        assertThat(response.json().path("code").path("mode").asString()).isEqualTo("LIVE");
        assertThat(response.json().path("code").path("bankCode").asString()).isEqualTo("EQ-LIVE-77");
        var page = publicSale(ref(response));
        assertThat(page.json().path("code").path("bankCode").asString()).isEqualTo("EQ-LIVE-77");
        assertThat(page.json().path("instructions").size()).isEqualTo(2);
        assertThat(page.json().path("instructions").get(0).asString()).isEqualTo("Open the bank app");
        assertThat(page.json().path("statusNote").asString()).contains("Nothing has been received yet");
        assertThat(jdbc.queryForObject("select code_external_code from code_sales", String.class)).isEqualTo("EQ-LIVE-77");
    }

    @Test
    void anUnapprovedRealCodeCannotBeBilledAsLive() {
        makeAccountReal();
        ensureProfile();
        JsonNode pending = pendingCode("Waiting");
        assertThat(assign(pending, cashierMembership).status()).isEqualTo(201);
        var response = bill(w.cashier, 5_000);
        assertThat(response.status()).isIn(409, 422);
        assertThat(response.code()).isIn("code_not_available", "live_collection_unavailable");
        assertThat(count("code_sales")).isZero();
        assertThat(count("invoices")).isZero();
        assertThat(count("payment_requests")).isZero();
    }

    @Test
    void aDisconnectedSettlementAccountBlocksBilling() {
        demoCodeForCashier();
        jdbc.update("update bank_connections set status = 'DISABLED' where merchant_id = ?", w.merchantId);
        var response = bill(w.cashier, 5_000);
        assertThat(response.status()).isIn(409, 422);
        assertThat(count("code_sales")).isZero();
    }

    @Test
    void aSuspendedCodeAndAnInactiveBranchBlockBilling() {
        JsonNode code = demoCodeForCashier();
        jdbc.update("update collection_codes set status = 'SUSPENDED', status_reason = 'Paused' where id = ?::uuid", code.path("id").asString());
        assertThat(bill(w.cashier, 5_000).code()).isEqualTo("code_not_available");
        jdbc.update("update collection_codes set status = 'ACTIVE', status_reason = null where id = ?::uuid", code.path("id").asString());
        assertThat(bill(w.cashier, 5_000).status()).isEqualTo(201);
        assertThat(count("code_sales")).isEqualTo(1);
    }

    @Test
    void aCodeWithoutAPaymentLinkOnItsOwnSettlementAccountLeavesNothingBehind() {
        JsonNode code = activeCode("Counter", "EQ-DEMO-1");
        assertThat(assign(code, cashierMembership).status()).isEqualTo(201);
        var response = bill(w.cashier, 5_000);
        assertThat(response.status()).isIn(409, 422);
        assertThat(count("code_sales")).isZero();
        assertThat(count("invoices")).isZero();
        assertThat(count("payment_requests")).isZero();
        assertThat(count("idempotency_keys")).isZero();
    }

    @Test
    void theRequestRidesOnALinkOfTheCodesOwnSettlementAccount() {
        UUID profile = ensureProfile();
        JsonNode code = activeCode("Counter", "EQ-DEMO-1");
        assertThat(assign(code, cashierMembership).status()).isEqualTo(201);
        var response = bill(w.cashier, 6_000);
        assertThat(response.status()).as(response.body()).isEqualTo(201);
        UUID used = jdbc.queryForObject("select payment_profile_id from payment_requests where public_reference = ?", UUID.class, ref(response));
        assertThat(used).isEqualTo(profile);
        UUID linkDestination = jdbc.queryForObject("select payment_destination_id from payment_profiles where id = ?", UUID.class, used);
        assertThat(linkDestination).isEqualTo(destination);
        assertThat(jdbc.queryForObject("select settlement_destination_id from code_sales", UUID.class)).isEqualTo(destination);
    }

    // ---- idempotency ---------------------------------------------------------------------------

    @Test
    void anIdenticalRetryReturnsTheSameSaleAndAConflictingOneIsRefused() {
        demoCodeForCashier();
        UUID clientRequestId = UUID.randomUUID();
        var body = body(7_000, "Lunch", null, clientRequestId);
        var first = bill(w.cashier, "key-idem-0001", body);
        var second = bill(w.cashier, "key-idem-0001", body);
        assertThat(first.status()).isEqualTo(201);
        assertThat(second.status()).isEqualTo(200);
        assertThat(second.json().path("saleId").asString()).isEqualTo(first.json().path("saleId").asString());
        assertThat(ref(second)).isEqualTo(ref(first));
        assertThat(count("code_sales")).isEqualTo(1);
        assertThat(count("invoices")).isEqualTo(1);

        assertThat(bill(w.cashier, "key-idem-0001", body(8_000, "Lunch", null, clientRequestId)).status()).isEqualTo(409);
        // The same stable sale identifier under a new key and a different amount is a conflict too, never a second sale.
        var reused = bill(w.cashier, "key-idem-0002", body(8_000, "Lunch", null, clientRequestId));
        assertThat(reused.status()).isEqualTo(409);
        assertThat(reused.code()).isEqualTo("client_request_id_reuse");
        // ... and with the same content it is the original sale.
        var sameContent = bill(w.cashier, "key-idem-0003", body);
        assertThat(sameContent.status()).isEqualTo(200);
        assertThat(sameContent.json().path("saleId").asString()).isEqualTo(first.json().path("saleId").asString());
        assertThat(count("code_sales")).isEqualTo(1);
    }

    @Test
    void anotherUserCannotReplayAKeyOrTheSameClientRequest() {
        demoCodeForCashier();
        UUID clientRequestId = UUID.randomUUID();
        var body = body(7_000, null, null, clientRequestId);
        assertThat(bill(w.cashier, "key-idem-0010", body).status()).isEqualTo(201);
        var other = bill(w.otherCashier, "key-idem-0010", body);
        assertThat(other.status()).isIn(403, 404, 409, 422);
        assertThat(count("code_sales")).isEqualTo(1);
    }

    @Test
    void tenConcurrentIdenticalRequestsCreateExactlyOneSale() throws Exception {
        demoCodeForCashier();
        UUID clientRequestId = UUID.randomUUID();
        var body = body(11_000, "Rush", null, clientRequestId);
        List<Callable<TestApi.Response>> tasks = new ArrayList<>();
        for (int i = 0; i < 10; i++) {
            tasks.add(() -> bill(w.cashier, "key-conc-0001", body));
        }
        List<TestApi.Response> responses = concurrently(tasks);
        long created = responses.stream().filter(r -> r.status() == 201).count();
        assertThat(created).isEqualTo(1);
        assertThat(responses).allSatisfy(r -> assertThat(r.status()).as(r.body()).isIn(200, 201, 409));
        assertThat(count("code_sales")).isEqualTo(1);
        assertThat(count("invoices")).isEqualTo(1);
        assertThat(count("payment_requests")).isEqualTo(1);
    }

    @Test
    void tenConcurrentRequestsWithTheSameClientRequestIdButDifferentKeysCreateOneSale() throws Exception {
        demoCodeForCashier();
        UUID clientRequestId = UUID.randomUUID();
        var body = body(11_000, "Rush", null, clientRequestId);
        List<Callable<TestApi.Response>> tasks = new ArrayList<>();
        for (int i = 0; i < 10; i++) {
            String key = "key-conc-1" + String.format("%03d", i);
            tasks.add(() -> bill(w.cashier, key, body));
        }
        List<TestApi.Response> responses = concurrently(tasks);
        assertThat(responses).allSatisfy(r -> assertThat(r.status()).as(r.body()).isIn(200, 201, 409));
        assertThat(count("code_sales")).isEqualTo(1);
        assertThat(count("invoices")).isEqualTo(1);
    }

    @Test
    void aReplayAfterTheKeyRecordIsGoneStillReturnsTheOriginalSale() {
        demoCodeForCashier();
        UUID clientRequestId = UUID.randomUUID();
        var body = body(7_000, null, null, clientRequestId);
        var first = bill(w.cashier, "key-gone-0001", body);
        jdbc.update("delete from idempotency_keys");
        var replay = bill(w.cashier, "key-gone-0009", body);
        assertThat(replay.status()).as(replay.body()).isEqualTo(200);
        assertThat(replay.json().path("saleId").asString()).isEqualTo(first.json().path("saleId").asString());
        assertThat(count("code_sales")).isEqualTo(1);
    }

    @Test
    void aReplayIsAuthorisedAgainBeforeAnythingIsReturned() {
        demoCodeForCashier();
        var body = body(7_000, null, null, UUID.randomUUID());
        assertThat(bill(w.cashier, "key-auth-0001", body).status()).isEqualTo(201);
        jdbc.update("update memberships set status = 'SUSPENDED' where id = ?", cashierMembership);
        var replay = bill(w.cashier, "key-auth-0001", body);
        assertThat(replay.status()).isIn(401, 403, 404);
        assertThat(replay.body()).doesNotContain("saleReference");
    }

    @Test
    void aMissingKeyIsRefused() {
        demoCodeForCashier();
        var response = w.cashier.send(HttpMethod.POST, sale(), body(1_000, null, null, UUID.randomUUID()), Map.of());
        assertThat(response.status()).isIn(400, 422);
        assertThat(count("code_sales")).isZero();
    }

    // ---- rollback ------------------------------------------------------------------------------

    @Test
    void aFailureWhileRecordingTheSaleLeavesNoIssuedInvoiceAndNoKey() {
        demoCodeForCashier();
        jdbc.execute("create or replace function fail_code_sale() returns trigger language plpgsql as $$ begin raise exception 'injected failure'; end $$");
        jdbc.execute("create trigger zz_fail_code_sale before insert on code_sales for each row execute function fail_code_sale()");
        try {
            var failed = bill(w.cashier, "key-fail-0001", body(5_000, null, null, UUID.randomUUID()));
            assertThat(failed.status()).isGreaterThanOrEqualTo(400);
            assertThat(count("invoices")).isZero();
            assertThat(count("payment_requests")).isZero();
            assertThat(count("code_sales")).isZero();
            assertThat(count("idempotency_keys")).isZero();
        } finally {
            jdbc.execute("drop trigger zz_fail_code_sale on code_sales");
            jdbc.execute("drop function fail_code_sale()");
        }
        // Once the fault is gone, the same key works and the invoice number sequence has no gap.
        var ok = bill(w.cashier, "key-fail-0001", body(5_000, null, null, UUID.randomUUID()));
        assertThat(ok.status()).as(ok.body()).isEqualTo(201);
        assertThat(count("invoices")).isEqualTo(1);
    }

    @Test
    void aFailureWhileAuditingRollsTheWholeSaleBack() {
        demoCodeForCashier();
        jdbc.execute("create or replace function fail_code_audit() returns trigger language plpgsql as $$ begin "
                + "if new.kind = 'CODE_SALE_BILLED' then raise exception 'injected audit failure'; end if; return new; end $$");
        jdbc.execute("create trigger zz_fail_code_audit before insert on audit_log for each row execute function fail_code_audit()");
        try {
            var failed = bill(w.cashier, "key-fail-0002", body(5_000, null, null, UUID.randomUUID()));
            assertThat(failed.status()).isGreaterThanOrEqualTo(400);
            assertThat(jdbc.queryForObject("select count(*) from invoices where status = 'ISSUED'", Integer.class)).isZero();
            assertThat(count("payment_requests")).isZero();
            assertThat(count("code_sales")).isZero();
        } finally {
            jdbc.execute("drop trigger zz_fail_code_audit on audit_log");
            jdbc.execute("drop function fail_code_audit()");
        }
    }

    // ---- reassignment and historical attribution -----------------------------------------------

    @Test
    void reassigningTheCodeNeverRewritesTheHistoricalSale() {
        JsonNode code = demoCodeForCashier();
        UUID clientRequestId = UUID.randomUUID();
        var body = body(12_000, null, null, clientRequestId);
        var first = bill(w.cashier, "key-re-0001", body);
        assertThat(first.status()).isEqualTo(201);
        UUID saleId = UUID.fromString(first.json().path("saleId").asString());
        String openAssignment = jdbc.queryForObject("select id::text from collection_code_assignments where code_id = ?::uuid and valid_to is null",
                String.class, code.path("id").asString());

        var moved = reassign(code, openAssignment, otherCashierMembership, "Shift change");
        assertThat(moved.status()).as(moved.body()).isEqualTo(200);

        // The original sale is unchanged and still attributed to the first agent.
        assertThat(jdbc.queryForObject("select agent_user_id from code_sales where payment_request_id = ?", UUID.class, saleId)).isEqualTo(w.cashierPerson.userId());
        assertThat(jdbc.queryForObject("select assignee_name from code_sales where payment_request_id = ?", String.class, saleId)).isEqualTo("Aline Cashier");
        // It can still be fetched, and the same request replays to it, even though the code is no longer theirs.
        assertThat(w.cashier.get(sale() + "/" + saleId).status()).isEqualTo(200);
        var replay = bill(w.cashier, "key-re-0002", body);
        assertThat(replay.status()).as(replay.body()).isIn(200, 403, 404, 409);
        assertThat(count("code_sales")).isEqualTo(1);
        // The previous agent can no longer bill; the new one can, and is the one recorded.
        assertThat(bill(w.cashier, 1_000).code()).isEqualTo("no_assigned_code");
        // Another agent reusing the first agent's client request id is a conflict, not a hijack.
        var hijack = bill(w.otherCashier, "key-re-0003", body);
        assertThat(hijack.status()).isEqualTo(409);
        var second = bill(w.otherCashier, 13_000);
        assertThat(second.status()).as(second.body()).isEqualTo(201);
        assertThat(jdbc.queryForObject("select agent_user_id from code_sales where sale_reference = ?", UUID.class, ref(second)))
                .isEqualTo(w.otherCashierPerson.userId());
        assertThat(count("code_sales")).isEqualTo(2);
    }

    // ---- payment status ------------------------------------------------------------------------

    @Test
    void anExpiredSaleIsShownAsExpired() {
        demoCodeForCashier();
        var sale = bill(w.cashier, 10_000);
        jdbc.update("update payment_requests set expires_at = now() - interval '1 minute' where public_reference = ?", ref(sale));
        assertThat(publicSale(ref(sale)).json().path("status").asString()).isEqualTo("EXPIRED");
    }

    // ---- validation ----------------------------------------------------------------------------

    @Test
    void amountsMustBeWholeRwfWithinTheLimits() {
        demoCodeForCashier();
        assertThat(bill(w.cashier, 0).status()).isEqualTo(422);
        assertThat(bill(w.cashier, -5).status()).isEqualTo(422);
        assertThat(bill(w.cashier, 100.5).status()).isEqualTo(422);
        assertThat(bill(w.cashier, 99_999_999_999L).status()).isEqualTo(422);
        assertThat(bill(w.cashier, "abc").status()).isGreaterThanOrEqualTo(400);
        assertThat(w.cashier.send(HttpMethod.POST, sale(), Map.of("clientRequestId", UUID.randomUUID().toString()), Map.of("Idempotency-Key", "key-val-0001")).status())
                .isGreaterThanOrEqualTo(400);
        assertThat(bill(w.cashier, "key-val-0002", body(1_000, "x".repeat(121), null, UUID.randomUUID())).status()).isGreaterThanOrEqualTo(400);
        assertThat(count("code_sales")).isZero();
    }

    @Test
    void clientSuppliedBankFieldsAreIgnored() {
        demoCodeForCashier();
        var tampered = new java.util.HashMap<>(body(2_000, null, null, UUID.randomUUID()));
        tampered.put("bankCode", "EQ-EVIL-1");
        tampered.put("status", "PAID");
        tampered.put("agentUserId", w.ownerPerson.userId().toString());
        tampered.put("assignmentId", UUID.randomUUID().toString());
        tampered.put("presentationMode", "LIVE");
        var response = bill(w.cashier, "key-tamper-001", tampered);
        assertThat(response.status()).as(response.body()).isIn(201, 400);
        if (response.status() == 201) {
            assertThat(response.body()).doesNotContain("EQ-EVIL-1");
            assertThat(response.json().path("code").path("mode").asString()).isEqualTo("DEMONSTRATION");
            assertThat(jdbc.queryForObject("select agent_user_id from code_sales", UUID.class)).isEqualTo(w.cashierPerson.userId());
        }
    }

    @Test
    void aCodeMustBeChosenWhenSeveralAreHeldAndOnlyOwnCodesAreAccepted() {
        JsonNode first = demoCodeForCashier();
        JsonNode second = activeCode("Second", "EQ-DEMO-2");
        assertThat(assign(second, cashierMembership).status()).isEqualTo(201);
        JsonNode foreign = activeCode("Foreign", "EQ-DEMO-3");
        assertThat(assign(foreign, otherCashierMembership).status()).isEqualTo(201);

        assertThat(bill(w.cashier, "key-pick-0001", body(1_000, null, null, UUID.randomUUID())).code()).isEqualTo("code_required");
        assertThat(bill(w.cashier, "key-pick-0002", body(1_000, null, UUID.fromString(foreign.path("id").asString()), UUID.randomUUID())).code())
                .isEqualTo("code_not_assigned");
        var chosen = bill(w.cashier, "key-pick-0003", body(1_000, null, UUID.fromString(second.path("id").asString()), UUID.randomUUID()));
        assertThat(chosen.status()).as(chosen.body()).isEqualTo(201);
        assertThat(jdbc.queryForObject("select collection_code_id::text from code_sales", String.class)).isEqualTo(second.path("id").asString());
        assertThat(first.path("id").asString()).isNotEqualTo(second.path("id").asString());
    }

    // ---- the database guards the record itself -------------------------------------------------

    @Test
    void aSaleRecordCannotBeChangedOrDeleted() {
        demoCodeForCashier();
        var sale = bill(w.cashier, 3_000);
        UUID id = UUID.fromString(sale.json().path("saleId").asString());
        org.junit.jupiter.api.Assertions.assertThrows(Exception.class, () -> jdbc.update("update code_sales set amount_rwf = 1 where payment_request_id = ?", id));
        org.junit.jupiter.api.Assertions.assertThrows(Exception.class, () -> jdbc.update("update code_sales set agent_user_id = ? where payment_request_id = ?",
                w.ownerPerson.userId(), id));
        org.junit.jupiter.api.Assertions.assertThrows(Exception.class, () -> jdbc.update("delete from code_sales where payment_request_id = ?", id));
        assertThat(count("code_sales")).isEqualTo(1);
    }

    @Test
    void theDatabaseCarriesTheHonestyAndOwnershipConstraints() {
        List<String> names = jdbc.queryForList("select conname from pg_constraint where conrelid = 'code_sales'::regclass", String.class);
        assertThat(names).contains("ck_code_sales_honesty", "ck_code_sales_mode", "ck_code_sales_amount", "fk_code_sales_request", "fk_code_sales_invoice",
                "fk_code_sales_code", "fk_code_sales_assignment", "fk_code_sales_destination");
        demoCodeForCashier();
        var sale = bill(w.cashier, 3_000);
        UUID id = UUID.fromString(sale.json().path("saleId").asString());
        // A LIVE sale of a simulated code, and one without a bank code, are refused (the record cannot claim more than the code is).
        org.junit.jupiter.api.Assertions.assertThrows(Exception.class, () -> jdbc.update(
                "insert into code_sales select * from code_sales where payment_request_id = ?", id));
    }
}
