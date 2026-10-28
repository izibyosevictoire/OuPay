package rw.oupay.checkout;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Callable;
import org.junit.jupiter.api.Test;
import org.springframework.test.context.TestPropertySource;
import rw.oupay.collection.ApprovalSource;
import rw.oupay.collection.CollectionCodeApprovalService;
import rw.oupay.support.Bank;
import tools.jackson.databind.JsonNode;

/**
 * R6d-B: a confirmed bank transaction is allocated to a LIVE code sale automatically ONLY when every piece of evidence agrees: the
 * authenticated account, the bank-reported code that is the sale's own, the sale's exact OP- reference, a LIVE sale, and amounts the ledger
 * can safely apply. Anything less leaves the money CONFIRMED and UNMATCHED. The facts (confirmed, code resolved, reference matched, money
 * allocated, sale paid) are different and are read from different places.
 */
@TestPropertySource(properties = {
        "oupay.collection-codes.approval-enabled=true",
        "oupay.code-checkout.live-enabled=true"})
class CodeSaleReconciliationIT extends CodeCheckoutTestSupport {

    private static final String CODE = "EQ-LIVE-A1";

    private JsonNode liveCode;

    /** A real account and a bank-approved code held by the cashier: its sales are LIVE. */
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
        JsonNode code = live();
        var created = bill(w.cashier, "key-" + UUID.randomUUID(), body(amount, null, UUID.fromString(id(code)), UUID.randomUUID()));
        assertThat(created.status()).as(created.body()).isEqualTo(201);
        assertThat(created.json().path("code").path("mode").asString()).isEqualTo("LIVE");
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

    private int allocations() {
        return count("payment_allocations");
    }

    private String paymentStatus(JsonNode sale) {
        return w.owner.get(m("/invoices/" + sale.path("invoiceId").asString())).json().path("paymentStatus").asString();
    }

    private void assertUnmatched(Bank.Delivery delivery, JsonNode sale) {
        var row = tx(delivery.transactionId());
        assertThat(row.get("status")).isEqualTo("CONFIRMED");
        assertThat(row.get("payment_request_id")).isNull();
        assertThat(row.get("review_state")).isEqualTo("NEEDS_REVIEW");
        assertThat(allocatedTo(sale)).isZero();
        assertThat(paymentStatus(sale)).isEqualTo("UNPAID");
    }

    // ---- the automatic match ---------------------------------------------------------------------------------------

    @Test
    void whenEveryPieceOfEvidenceAgreesTheSaleIsMatchedAllocatedAndPaid() {
        JsonNode sale = liveSale(12_000);
        var delivery = w.bank.payWithCode("POSTED", 12_000, ref(sale), CODE);
        assertThat(delivery.outcome()).isEqualTo("APPLIED");
        var row = tx(delivery.transactionId());
        assertThat(row.get("status")).isEqualTo("CONFIRMED");
        assertThat(row.get("attribution_status")).isEqualTo("RESOLVED");
        assertThat(row.get("agent_attribution")).isEqualTo("CONFIRMED_FROM_SALE_SNAPSHOT");
        assertThat(row.get("payment_request_id").toString()).isEqualTo(sale.path("saleId").asString());
        assertThat(row.get("review_state")).isEqualTo("NONE");
        assertThat(allocations()).isEqualTo(1);
        assertThat(jdbc.queryForObject("select origin from payment_allocations", String.class)).isEqualTo("AUTO_REFERENCE");
        assertThat(allocatedTo(sale)).isEqualTo(12_000);
        assertThat(paymentStatus(sale)).isEqualTo("PAID");
        // Five different facts, each from its own source.
        JsonNode view = view(delivery);
        assertThat(view.path("transactionStatus").asString()).isEqualTo("CONFIRMED");
        assertThat(view.path("codeResolved").asBoolean()).isTrue();
        assertThat(view.path("saleReferenceMatched").asBoolean()).isTrue();
        assertThat(view.path("allocatedToSaleRwf").asLong()).isEqualTo(12_000);
        assertThat(view.path("saleFullyPaid").asBoolean()).isTrue();
        assertThat(view.path("stage").asString()).isEqualTo("FULLY_PAID");
        assertThat(view.path("agentName").asString()).isEqualTo("Aline Cashier");
        // The customer's page says paid, because money was applied, and the agent's sale too.
        assertThat(publicSale(ref(sale)).json().path("status").asString()).isEqualTo("PAID");
        assertThat(w.cashier.get(sale() + "/" + sale.path("saleId").asString()).json().path("status").asString()).isEqualTo("SETTLED");
    }

