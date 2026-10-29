package rw.oupay.checkout;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Callable;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpMethod;
import org.springframework.test.context.TestPropertySource;
import rw.oupay.support.Bank;
import rw.oupay.support.TestApi;
import tools.jackson.databind.JsonNode;

/**
 * R6d-B review: manual allocation of bank money to a LIVE code sale when the bank did NOT report the code. It is an authorised person's
 * explicit decision, with a written reason and their identity in the immutable audit trail, on verified funds that reached the sale's own
 * account; it can never override contradicting bank evidence, never reaches a demonstration, never invents a bank code, and never makes an
 * agent "confirmed". The sale can be financially PAID while its code and agent stay unconfirmed, and the read model says so.
 */
@TestPropertySource(properties = {
        "oupay.collection-codes.approval-enabled=true",
        "oupay.code-checkout.live-enabled=true"})
class CodeSaleManualReconciliationIT extends CodeCheckoutTestSupport {

    private static final String CODE = "EQ-LIVE-A1";
    private static final String REASON = "Customer showed the bank SMS and the till slip";

    private JsonNode liveCode;

    private JsonNode live() {
        if (liveCode == null) {
            makeAccountReal();
            ensureProfile();
            liveCode = activeCode("Live", CODE);
            assertThat(assign(liveCode, cashierMembership).status()).isEqualTo(201);
        }
        return liveCode;
    }

    private JsonNode liveSale(long amount) {
        var created = bill(w.cashier, "key-" + UUID.randomUUID(), body(amount, null, UUID.fromString(id(live())), UUID.randomUUID()));
        assertThat(created.status()).as(created.body()).isEqualTo(201);
        return created.json();
    }

    private String ref(JsonNode sale) {
        return sale.path("saleReference").asString();
    }

    private String m(String path) {
        return "/api/v1/merchants/" + w.merchantId + path;
    }

    private Map<String, Object> tx(String providerTransactionId) {
        return jdbc.queryForMap("select * from bank_transactions where provider_transaction_id = ?", providerTransactionId);
    }

    private JsonNode view(Bank.Delivery delivery) {
        var response = w.owner.get(m("/bank-attributions/" + tx(delivery.transactionId()).get("id")));
        assertThat(response.status()).as(response.body()).isEqualTo(200);
        return response.json();
    }

    private long allocatedTo(JsonNode sale) {
        return jdbc.queryForObject("select coalesce(sum(amount_rwf), 0) from payment_allocations where invoice_id = ?::uuid and status = 'ACTIVE'", Long.class,
                sale.path("invoiceId").asString());
    }

    private String paymentStatus(JsonNode sale) {
        return w.owner.get(m("/invoices/" + sale.path("invoiceId").asString())).json().path("paymentStatus").asString();
    }

    private TestApi.Response manual(TestApi api, Bank.Delivery delivery, JsonNode sale, long amount, long expectedRemaining, String note) {
        var row = tx(delivery.transactionId());
        long version = w.owner.get(m("/bank-transactions/" + row.get("id"))).json().path("transaction").path("version").asLong();
        Map<String, Object> body = new java.util.HashMap<>();
        body.put("bankTransactionId", row.get("id").toString());
        body.put("expectedTransactionVersion", version);
        body.put("allocations", List.of(Map.of("invoiceId", sale.path("invoiceId").asString(), "amount", amount, "expectedRemainingBalance", expectedRemaining)));
        if (note != null) {
            body.put("note", note);
        }
        return api.post(m("/reconciliation/allocations"), body);
    }

    private TestApi.Response manual(Bank.Delivery delivery, JsonNode sale, long amount, String note) {
        return manual(w.owner, delivery, sale, amount, 12_000, note);
    }

    /** A payment that names the sale but reported no code: the bank evidence is incomplete, so nothing is matched automatically. */
    private Bank.Delivery named(JsonNode sale, long amount) {
        var delivery = w.bank.pay("POSTED", amount, ref(sale));
        assertThat(tx(delivery.transactionId()).get("review_state")).isEqualTo("NEEDS_REVIEW");
        assertThat(count("payment_allocations")).isZero();
        return delivery;
    }