    @Test
    void missingOrConflictingEvidenceLeavesTheMoneyConfirmedAndUnmatchedWithAReason() {
        JsonNode sale = liveSale(12_000);
        activeCode("Other", "EQ-LIVE-B2");

        // The right reference but no reported code: the sale is NAMED, nothing else is established.
        var noCode = w.bank.pay("POSTED", 12_000, ref(sale));
        assertUnmatched(noCode, sale);
        assertThat(tx(noCode.transactionId()).get("review_reason").toString()).contains("bank reported no collection code");
        assertThat(view(noCode).path("stage").asString()).isEqualTo("AWAITING_MATCHING");
        assertThat(view(noCode).path("saleReferenceMatched").asBoolean()).isFalse();

        // The right code but no reference: the code is attributed, the sale is not matched.
        var codeOnly = w.bank.payWithCode("POSTED", 12_000, null, CODE);
        assertThat(tx(codeOnly.transactionId()).get("payment_request_id")).isNull();
        assertThat(view(codeOnly).path("stage").asString()).isEqualTo("CODE_RESOLVED");
        // The right amount, nothing else.
        w.bank.pay("POSTED", 12_000, null);
        // Another of the business's own codes with the right reference: a conflict.
        var wrongCode = w.bank.payWithCode("POSTED", 12_000, ref(sale), "EQ-LIVE-B2");
        assertUnmatched(wrongCode, sale);
        assertThat(view(wrongCode).path("stage").asString()).isEqualTo("CONFLICT");
        // An unknown code with the right reference.
        var unknown = w.bank.payWithCode("POSTED", 12_000, ref(sale), "ZZ-NOBODY-1");
        assertUnmatched(unknown, sale);
        // The sale's INVOICE NUMBER is never a reference for a code sale, even with the right code.
        String number = jdbc.queryForObject("select invoice_number from invoices where id = ?::uuid", String.class, sale.path("invoiceId").asString());
        var byNumber = w.bank.payWithCode("POSTED", 12_000, number, CODE);
        assertUnmatched(byNumber, sale);
        assertThat(allocations()).isZero();
        assertThat(codeOnly.outcome()).isEqualTo("APPLIED");
    }

    @Test
    void aCodeOfAnotherBusinessOrAnAccountMismatchNeverMatchesAndLeaksNothing() {
        JsonNode sale = liveSale(12_000);
        Bank.link(mvc, w.cafeOwner, w.cafeMerchantId);
        UUID cafeDestination = jdbc.queryForObject("select id from payment_destinations where merchant_id = ?", UUID.class, w.cafeMerchantId);
        var requested = w.cafeOwner.post("/api/v1/merchants/" + w.cafeMerchantId + "/collection-codes", Map.of("clientOperationId", UUID.randomUUID().toString(),
                "settlementDestinationId", cafeDestination.toString(), "displayLabel", "Cafe till", "branchId", w.cafeBranchId.toString()));
        JsonNode cafeCode = requested.json().path("code");
        w.cafeOwner.post("/api/v1/merchants/" + w.cafeMerchantId + "/collection-codes/" + id(cafeCode) + "/submission",
                Map.of("expectedVersion", cafeCode.path("version").asLong(), "bankRequestRef", "EQ-CAFE"));
        approvals.approve(w.cafeMerchantId, UUID.fromString(id(cafeCode)), "EQ-CAFE-77",
                new CollectionCodeApprovalService.Evidence(ApprovalSource.OPERATOR, "Equity letter 77", w.ownerPerson.userId(), operatorB));
        var foreign = w.bank.payWithCode("POSTED", 12_000, ref(sale), "EQ-CAFE-77");
        assertUnmatched(foreign, sale);
        assertThat(tx(foreign.transactionId()).get("review_reason").toString()).doesNotContain("Cafe").doesNotContain("EQ-CAFE-77");
        assertThat(w.cafeOwner.get("/api/v1/merchants/" + w.cafeMerchantId + "/bank-attributions").json().path("items").size()).isZero();
        assertThat(count("payment_allocations")).isZero();
    }