    // ---- the reason -----------------------------------------------------------------------------------------------------------------

    @Test
    void aManualAllocationToACodeSaleNeedsAMeaningfulReasonAndNothingIsAppliedWithoutOne() {
        JsonNode sale = liveSale(12_000);
        var delivery = named(sale, 12_000);
        for (String reason : new String[] {null, "", "   ", "ok", "too short", "aaaaaaaaaaaa", "............"}) {
            var refused = manual(delivery, sale, 12_000, reason);
            assertThat(refused.status()).as("reason: " + reason).isEqualTo(422);
            assertThat(refused.code()).isEqualTo("reconciliation_reason_required");
        }
        assertThat(count("payment_allocations")).isZero();
        assertThat(allocatedTo(sale)).isZero();
        assertThat(paymentStatus(sale)).isEqualTo("UNPAID");
    }

    @Test
    void theReasonAndTheActorAreWrittenToTheImmutableAuditTrailWithTheAllocation() {
        JsonNode sale = liveSale(12_000);
        var delivery = named(sale, 12_000);
        var applied = manual(delivery, sale, 12_000, REASON);
        assertThat(applied.status()).as(applied.body()).isEqualTo(200);
        UUID transaction = (UUID) tx(delivery.transactionId()).get("id");
        var audit = jdbc.queryForMap("select actor_user_id, bank_transaction_id, invoice_id, message from audit_log where kind = 'MANUAL_ALLOCATED'");
        assertThat(audit.get("actor_user_id")).isEqualTo(w.ownerPerson.userId());
        assertThat(audit.get("bank_transaction_id")).isEqualTo(transaction);
        assertThat(audit.get("invoice_id").toString()).isEqualTo(sale.path("invoiceId").asString());
        assertThat(audit.get("message").toString()).contains(REASON).contains("Manually applied RWF 12000");
        var allocation = jdbc.queryForMap("select origin, created_by_user_id, bank_transaction_id from payment_allocations");
        assertThat(allocation.get("origin")).isEqualTo("MANUAL");
        assertThat(allocation.get("created_by_user_id")).isEqualTo(w.ownerPerson.userId());
        // The audit trail can not be edited or removed.
        assertThatThrownBy(() -> jdbc.update("update audit_log set message = 'edited' where kind = 'MANUAL_ALLOCATED'")).isNotNull();
        assertThatThrownBy(() -> jdbc.update("delete from audit_log where kind = 'MANUAL_ALLOCATED'")).isNotNull();
    }

    @Test
    void ifTheAuditCanNotBeWrittenTheAllocationIsNotMade() {
        JsonNode sale = liveSale(12_000);
        var delivery = named(sale, 12_000);
        jdbc.execute("create or replace function fail_manual_audit() returns trigger language plpgsql as $$ begin "
                + "if new.kind = 'MANUAL_ALLOCATED' then raise exception 'injected audit failure'; end if; return new; end $$");
        jdbc.execute("create trigger zz_fail_manual_audit before insert on audit_log for each row execute function fail_manual_audit()");
        try {
            var failed = manual(delivery, sale, 12_000, REASON);
            assertThat(failed.status()).isGreaterThanOrEqualTo(400);
            assertThat(count("payment_allocations")).isZero();
            assertThat(paymentStatus(sale)).isEqualTo("UNPAID");
        } finally {
            jdbc.execute("drop trigger zz_fail_manual_audit on audit_log");
            jdbc.execute("drop function fail_manual_audit()");
        }
        // Without the fault the same request works: no reason, no allocation; reason, allocation, audit together.
        assertThat(manual(delivery, sale, 12_000, REASON).status()).isEqualTo(200);
        assertThat(count("payment_allocations")).isEqualTo(1);
    }