    @Test
    void aDemonstrationSaleIsNeverMatchedEvenWithEveryPieceOfEvidence() {
        // A simulated account: the code and the sale are a demonstration.
        ensureProfile();
        JsonNode code = activeCode("Demo", "EQ-DEMO-1");
        assertThat(assign(code, cashierMembership).status()).isEqualTo(201);
        var created = bill(w.cashier, "key-demo-0001", body(12_000, null, null, UUID.randomUUID()));
        assertThat(created.json().path("code").path("mode").asString()).isEqualTo("DEMONSTRATION");
        var delivery = w.bank.payWithCode("POSTED", 12_000, ref(created.json()), "EQ-DEMO-1");
        assertUnmatched(delivery, created.json());
        assertThat(allocations()).isZero();
        assertThat(tx(delivery.transactionId()).get("review_reason").toString()).contains("demonstration");
    }

    // ---- idempotency, partial payments, overpayments -----------------------------------------------------------------------

    @Test
    void aRepeatedWebhookNeverAllocatesTwice() throws Exception {
        JsonNode sale = liveSale(12_000);
        var first = w.bank.payWithCode("POSTED", 12_000, ref(sale), CODE);
        String eventId = (String) tx(first.transactionId()).get("last_provider_event_id");
        for (int i = 0; i < 3; i++) {
            assertThat(w.bank.sendWithCode("POSTED", 12_000, ref(sale), CODE, first.transactionId(), eventId, w.bank.at(900)).outcome()).isEqualTo("DUPLICATE");
        }
        assertThat(w.bank.updateWithCode(first.transactionId(), "POSTED", 12_000, ref(sale), CODE).outcome()).isEqualTo("DUPLICATE");
        assertThat(allocations()).isEqualTo(1);

        // Six simultaneous deliveries of one new event: one is applied, the rest are duplicates, one allocation.
        JsonNode second = liveSale(7_000);
        List<Callable<Bank.Delivery>> tasks = new ArrayList<>();
        for (int i = 0; i < 6; i++) {
            tasks.add(() -> w.bank.sendWithCode("POSTED", 7_000, ref(second), CODE, "tx-same", "evt-same", w.bank.at(50)));
        }
        List<Bank.Delivery> results = concurrently(tasks);
        assertThat(results.stream().filter(d -> "APPLIED".equals(d.outcome())).count()).isEqualTo(1);
        assertThat(allocatedTo(second)).isEqualTo(7_000);
        assertThat(allocations()).isEqualTo(2);
    }

    @Test
    void partialPaymentsStayPartialAndOverpaymentsKeepTheExcessUnmatchedForReview() {
        JsonNode sale = liveSale(12_000);
        var part = w.bank.payWithCode("POSTED", 5_000, ref(sale), CODE);
        assertThat(allocatedTo(sale)).isEqualTo(5_000);
        assertThat(paymentStatus(sale)).isEqualTo("PARTIALLY_PAID");
        JsonNode partial = view(part);
        assertThat(partial.path("stage").asString()).isEqualTo("ALLOCATED");
        assertThat(partial.path("saleFullyPaid").asBoolean()).isFalse();
        assertThat(publicSale(ref(sale)).json().path("status").asString()).isEqualTo("PARTIALLY_PAID");

        // 20,000 arrives for the 7,000 still owed: 7,000 is applied, 13,000 stays unapplied and is flagged.
        var over = w.bank.payWithCode("POSTED", 20_000, ref(sale), CODE);
        assertThat(allocatedTo(sale)).isEqualTo(12_000);
        assertThat(paymentStatus(sale)).isEqualTo("PAID");
        var row = tx(over.transactionId());
        assertThat(row.get("review_state")).isEqualTo("NEEDS_REVIEW");
        assertThat(jdbc.queryForObject("select sum(amount_rwf) from payment_allocations where bank_transaction_id = ?::uuid", Long.class, row.get("id").toString())).isEqualTo(7_000L);
        // A payment for a sale that is already paid is not applied at all.
        var extra = w.bank.payWithCode("POSTED", 3_000, ref(sale), CODE);
        assertThat(allocatedTo(sale)).isEqualTo(12_000);
        assertThat(tx(extra.transactionId()).get("review_state")).isEqualTo("NEEDS_REVIEW");
        assertThat(view(extra).path("allocatedToSaleRwf").asLong()).isZero();
    }