    @Test
    void nobodyUnauthenticatedOrOutsideTheBusinessCanReconcile() {
        JsonNode sale = liveSale(12_000);
        var delivery = named(sale, 12_000);
        var row = tx(delivery.transactionId());
        Map<String, Object> body = Map.of("bankTransactionId", row.get("id").toString(), "expectedTransactionVersion", 0,
                "allocations", List.of(Map.of("invoiceId", sale.path("invoiceId").asString(), "amount", 12_000, "expectedRemainingBalance", 12_000)), "note", REASON);
        assertThat(TestApi.anonymous(mvc, HttpMethod.POST, m("/reconciliation/allocations"), body, Map.of()).status()).isIn(401, 403);
        // A cashier has no reconcile permission; another business can not even see the transaction.
        assertThat(manual(w.cashier, delivery, sale, 12_000, 12_000, REASON).status()).isIn(403, 404);
        assertThat(w.cafeOwner.post("/api/v1/merchants/" + w.cafeMerchantId + "/reconciliation/allocations", body).status()).isIn(403, 404);
        assertThat(count("payment_allocations")).isZero();
        // At the database, a manual allocation without a person is refused too.
        assertThatThrownBy(() -> jdbc.update("insert into payment_allocations (id, merchant_id, bank_transaction_id, invoice_id, amount_rwf, status, origin, created_at) "
                + "values (?, ?, ?, ?::uuid, 12000, 'ACTIVE', 'MANUAL', now())", UUID.randomUUID(), w.merchantId, row.get("id"), sale.path("invoiceId").asString())).isNotNull();
    }

    // ---- nothing about the bank's evidence is invented -----------------------------------------------------------------------------

    @Test
    void aManualAllocationNeverInventsABankCodeOrConfirmsTheAgentAndTheReadModelSaysSo() {
        JsonNode sale = liveSale(12_000);
        var delivery = named(sale, 12_000);
        Map<String, Object> before = tx(delivery.transactionId());
        assertThat(manual(delivery, sale, 12_000, REASON).status()).isEqualTo(200);

        Map<String, Object> after = tx(delivery.transactionId());
        for (String column : List.of("reported_code", "collection_code_id", "attribution_status", "attribution_basis", "agent_attribution",
                "referenced_code_sale_id", "settlement_destination_id", "origin_provider_event_id", "payment_request_id", "payment_reference")) {
            assertThat(after.get(column)).as(column).isEqualTo(before.get(column));
        }
        assertThat(after.get("reported_code")).isNull();
        assertThat(after.get("collection_code_id")).isNull();
        assertThat(after.get("agent_attribution")).isEqualTo("SALE_NAMED_UNCONFIRMED");

        // The sale is financially PAID; the code and the agent are NOT confirmed; and it is visibly a manual reconciliation.
        assertThat(paymentStatus(sale)).isEqualTo("PAID");
        JsonNode view = view(delivery);
        assertThat(view.path("saleFullyPaid").asBoolean()).isTrue();
        assertThat(view.path("allocatedToSaleRwf").asLong()).isEqualTo(12_000);
        assertThat(view.path("allocationOrigin").asString()).isEqualTo("MANUAL");
        assertThat(view.path("codeResolved").asBoolean()).isFalse();
        assertThat(view.path("saleReferenceMatched").asBoolean()).isFalse();
        assertThat(view.path("agentAttribution").asString()).isEqualTo("SALE_NAMED_UNCONFIRMED");
        assertThat(view.path("agentName").isMissingNode() || view.path("agentName").isNull()).isTrue();
        assertThat(view.toString()).doesNotContain("Aline");
        // The agent's own list does not show it either: they were never confirmed as the collector.
        assertThat(w.cashier.get(m("/bank-attributions")).json().path("items").size()).isZero();
    }