    // ---- evolving events ------------------------------------------------------------------------------------------------

    @Test
    void pendingThenConfirmedAndANeverReportedCodeThatArrivesLaterAreBothMatched() {
        JsonNode sale = liveSale(12_000);
        var pending = w.bank.payWithCode("PENDING", 12_000, ref(sale), CODE);
        assertThat(allocations()).isZero();
        assertThat(view(pending).path("stage").asString()).isEqualTo("NOT_CONFIRMED");
        w.bank.updateWithCode(pending.transactionId(), "POSTED", 12_000, ref(sale), CODE);
        assertThat(allocatedTo(sale)).isEqualTo(12_000);

        // A second payment: the pending event had no code, the confirmation carries it.
        JsonNode other = liveSale(8_000);
        var noCode = w.bank.pay("PENDING", 8_000, ref(other));
        assertThat(tx(noCode.transactionId()).get("agent_attribution")).isEqualTo("SALE_NAMED_UNCONFIRMED");
        w.bank.updateWithCode(noCode.transactionId(), "POSTED", 8_000, null, CODE);
        assertThat(allocatedTo(other)).isEqualTo(8_000);
        assertThat(tx(noCode.transactionId()).get("agent_attribution")).isEqualTo("CONFIRMED_FROM_SALE_SNAPSHOT");
    }

    @Test
    void aLaterConflictingCodeBlocksTheMatchAndStaysAConflict() {
        JsonNode sale = liveSale(12_000);
        activeCode("Other", "EQ-LIVE-B2");
        var pending = w.bank.payWithCode("PENDING", 12_000, ref(sale), CODE);
        w.bank.updateWithCode(pending.transactionId(), "POSTED", 12_000, ref(sale), "EQ-LIVE-B2");
        assertUnmatched(pending, sale);
        assertThat(tx(pending.transactionId()).get("attribution_status")).isEqualTo("CONFLICT");
        assertThat(view(pending).path("stage").asString()).isEqualTo("CONFLICT");
    }

    @Test
    void aLatePaymentAfterTheRequestExpiredIsStillAppliedToItsSale() {
        JsonNode sale = liveSale(12_000);
        jdbc.update("update payment_requests set expires_at = now() - interval '2 hours' where public_reference = ?", ref(sale));
        assertThat(publicSale(ref(sale)).json().path("status").asString()).isEqualTo("EXPIRED");
        w.bank.payWithCode("POSTED", 12_000, ref(sale), CODE);
        assertThat(allocatedTo(sale)).isEqualTo(12_000);
        assertThat(paymentStatus(sale)).isEqualTo("PAID");
        assertThat(publicSale(ref(sale)).json().path("status").asString()).isEqualTo("PAID");
    }