    @Test
    void automaticallyMatchedMoneyIsLabelledAutomaticAndManualMoneyManual() {
        JsonNode sale = liveSale(12_000);
        var auto = w.bank.payWithCode("POSTED", 5_000, ref(sale), CODE);
        assertThat(view(auto).path("allocationOrigin").asString()).isEqualTo("AUTO_REFERENCE");
        var byHand = w.bank.pay("POSTED", 7_000, ref(sale));
        assertThat(manual(w.owner, byHand, sale, 7_000, 7_000, REASON).status()).isEqualTo(200);
        assertThat(view(byHand).path("allocationOrigin").asString()).isEqualTo("MANUAL");
        assertThat(paymentStatus(sale)).isEqualTo("PAID");
        assertThat(view(auto).path("agentAttribution").asString()).isEqualTo("CONFIRMED_FROM_SALE_SNAPSHOT");
        assertThat(view(byHand).path("agentAttribution").asString()).isEqualTo("SALE_NAMED_UNCONFIRMED");
    }

    // ---- it can never override contradicting evidence, even with a good reason ------------------------------------------------------

    @Test
    void aReasonNeverOverridesAConflictAnUnresolvedCodeAnotherSaleOrADemonstration() {
        JsonNode sale = liveSale(12_000);
        activeCode("Other", "EQ-LIVE-B2");
        JsonNode otherSale = liveSale(5_000);
        var conflict = w.bank.payWithCode("POSTED", 12_000, ref(sale), "EQ-LIVE-B2");
        var unknown = w.bank.payWithCode("POSTED", 12_000, null, "ZZ-NOBODY-1");
        var otherCode = w.bank.payWithCode("POSTED", 12_000, null, "EQ-LIVE-B2");
        var wrongSale = w.bank.pay("POSTED", 12_000, ref(otherSale));
        for (Bank.Delivery d : List.of(conflict, unknown, otherCode, wrongSale)) {
            var refused = manual(d, sale, 12_000, REASON);
            assertThat(refused.status()).isEqualTo(409);
            assertThat(refused.code()).isEqualTo("code_sale_evidence_mismatch");
        }
        assertThat(count("payment_allocations")).isZero();
        assertThat(allocatedTo(sale)).isZero();
    }

    @Test
    void aDemonstrationSaleCanNeverBeReconciledByHandEvenWithAReasonAndTheRightAccount() {
        // The shop's account is simulated until live() makes it real, so its sales are demonstrations.
        ensureProfile();
        JsonNode code = activeCode("Demo", "EQ-DEMO-1");
        assertThat(assign(code, cashierMembership).status()).isEqualTo(201);
        var demo = bill(w.cashier, "key-demo-0001", body(12_000, null, null, UUID.randomUUID())).json();
        assertThat(demo.path("code").path("mode").asString()).isEqualTo("DEMONSTRATION");
        var delivery = w.bank.pay("POSTED", 12_000, ref(demo));
        var refused = manual(delivery, demo, 12_000, REASON);
        assertThat(refused.status()).isEqualTo(409);
        assertThat(refused.code()).isEqualTo("code_sale_not_payable");
        assertThat(count("payment_allocations")).isZero();
    }

    // ---- partial, excess, reversal --------------------------------------------------------------------------------------------------