    @Test
    void aReversalAfterAllocationReversesItAndTheSaleIsOwedAgain() {
        JsonNode sale = liveSale(12_000);
        var delivery = w.bank.payWithCode("POSTED", 12_000, ref(sale), CODE);
        assertThat(allocatedTo(sale)).isEqualTo(12_000);
        assertThat(w.bank.updateWithCode(delivery.transactionId(), "REVERSED", 12_000, ref(sale), CODE).outcome()).isEqualTo("APPLIED");
        assertThat(allocatedTo(sale)).isZero();
        assertThat(jdbc.queryForObject("select status from payment_allocations", String.class)).isEqualTo("REVERSED");
        assertThat(paymentStatus(sale)).isEqualTo("UNPAID");
        JsonNode view = view(delivery);
        assertThat(view.path("stage").asString()).isEqualTo("NOT_CONFIRMED");
        assertThat(view.path("allocatedToSaleRwf").asLong()).isZero();
        assertThat(view.path("saleFullyPaid").asBoolean()).isFalse();
        // The history is kept (attribution stays), and a late "confirmed" event can not resurrect it.
        assertThat(view.path("attributionStatus").asString()).isEqualTo("RESOLVED");
        assertThat(w.bank.updateWithCode(delivery.transactionId(), "POSTED", 12_000, ref(sale), CODE).outcome()).isEqualTo("STALE");
        assertThat(allocatedTo(sale)).isZero();
    }

    @Test
    void aReassignedOrDeactivatedCodeDoesNotInvalidateTheHistoricalSale() {
        JsonNode code = live();
        JsonNode sale = liveSale(12_000);
        String open = jdbc.queryForObject("select id::text from collection_code_assignments where code_id = ?::uuid and valid_to is null", String.class, id(code));
        assertThat(reassign(code, open, otherCashierMembership, "Shift change").status()).isEqualTo(200);
        long version = w.owner.get(codes() + "/" + id(code)).json().path("version").asLong();
        var deactivated = w.owner.post(codes() + "/" + id(code) + "/deactivate", Map.of("expectedVersion", version, "reason", "Retired"));
        assertThat(deactivated.status()).as(deactivated.body()).isEqualTo(200);

        var delivery = w.bank.payWithCode("POSTED", 12_000, ref(sale), CODE);
        assertThat(allocatedTo(sale)).isEqualTo(12_000);
        // The collector is the agent of the sale's snapshot, not the current (or any) holder of the code.
        assertThat(view(delivery).path("agentName").asString()).isEqualTo("Aline Cashier");
        assertThat(view(delivery).toString()).doesNotContain("Eric");
    }

    // ---- concurrency --------------------------------------------------------------------------------------------------------

    @Test
    void twoPaymentsAndAManualAllocationRacingForOneSaleNeverOverAllocateIt() throws Exception {
        JsonNode sale = liveSale(12_000);
        var unmatched = w.bank.pay("POSTED", 12_000, ref(sale));
        var row = tx(unmatched.transactionId());
        long version = w.owner.get(m("/bank-transactions/" + row.get("id"))).json().path("transaction").path("version").asLong();
        Map<String, Object> manual = Map.of("bankTransactionId", row.get("id").toString(), "expectedTransactionVersion", version,
                "allocations", List.of(Map.of("invoiceId", sale.path("invoiceId").asString(), "amount", 12_000, "expectedRemainingBalance", 12_000)),
                "note", "Customer showed the bank receipt");
        List<Callable<Integer>> tasks = new ArrayList<>();
        tasks.add(() -> w.owner.post(m("/reconciliation/allocations"), manual).status());
        tasks.add(() -> w.bank.payWithCode("POSTED", 12_000, ref(sale), CODE).response().status());
        tasks.add(() -> w.bank.payWithCode("POSTED", 12_000, ref(sale), CODE).response().status());
        List<Integer> statuses = concurrently(tasks);
        assertThat(statuses).allSatisfy(status -> assertThat(status).isLessThan(500));
        // However they interleaved, the sale is paid exactly once, never more, and nothing was applied twice.
        assertThat(allocatedTo(sale)).isEqualTo(12_000);
        assertThat(paymentStatus(sale)).isEqualTo("PAID");
        assertThat(jdbc.queryForObject("select count(*) from (select bank_transaction_id from payment_allocations where status = 'ACTIVE' "
                + "group by bank_transaction_id having sum(amount_rwf) > (select amount_rwf from bank_transactions where id = bank_transaction_id)) x", Integer.class)).isZero();
    }

    // ---- manual reconciliation --------------------------------------------------------------------------------------------------

    @Test
    void manualReconciliationToALiveCodeSaleIsAuditedAndNeverOverridesConflictingEvidence() {
        JsonNode sale = liveSale(12_000);
        activeCode("Other", "EQ-LIVE-B2");
        String invoice = sale.path("invoiceId").asString();

        // Conflicting bank evidence (a different own code) can not be ignored by a person.
        var conflict = w.bank.payWithCode("POSTED", 12_000, ref(sale), "EQ-LIVE-B2");
        assertThat(manual(conflict, invoice, 12_000).code()).isEqualTo("code_sale_evidence_mismatch");
        // Neither can an unresolved reported code.
        var unknown = w.bank.payWithCode("POSTED", 12_000, null, "ZZ-NOBODY-1");
        assertThat(manual(unknown, invoice, 12_000).code()).isEqualTo("code_sale_evidence_mismatch");
        // Or a payment that names a different code sale.
        JsonNode otherSale = liveSale(5_000);
        var wrongSale = w.bank.pay("POSTED", 12_000, ref(otherSale));
        assertThat(manual(wrongSale, invoice, 12_000).code()).isEqualTo("code_sale_evidence_mismatch");
        assertThat(allocations()).isZero();

        // A payment that names the sale but carries no code: an authorised person may apply it, explicitly, and it is audited.
        var named = w.bank.pay("POSTED", 12_000, ref(sale));
        var applied = manual(named, invoice, 12_000);
        assertThat(applied.status()).as(applied.body()).isEqualTo(200);
        assertThat(allocatedTo(sale)).isEqualTo(12_000);
        assertThat(jdbc.queryForObject("select origin from payment_allocations where invoice_id = ?::uuid", String.class, invoice)).isEqualTo("MANUAL");
        assertThat(jdbc.queryForObject("select count(*) from audit_log where kind = 'MANUAL_ALLOCATED'", Integer.class)).isEqualTo(1);
        assertThat(paymentStatus(sale)).isEqualTo("PAID");
    }

    @Test
    void anotherBusinessCanNeitherReconcileNorSeeTheTransactionOrTheSale() {
        JsonNode sale = liveSale(12_000);
        var delivery = w.bank.pay("POSTED", 12_000, ref(sale));
        var response = w.cafeOwner.post("/api/v1/merchants/" + w.cafeMerchantId + "/reconciliation/allocations", Map.of(
                "bankTransactionId", tx(delivery.transactionId()).get("id").toString(), "expectedTransactionVersion", 0,
                "allocations", List.of(Map.of("invoiceId", sale.path("invoiceId").asString(), "amount", 12_000, "expectedRemainingBalance", 12_000)),
                "note", "cross tenant"));
        assertThat(response.status()).isIn(403, 404);
        assertThat(allocations()).isZero();
    }

    private rw.oupay.support.TestApi.Response manual(Bank.Delivery delivery, String invoiceId, long amount) {
        var row = tx(delivery.transactionId());
        long version = w.owner.get(m("/bank-transactions/" + row.get("id"))).json().path("transaction").path("version").asLong();
        return w.owner.post(m("/reconciliation/allocations"), Map.of("bankTransactionId", row.get("id").toString(), "expectedTransactionVersion", version,
                "allocations", List.of(Map.of("invoiceId", invoiceId, "amount", amount, "expectedRemainingBalance", amount)), "note", "Checked with the customer"));
    }

    // ---- direct SQL can not bypass the evidence -----------------------------------------------------------------------------------