    @Test
    void partialAndExcessManualAllocationsFollowTheLedgerRules() {
        JsonNode sale = liveSale(12_000);
        var delivery = named(sale, 20_000);
        // 5,000 of the 20,000 to the 12,000 sale: the sale is partial, the transaction still has money to place.
        assertThat(manual(w.owner, delivery, sale, 5_000, 12_000, REASON).status()).isEqualTo(200);
        assertThat(paymentStatus(sale)).isEqualTo("PARTIALLY_PAID");
        assertThat(allocatedTo(sale)).isEqualTo(5_000);
        assertThat(tx(delivery.transactionId()).get("review_state")).isEqualTo("NEEDS_REVIEW");
        // More than the sale still owes is refused by the ledger, with nothing applied.
        var tooMuch = manual(w.owner, delivery, sale, 9_000, 7_000, REASON);
        assertThat(tooMuch.status()).isEqualTo(409);
        assertThat(allocatedTo(sale)).isEqualTo(5_000);
        // Exactly what is owed: paid; the excess of the transaction stays unapplied.
        assertThat(manual(w.owner, delivery, sale, 7_000, 7_000, REASON).status()).isEqualTo(200);
        assertThat(paymentStatus(sale)).isEqualTo("PAID");
        assertThat(jdbc.queryForObject("select sum(amount_rwf) from payment_allocations where bank_transaction_id = ?", Long.class, tx(delivery.transactionId()).get("id")))
                .isEqualTo(12_000L);
        assertThat(w.owner.get(m("/bank-transactions/" + tx(delivery.transactionId()).get("id"))).json().path("transaction").path("unappliedAmount").asLong())
                .isEqualTo(8_000L);
    }

    @Test
    void aBankReversalOrAManualCorrectionReversesAManualAllocationAndTheSaleIsOwedAgain() {
        JsonNode sale = liveSale(12_000);
        var delivery = named(sale, 12_000);
        assertThat(manual(delivery, sale, 12_000, REASON).status()).isEqualTo(200);
        assertThat(paymentStatus(sale)).isEqualTo("PAID");
        // The bank reverses the money: the allocation is reversed with it.
        assertThat(w.bank.update(delivery.transactionId(), "REVERSED", 12_000, ref(sale)).outcome()).isEqualTo("APPLIED");
        assertThat(allocatedTo(sale)).isZero();
        assertThat(paymentStatus(sale)).isEqualTo("UNPAID");
        JsonNode view = view(delivery);
        assertThat(view.path("stage").asString()).isEqualTo("NOT_CONFIRMED");
        assertThat(view.path("allocatedToSaleRwf").asLong()).isZero();
        assertThat(view.path("saleFullyPaid").asBoolean()).isFalse();

        // A person correcting a manual allocation (with their own reason) reverses it too.
        JsonNode second = liveSale(12_000);
        var other = w.bank.pay("POSTED", 12_000, ref(second));
        assertThat(manual(other, second, 12_000, REASON).status()).isEqualTo(200);
        String allocationId = jdbc.queryForObject("select id::text from payment_allocations where status = 'ACTIVE'", String.class);
        var reversed = w.owner.post(m("/reconciliation/allocations/" + allocationId + "/reverse"), Map.of("reason", "Applied to the wrong sale"));
        assertThat(reversed.status()).as(reversed.body()).isEqualTo(200);
        assertThat(paymentStatus(second)).isEqualTo("UNPAID");
    }

    // ---- concurrency ------------------------------------------------------------------------------------------------------------------

    @Test
    void manyConcurrentManualAllocationsOfOneTransactionApplyItExactlyOnce() throws Exception {
        JsonNode sale = liveSale(12_000);
        var delivery = named(sale, 12_000);
        List<Callable<Integer>> tasks = new ArrayList<>();
        for (int i = 0; i < 5; i++) {
            tasks.add(() -> manual(delivery, sale, 12_000, REASON).status());
        }
        List<Integer> statuses = concurrently(tasks);
        assertThat(statuses).allSatisfy(status -> assertThat(status).isLessThan(500));
        assertThat(statuses.stream().filter(s -> s == 200).count()).isEqualTo(1);
        assertThat(allocatedTo(sale)).isEqualTo(12_000);
        assertThat(count("payment_allocations")).isEqualTo(1);
        assertThat(jdbc.queryForObject("select count(*) from audit_log where kind = 'MANUAL_ALLOCATED'", Integer.class)).isEqualTo(1);
    }

    // ---- the database ---------------------------------------------------------------------------------------------------------------------