    @Test
    void directSqlCanNotAllocateToACodeSaleWithoutTheRequiredEvidence() {
        JsonNode sale = liveSale(12_000);
        activeCode("Other", "EQ-LIVE-B2");
        UUID invoice = UUID.fromString(sale.path("invoiceId").asString());

        // Money that names the sale but reported no code: an AUTOMATIC allocation is refused; a MANUAL one (a person's decision) is allowed.
        var named = w.bank.pay("POSTED", 12_000, ref(sale));
        UUID namedTx = (UUID) tx(named.transactionId()).get("id");
        assertThatThrownBy(() -> insert(namedTx, invoice, "AUTO_REFERENCE")).hasMessageContaining("not matched to bank money automatically");

        // A different own code, an unknown code, no reference: refused whatever the origin.
        var conflict = w.bank.payWithCode("POSTED", 12_000, ref(sale), "EQ-LIVE-B2");
        UUID conflictTx = (UUID) tx(conflict.transactionId()).get("id");
        var unknown = w.bank.payWithCode("POSTED", 12_000, null, "ZZ-NOBODY-1");
        UUID unknownTx = (UUID) tx(unknown.transactionId()).get("id");
        var codeOnlyOther = w.bank.payWithCode("POSTED", 12_000, null, "EQ-LIVE-B2");
        UUID otherCodeTx = (UUID) tx(codeOnlyOther.transactionId()).get("id");
        for (String origin : List.of("MANUAL", "AUTO_REFERENCE")) {
            assertThatThrownBy(() -> insert(conflictTx, invoice, origin)).hasMessageContaining("conflicting bank evidence");
            assertThatThrownBy(() -> insert(unknownTx, invoice, origin)).hasMessageContaining("does not resolve to the code of this sale");
            assertThatThrownBy(() -> insert(otherCodeTx, invoice, origin)).hasMessageContaining("does not resolve to the code of this sale");
        }
        assertThat(allocations()).isZero();

        // The one thing a person may do: apply the named, code-less payment.
        insert(namedTx, invoice, "MANUAL");
        assertThat(allocations()).isEqualTo(1);
    }

    private void insert(UUID transaction, UUID invoice, String origin) {
        jdbc.update("insert into payment_allocations (id, merchant_id, bank_transaction_id, invoice_id, amount_rwf, status, origin, created_by_user_id, created_at) "
                + "values (?, ?, ?, ?, 12000, 'ACTIVE', ?, ?, now())", UUID.randomUUID(), w.merchantId, transaction, invoice, origin, w.ownerPerson.userId());
    }

    @Test
    void directSqlAutomaticAllocationNeedsTheLinkTheExactReferenceAndTheConfirmedAgent() {
        JsonNode sale = liveSale(12_000);
        UUID invoice = UUID.fromString(sale.path("invoiceId").asString());
        // A fully-evidenced payment is matched and allocated by the application...
        var good = w.bank.payWithCode("POSTED", 5_000, ref(sale), CODE);
        assertThat(allocatedTo(sale)).isEqualTo(5_000);
        // ...but the same evidence with the link removed would not pass the database's automatic check. Prove it on a payment that was
        // never linked: same code, same account, the sale named by an INVALID reference form.
        var unlinked = w.bank.payWithCode("POSTED", 5_000, "OP-ABCDEFGHJKMN", CODE);
        UUID unlinkedTx = (UUID) tx(unlinked.transactionId()).get("id");
        assertThatThrownBy(() -> insert(unlinkedTx, invoice, "AUTO_REFERENCE")).hasMessageContaining("not matched to bank money automatically");
        assertThat(good.outcome()).isEqualTo("APPLIED");
        assertThat(allocatedTo(sale)).isEqualTo(5_000);
    }

    // ---- legacy behaviour is untouched ------------------------------------------------------------------------------------------------

    @Test
    void ordinaryInvoicesStillReconcileByTheirNumberNextToALiveCodeSale() {
        JsonNode sale = liveSale(12_000);
        UUID invoice = w.issuedInvoice(30_000);
        String number = jdbc.queryForObject("select invoice_number from invoices where id = ?", String.class, invoice);
        w.bank.pay("POSTED", 30_000, number);
        assertThat(jdbc.queryForObject("select origin from payment_allocations", String.class)).isEqualTo("AUTO_REFERENCE");
        assertThat(w.owner.get(m("/invoices/" + invoice)).json().path("paymentStatus").asString()).isEqualTo("PAID");
        assertThat(allocatedTo(sale)).isZero();
    }
}