    @Test
    void directSqlCanNotAllocateUnconfirmedReversedForeignOrOtherAccountMoneyToACodeSale() {
        JsonNode sale = liveSale(12_000);
        UUID invoice = UUID.fromString(sale.path("invoiceId").asString());
        var pending = w.bank.pay("PENDING", 12_000, ref(sale));
        var reversed = w.bank.pay("POSTED", 12_000, ref(sale));
        w.bank.update(reversed.transactionId(), "REVERSED", 12_000, ref(sale));
        UUID pendingTx = (UUID) tx(pending.transactionId()).get("id");
        UUID reversedTx = (UUID) tx(reversed.transactionId()).get("id");
        for (UUID unconfirmed : List.of(pendingTx, reversedTx)) {
            assertThatThrownBy(() -> insert(w.merchantId, unconfirmed, invoice, "MANUAL")).hasMessageContaining("bank-confirmed");
        }
        // Another business's money, and another business's sale: the tenant is part of every key.
        Bank cafeBank = Bank.link(mvc, w.cafeOwner, w.cafeMerchantId);
        var cafe = cafeBank.pay("POSTED", 12_000, null);
        UUID cafeTx = jdbc.queryForObject("select id from bank_transactions where merchant_id = ?", UUID.class, w.cafeMerchantId);
        assertThatThrownBy(() -> insert(w.merchantId, cafeTx, invoice, "MANUAL")).isNotNull();
        assertThatThrownBy(() -> insert(w.cafeMerchantId, cafeTx, invoice, "MANUAL")).isNotNull();
        assertThat(cafe.outcome()).isEqualTo("APPLIED");

        // Money that did not reach this sale's account (here: a transaction with no recorded account) can only be refused.
        var good = named(sale, 12_000);
        UUID goodTx = (UUID) tx(good.transactionId()).get("id");
        jdbc.execute("alter table bank_transactions disable trigger trg_bank_transactions_attribution");
        try {
            jdbc.update("update bank_transactions set attribution_status = null, attribution_basis = null, agent_attribution = null, attributed_at = null, "
                    + "attribution_note = null, settlement_destination_id = null, referenced_code_sale_id = null where id = ?", goodTx);
        } finally {
            jdbc.execute("alter table bank_transactions enable trigger trg_bank_transactions_attribution");
        }
        assertThatThrownBy(() -> insert(w.merchantId, goodTx, invoice, "MANUAL")).hasMessageContaining("settlement account");
        assertThatThrownBy(() -> insert(w.merchantId, goodTx, invoice, "AUTO_REFERENCE")).hasMessageContaining("settlement account");
        assertThat(count("payment_allocations")).isZero();
    }

    private void insert(UUID merchant, UUID transaction, UUID invoice, String origin) {
        jdbc.update("insert into payment_allocations (id, merchant_id, bank_transaction_id, invoice_id, amount_rwf, status, origin, created_by_user_id, created_at) "
                + "values (?, ?, ?, ?, 12000, 'ACTIVE', ?, ?, now())", UUID.randomUUID(), merchant, transaction, invoice, origin, w.ownerPerson.userId());
    }

    // ---- existing workflows ---------------------------------------------------------------------------------------------------------------

    @Test
    void ordinaryInvoicesKeepTheirOptionalNoteAndTheirBehaviour() {
        UUID invoice = w.issuedInvoice(30_000);
        var delivery = w.bank.pay("POSTED", 30_000, null);
        var row = tx(delivery.transactionId());
        long version = w.owner.get(m("/bank-transactions/" + row.get("id"))).json().path("transaction").path("version").asLong();
        // No note at all: unchanged for a traditional invoice.
        var applied = w.owner.post(m("/reconciliation/allocations"), Map.of("bankTransactionId", row.get("id").toString(), "expectedTransactionVersion", version,
                "allocations", List.of(Map.of("invoiceId", invoice.toString(), "amount", 30_000, "expectedRemainingBalance", 30_000))));
        assertThat(applied.status()).as(applied.body()).isEqualTo(200);
        assertThat(w.owner.get(m("/invoices/" + invoice)).json().path("paymentStatus").asString()).isEqualTo("PAID");
    }
}
