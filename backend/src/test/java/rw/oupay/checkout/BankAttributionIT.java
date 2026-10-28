package rw.oupay.checkout;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.test.context.TestPropertySource;
import rw.oupay.collection.ApprovalSource;
import rw.oupay.collection.CollectionCodeApprovalService;
import rw.oupay.support.Bank;
import tools.jackson.databind.JsonNode;

/**
 * R6d-A: attribution of VERIFIED bank money to the merchant's own collection code, and (only from an exact sale reference) to the agent of
 * that sale. Evidence comes from the authenticated (simulated) provider event; nothing is inferred from an amount, a time or a payer; and
 * nothing is allocated: the bank ledger stays the single source of financial truth.
 */
@TestPropertySource(properties = "oupay.collection-codes.approval-enabled=true")
class BankAttributionIT extends CodeCheckoutTestSupport {

    private static final String CODE_A = "EQ-CODE-A1";

    private String m(String path) {
        return "/api/v1/merchants/" + w.merchantId + path;
    }

    private Map<String, Object> tx(String providerTransactionId) {
        return jdbc.queryForMap("select * from bank_transactions where provider_transaction_id = ?", providerTransactionId);
    }

    private JsonNode attribution(UUID transactionId) {
        var response = w.owner.get(m("/bank-attributions/" + transactionId));
        assertThat(response.status()).as(response.body()).isEqualTo(200);
        return response.json();
    }

    private JsonNode attribution(Bank.Delivery delivery) {
        return attribution((UUID) tx(delivery.transactionId()).get("id"));
    }

    /** A bank-approved code on the shop's account, assigned to the cashier. */
    private JsonNode codeA() {
        JsonNode code = activeCode("Counter", CODE_A);
        assertThat(assign(code, cashierMembership).status()).isEqualTo(201);
        return code;
    }

    private JsonNode sale(long amount, JsonNode code) {
        ensureProfile();
        var created = bill(w.cashier, "key-" + UUID.randomUUID(), body(amount, null, UUID.fromString(id(code)), UUID.randomUUID()));
        assertThat(created.status()).as(created.body()).isEqualTo(201);
        return created.json();
    }

    /** The API omits nulls. */
    private static boolean absent(JsonNode node) {
        return node.isMissingNode() || node.isNull();
    }

    private static List<String> ids(JsonNode page) {
        List<String> ids = new ArrayList<>();
        page.path("items").forEach(i -> ids.add(i.path("transactionId").asString()));
        return ids;
    }

    private int allocations() {
        return count("payment_allocations");
    }

    // ---- merchant, account, exact code -----------------------------------------------------------

    @Test
    void theAuthenticatedAccountDecidesTheMerchantAndTheReportedCodeResolvesExactly() {
        JsonNode code = codeA();
        var delivery = w.bank.payWithCode("POSTED", 5_000, null, CODE_A);
        assertThat(delivery.outcome()).isEqualTo("APPLIED");
        var row = tx(delivery.transactionId());
        assertThat(row.get("merchant_id")).isEqualTo(w.merchantId);
        assertThat(row.get("settlement_destination_id")).isEqualTo(destination);
        assertThat(row.get("reported_code")).isEqualTo(CODE_A);
        assertThat(row.get("collection_code_id").toString()).isEqualTo(id(code));
        assertThat(row.get("attribution_status")).isEqualTo("RESOLVED");
        assertThat(row.get("attribution_basis")).isEqualTo("CODE_REPORTED");
        assertThat(row.get("origin_provider_event_id")).isEqualTo(row.get("last_provider_event_id"));
        // The agent is NOT inferred from who holds the code: nothing names a sale.
        assertThat(row.get("agent_attribution")).isEqualTo("UNRESOLVED");
        assertThat(row.get("referenced_code_sale_id")).isNull();
        assertThat(allocations()).isZero();

        JsonNode view = attribution(delivery);
        assertThat(view.path("attributionStatus").asString()).isEqualTo("RESOLVED");
        assertThat(view.path("collectionCode").path("id").asString()).isEqualTo(id(code));
        assertThat(view.path("collectionCode").path("label").asString()).isEqualTo("Counter");
        assertThat(view.path("reportedCode").asString()).isEqualTo(CODE_A);
        assertThat(view.path("saleReferenceMatched").asBoolean()).isFalse();
    }

    @Test
    void aCodeIsMatchedIgnoringCaseButNeverByPrefixOrAnythingElse() {
        codeA();
        assertThat(tx(w.bank.payWithCode("POSTED", 1_000, null, CODE_A.toLowerCase()).transactionId()).get("attribution_status")).isEqualTo("RESOLVED");
        for (String near : List.of("EQ-CODE-A", "EQ-CODE-A1X", " EQ-CODE-A2", "EQ-CODE-A1-")) {
            assertThat(tx(w.bank.payWithCode("POSTED", 1_000, null, near.trim()).transactionId()).get("attribution_status")).as(near).isEqualTo("UNRESOLVED");
        }
    }

    @Test
    void noCodeReportedMeansAccountOnlyAndNothingIsInferredFromAmountTimeOrPayer() {
        codeA();
        // The right amount, from the usual payer, right after a sale: still no code, so no code attribution.
        var delivery = w.bank.pay("POSTED", 5_000, null);
        var row = tx(delivery.transactionId());
        assertThat(row.get("attribution_status")).isEqualTo("NOT_REPORTED");
        assertThat(row.get("attribution_basis")).isEqualTo("ACCOUNT_ONLY");
        assertThat(row.get("settlement_destination_id")).isEqualTo(destination);
        assertThat(row.get("collection_code_id")).isNull();
        assertThat(row.get("reported_code")).isNull();
        assertThat(row.get("agent_attribution")).isEqualTo("UNRESOLVED");
        assertThat(absent(attribution(delivery).path("collectionCode"))).isTrue();
    }

    @Test
    void anUnknownCodeIsPreservedRawAndMarkedUnresolvedAndFlaggedForAPerson() {
        codeA();
        var delivery = w.bank.payWithCode("POSTED", 5_000, null, "ZZ-UNKNOWN-9");
        var row = tx(delivery.transactionId());
        assertThat(row.get("reported_code")).isEqualTo("ZZ-UNKNOWN-9");
        assertThat(row.get("attribution_status")).isEqualTo("UNRESOLVED");
        assertThat(row.get("collection_code_id")).isNull();
        assertThat(row.get("review_state")).isEqualTo("NEEDS_REVIEW");
        assertThat(allocations()).isZero();
        // The money is real and verified: it is in the ledger as a confirmed, unapplied collection.
        assertThat(row.get("status")).isEqualTo("CONFIRMED");
    }

    @Test
    void aCodeOfAnotherBusinessNeverAttributesAndRevealsNothingAboutThatBusiness() {
        codeA();
        // The cafe owns a bank-approved code on its own account.
        Bank.link(mvc, w.cafeOwner, w.cafeMerchantId);
        UUID cafeDestination = jdbc.queryForObject("select id from payment_destinations where merchant_id = ?", UUID.class, w.cafeMerchantId);
        var requested = w.cafeOwner.post("/api/v1/merchants/" + w.cafeMerchantId + "/collection-codes", Map.of("clientOperationId", UUID.randomUUID().toString(),
                "settlementDestinationId", cafeDestination.toString(), "displayLabel", "Cafe till", "branchId", w.cafeBranchId.toString()));
        assertThat(requested.status()).as(requested.body()).isEqualTo(201);
        JsonNode cafeCode = requested.json().path("code");
        assertThat(w.cafeOwner.post("/api/v1/merchants/" + w.cafeMerchantId + "/collection-codes/" + id(cafeCode) + "/submission",
                Map.of("expectedVersion", cafeCode.path("version").asLong(), "bankRequestRef", "EQ-CAFE")).status()).isEqualTo(200);
        approvals.approve(w.cafeMerchantId, UUID.fromString(id(cafeCode)), "EQ-CAFE-77",
                new CollectionCodeApprovalService.Evidence(ApprovalSource.OPERATOR, "Equity letter 77", w.ownerPerson.userId(), operatorB));

        // The shop's account reports the cafe's code.
        var foreign = w.bank.payWithCode("POSTED", 5_000, null, "EQ-CAFE-77");
        var unknown = w.bank.payWithCode("POSTED", 5_000, null, "EQ-NOBODY-1");
        var foreignRow = tx(foreign.transactionId());
        assertThat(foreignRow.get("attribution_status")).isEqualTo("UNRESOLVED");
        assertThat(foreignRow.get("collection_code_id")).isNull();
        assertThat(foreignRow.get("merchant_id")).isEqualTo(w.merchantId);
        // Indistinguishable from an unknown code, to the merchant: same verdict, same note, nothing of the cafe in the body.
        JsonNode foreignView = attribution(foreign);
        JsonNode unknownView = attribution(unknown);
        assertThat(foreignView.path("attributionStatus").asString()).isEqualTo(unknownView.path("attributionStatus").asString());
        assertThat(foreignRow.get("attribution_note")).isEqualTo(tx(unknown.transactionId()).get("attribution_note"));
        assertThat(foreignView.toString()).doesNotContain("Cafe till").doesNotContain(id(cafeCode));
        // The cafe sees nothing of the shop's money.
        assertThat(w.cafeOwner.get("/api/v1/merchants/" + w.cafeMerchantId + "/bank-attributions").json().path("items").size()).isZero();
    }

    // ---- duplicates, late events, reversals -------------------------------------------------------

    @Test
    void aDuplicateEventChangesNothingAndRecordsNoSecondAttribution() {
        codeA();
        var first = w.bank.payWithCode("POSTED", 5_000, null, CODE_A);
        var row = tx(first.transactionId());
        String eventId = (String) row.get("last_provider_event_id");
        int audits = jdbc.queryForObject("select count(*) from audit_log where kind = 'ATTRIBUTION_RECORDED'", Integer.class);
        // The very same event, again, and then the same transaction under a new event id repeating the status.
        var replay = w.bank.sendWithCode("POSTED", 5_000, null, CODE_A, first.transactionId(), eventId, w.bank.at(900));
        assertThat(replay.outcome()).isEqualTo("DUPLICATE");
        assertThat(w.bank.updateWithCode(first.transactionId(), "POSTED", 5_000, null, CODE_A).outcome()).isEqualTo("DUPLICATE");
        assertThat(tx(first.transactionId()).get("collection_code_id")).isEqualTo(row.get("collection_code_id"));
        assertThat(jdbc.queryForObject("select count(*) from audit_log where kind = 'ATTRIBUTION_RECORDED'", Integer.class)).isEqualTo(audits);
        assertThat(count("bank_transactions")).isEqualTo(1);
    }

    @Test
    void aLaterEventCompletesAMissingCodeOnceAndAStaleOneChangesNothing() {
        JsonNode code = codeA();
        var pending = w.bank.pay("PENDING", 5_000, null);
        assertThat(tx(pending.transactionId()).get("attribution_status")).isEqualTo("NOT_REPORTED");
        // The confirmation carries the code: attribution is completed, evidence added, never overwritten.
        w.bank.updateWithCode(pending.transactionId(), "POSTED", 5_000, null, CODE_A);
        var row = tx(pending.transactionId());
        assertThat(row.get("attribution_status")).isEqualTo("RESOLVED");
        assertThat(row.get("collection_code_id").toString()).isEqualTo(id(code));
        // A stale event (older than the applied status) with a different code is ignored entirely.
        var stale = w.bank.sendWithCode("PENDING", 5_000, null, "EQ-OTHER-1", pending.transactionId(), "evt-stale-1", w.bank.at(-500));
        assertThat(stale.outcome()).isEqualTo("STALE");
        assertThat(tx(pending.transactionId()).get("reported_code")).isEqualTo(CODE_A);
        assertThat(tx(pending.transactionId()).get("attribution_status")).isEqualTo("RESOLVED");
    }

    @Test
    void aLaterEventReportingADifferentCodeIsAFinalConflictNotAnOverwrite() {
        codeA();
        var first = w.bank.payWithCode("PENDING", 5_000, null, CODE_A);
        w.bank.updateWithCode(first.transactionId(), "POSTED", 5_000, null, "EQ-OTHER-2");
        var row = tx(first.transactionId());
        assertThat(row.get("reported_code")).isEqualTo(CODE_A);
        assertThat(row.get("attribution_status")).isEqualTo("CONFLICT");
        assertThat(row.get("review_state")).isEqualTo("NEEDS_REVIEW");
        // And it stays a conflict.
        assertThatThrownBy(() -> jdbc.update("update bank_transactions set attribution_status = 'RESOLVED' where provider_transaction_id = ?",
                first.transactionId())).hasMessageContaining("final");
    }

    @Test
    void aReversalKeepsTheAttributionAndTheLedgerConserves() {
        codeA();
        var delivery = w.bank.payWithCode("POSTED", 5_000, null, CODE_A);
        var reversal = w.bank.updateWithCode(delivery.transactionId(), "REVERSED", 5_000, null, CODE_A);
        assertThat(reversal.outcome()).isEqualTo("APPLIED");
        var row = tx(delivery.transactionId());
        assertThat(row.get("status")).isEqualTo("REVERSED");
        assertThat(row.get("attribution_status")).isEqualTo("RESOLVED");
        assertThat(row.get("reported_code")).isEqualTo(CODE_A);
        assertThat(allocations()).isZero();
        assertThat(attribution(delivery).path("transactionStatus").asString()).isEqualTo("REVERSED");
    }

    // ---- agents: only from an exact sale reference, never from who holds the code ----------------

    @Test
    void theAgentComesFromTheSalesSnapshotEvenAfterTheCodeIsReassigned() {
        JsonNode code = codeA();
        JsonNode sale = sale(12_000, code);
        String reference = sale.path("saleReference").asString();
        String open = jdbc.queryForObject("select id::text from collection_code_assignments where code_id = ?::uuid and valid_to is null", String.class, id(code));
        assertThat(reassign(code, open, otherCashierMembership, "Shift change").status()).isEqualTo(200);

        var delivery = w.bank.payWithCode("POSTED", 12_000, reference, CODE_A);
        var row = tx(delivery.transactionId());
        assertThat(row.get("attribution_status")).isEqualTo("RESOLVED");
        assertThat(row.get("agent_attribution")).isEqualTo("CONFIRMED_FROM_SALE_SNAPSHOT");
        assertThat(row.get("referenced_code_sale_id").toString()).isEqualTo(sale.path("saleId").asString());
        JsonNode view = attribution(delivery);
        // Aline made the sale; Eric holds the code now. The attribution names Aline, from the snapshot.
        assertThat(view.path("agentName").asString()).isEqualTo("Aline Cashier");
        assertThat(view.path("saleReference").asString()).isEqualTo(reference);
        // It is evidence only: nothing was matched or allocated (R6c policy, until the bank's evidence is confirmed).
        assertThat(view.path("saleReferenceMatched").asBoolean()).isFalse();
        assertThat(allocations()).isZero();
        assertThat(row.get("payment_request_id")).isNull();
    }

    @Test
    void withoutAnExactSaleReferenceTheAgentIsUnresolvedWhoeverHoldsTheCodeNow() {
        JsonNode code = codeA();
        String open = jdbc.queryForObject("select id::text from collection_code_assignments where code_id = ?::uuid and valid_to is null", String.class, id(code));
        assertThat(reassign(code, open, otherCashierMembership, "Shift change").status()).isEqualTo(200);
        var delivery = w.bank.payWithCode("POSTED", 12_000, null, CODE_A);
        JsonNode view = attribution(delivery);
        assertThat(view.path("attributionStatus").asString()).isEqualTo("RESOLVED");
        assertThat(view.path("agentAttribution").asString()).isEqualTo("UNRESOLVED");
        assertThat(absent(view.path("agentName"))).isTrue();
        assertThat(view.toString()).doesNotContain("Eric").doesNotContain("Aline");
        // A reference that merely LOOKS like a sale reference but names no sale is not evidence either.
        var lookalike = w.bank.payWithCode("POSTED", 12_000, "OP-ABCDEFGHJKMN", CODE_A);
        assertThat(attribution(lookalike).path("agentAttribution").asString()).isEqualTo("UNRESOLVED");
    }

    @Test
    void aReportedCodeThatContradictsTheSalesCodeIsAConflict() {
        JsonNode code = codeA();
        activeCode("Second", "EQ-CODE-B2");
        JsonNode sale = sale(12_000, code);
        var delivery = w.bank.payWithCode("POSTED", 12_000, sale.path("saleReference").asString(), "EQ-CODE-B2");
        var row = tx(delivery.transactionId());
        assertThat(row.get("attribution_status")).isEqualTo("CONFLICT");
        assertThat(row.get("agent_attribution")).isEqualTo("UNRESOLVED");
        assertThat(row.get("review_state")).isEqualTo("NEEDS_REVIEW");
        assertThat(allocations()).isZero();
    }

    @Test
    void aSaleReferenceAloneNamesTheSaleButNeverConfirmsTheCollector() {
        JsonNode code = codeA();
        JsonNode sale = sale(12_000, code);
        // Exact sale reference, no reported code: the sale is identified, but code and agent evidence stay incomplete.
        var byReference = w.bank.pay("POSTED", 12_000, sale.path("saleReference").asString());
        var row = tx(byReference.transactionId());
        assertThat(row.get("attribution_status")).isEqualTo("NOT_REPORTED");
        assertThat(row.get("agent_attribution")).isEqualTo("SALE_NAMED_UNCONFIRMED");
        assertThat(row.get("referenced_code_sale_id").toString()).isEqualTo(sale.path("saleId").asString());
        assertThat(row.get("collection_code_id")).isNull();
        JsonNode view = attribution(byReference);
        assertThat(view.path("saleReference").asString()).isEqualTo(sale.path("saleReference").asString());
        assertThat(absent(view.path("agentName"))).isTrue();
        assertThat(absent(view.path("collectionCode"))).isTrue();
        assertThat(view.toString()).doesNotContain("Aline");
        // An amount alone is nothing at all.
        var byAmount = w.bank.pay("POSTED", 12_000, null);
        assertThat(attribution(byAmount).path("agentAttribution").asString()).isEqualTo("UNRESOLVED");
    }

    @Test
    void theCollectorIsConfirmedOnlyWhenTheSaleTheReportedCodeAndTheAccountAgree() {
        JsonNode code = codeA();
        JsonNode sale = sale(12_000, code);
        var delivery = w.bank.payWithCode("POSTED", 12_000, sale.path("saleReference").asString(), CODE_A);
        var row = tx(delivery.transactionId());
        assertThat(row.get("attribution_status")).isEqualTo("RESOLVED");
        assertThat(row.get("agent_attribution")).isEqualTo("CONFIRMED_FROM_SALE_SNAPSHOT");
        assertThat(row.get("settlement_destination_id")).isEqualTo(destination);
        JsonNode view = attribution(delivery);
        assertThat(view.path("agentName").asString()).isEqualTo("Aline Cashier");
        assertThat(view.path("collectionCode").path("id").asString()).isEqualTo(id(code));
        // Evidence and conclusion are separate facts: the reference and the reported code are recorded as they arrived.
        assertThat(row.get("reported_code")).isEqualTo(CODE_A);
        assertThat(row.get("payment_reference")).isEqualTo(sale.path("saleReference").asString());
    }

    @Test
    void aConflictingCodeWithAnExactSaleReferenceIsAConflictAndTheSalesAgentIsNeverPresentedAsTheCollector() {
        JsonNode code = codeA();
        activeCode("Second", "EQ-CODE-B2");
        JsonNode sale = sale(12_000, code);
        var delivery = w.bank.payWithCode("POSTED", 12_000, sale.path("saleReference").asString(), "EQ-CODE-B2");
        var row = tx(delivery.transactionId());
        assertThat(row.get("attribution_status")).isEqualTo("CONFLICT");
        assertThat(row.get("agent_attribution")).isEqualTo("UNRESOLVED");
        JsonNode view = attribution(delivery);
        assertThat(view.path("attributionStatus").asString()).isEqualTo("CONFLICT");
        assertThat(absent(view.path("agentName"))).isTrue();
        assertThat(view.toString()).doesNotContain("Aline");
        assertThat(allocations()).isZero();
    }

    @Test
    void aCodeAloneAttributesTheCodeAndNeverAnAgent() {
        codeA();
        var delivery = w.bank.payWithCode("POSTED", 4_000, null, CODE_A);
        JsonNode view = attribution(delivery);
        assertThat(view.path("attributionStatus").asString()).isEqualTo("RESOLVED");
        assertThat(view.path("agentAttribution").asString()).isEqualTo("UNRESOLVED");
        assertThat(absent(view.path("agentName"))).isTrue();
        assertThat(view.toString()).doesNotContain("Aline");
    }

    // ---- event evolution -----------------------------------------------------------------------------------------------

    @Test
    void aLaterEventThatCompletesTheCodeUpgradesANamedSaleToAConfirmedCollector() {
        JsonNode code = codeA();
        JsonNode sale = sale(12_000, code);
        var pending = w.bank.pay("PENDING", 12_000, sale.path("saleReference").asString());
        assertThat(tx(pending.transactionId()).get("agent_attribution")).isEqualTo("SALE_NAMED_UNCONFIRMED");
        w.bank.updateWithCode(pending.transactionId(), "POSTED", 12_000, null, CODE_A);
        var row = tx(pending.transactionId());
        assertThat(row.get("attribution_status")).isEqualTo("RESOLVED");
        assertThat(row.get("agent_attribution")).isEqualTo("CONFIRMED_FROM_SALE_SNAPSHOT");
        assertThat(attribution(pending).path("agentName").asString()).isEqualTo("Aline Cashier");
    }

    @Test
    void aLaterContradictionWithdrawsAConfirmedCollectorAndStaysAConflictForGood() {
        JsonNode code = codeA();
        JsonNode sale = sale(12_000, code);
        var first = w.bank.payWithCode("PENDING", 12_000, sale.path("saleReference").asString(), CODE_A);
        assertThat(tx(first.transactionId()).get("agent_attribution")).isEqualTo("CONFIRMED_FROM_SALE_SNAPSHOT");
        w.bank.updateWithCode(first.transactionId(), "POSTED", 12_000, null, "EQ-OTHER-2");
        var row = tx(first.transactionId());
        assertThat(row.get("attribution_status")).isEqualTo("CONFLICT");
        assertThat(row.get("agent_attribution")).isEqualTo("UNRESOLVED");
        // The evidence that arrived first is untouched.
        assertThat(row.get("reported_code")).isEqualTo(CODE_A);
        assertThat(row.get("collection_code_id").toString()).isEqualTo(id(code));
        assertThat(absent(attribution(first).path("agentName"))).isTrue();
        // A conflict is final: nothing can resolve it again, in the application or the database.
        assertThatThrownBy(() -> jdbc.update("update bank_transactions set attribution_status = 'RESOLVED', agent_attribution = 'CONFIRMED_FROM_SALE_SNAPSHOT' "
                + "where provider_transaction_id = ?", first.transactionId())).hasMessageContaining("final");
    }

    @Test
    void aTransactionAlreadyAppliedToAnOrdinaryInvoiceIsFinanciallyUntouchedByALaterCodeConflict() {
        codeA();
        UUID invoice = w.issuedInvoice(30_000);
        String number = jdbc.queryForObject("select invoice_number from invoices where id = ?", String.class, invoice);
        var pending = w.bank.payWithCode("PENDING", 30_000, number, CODE_A);
        // The confirmation reports a different code AND is applied to the ordinary invoice by its exact number (legacy behaviour).
        w.bank.updateWithCode(pending.transactionId(), "POSTED", 30_000, number, "EQ-OTHER-2");
        var row = tx(pending.transactionId());
        assertThat(row.get("attribution_status")).isEqualTo("CONFLICT");
        assertThat(allocations()).isEqualTo(1);
        assertThat(jdbc.queryForObject("select amount_rwf from payment_allocations", Long.class)).isEqualTo(30_000L);
        assertThat(jdbc.queryForObject("select status from payment_allocations", String.class)).isEqualTo("ACTIVE");
        assertThat(row.get("review_state")).isEqualTo("NONE");
        assertThat(w.owner.get(m("/invoices/" + invoice)).json().path("paymentStatus").asString()).isEqualTo("PAID");
    }

    @Test
    void aReversalKeepsTheHistoryButNeverShowsAnAgentAsHavingCollectedReversedMoney() {
        JsonNode code = codeA();
        JsonNode sale = sale(12_000, code);
        var delivery = w.bank.payWithCode("POSTED", 12_000, sale.path("saleReference").asString(), CODE_A);
        assertThat(attribution(delivery).path("agentName").asString()).isEqualTo("Aline Cashier");
        w.bank.updateWithCode(delivery.transactionId(), "REVERSED", 12_000, sale.path("saleReference").asString(), CODE_A);
        JsonNode view = attribution(delivery);
        assertThat(view.path("transactionStatus").asString()).isEqualTo("REVERSED");
        // The attribution history is preserved; no collector is presented and no sale is shown as paid.
        assertThat(view.path("attributionStatus").asString()).isEqualTo("RESOLVED");
        assertThat(view.path("agentAttribution").asString()).isEqualTo("CONFIRMED_FROM_SALE_SNAPSHOT");
        assertThat(absent(view.path("agentName"))).isTrue();
        assertThat(view.path("saleReferenceMatched").asBoolean()).isFalse();
        assertThat(allocations()).isZero();
        assertThat(w.cashier.get(m("/bank-attributions")).json().path("items").size()).isZero();
    }

    // ---- views agree with the SQL scopes, in lists, pages and direct lookups ----------------------------------------------

    @Test
    void everyRoleSeesTheSameRowsInPagesAndInDirectLookups() {
        JsonNode code = codeA();
        JsonNode sale = sale(12_000, code);
        var confirmed = w.bank.payWithCode("POSTED", 12_000, sale.path("saleReference").asString(), CODE_A);
        var codeOnly = w.bank.payWithCode("POSTED", 3_000, null, CODE_A);
        var named = w.bank.pay("POSTED", 2_000, sale.path("saleReference").asString());
        var unknown = w.bank.payWithCode("POSTED", 4_000, null, "ZZ-UNKNOWN-9");
        String confirmedId = tx(confirmed.transactionId()).get("id").toString();
        String codeOnlyId = tx(codeOnly.transactionId()).get("id").toString();
        String namedId = tx(named.transactionId()).get("id").toString();
        String unknownId = tx(unknown.transactionId()).get("id").toString();

        // Paged one at a time, each role gets exactly its set, with no duplicates and none missing.
        assertThat(paged(w.owner)).containsExactlyInAnyOrder(confirmedId, codeOnlyId, namedId, unknownId);
        assertThat(paged(w.manager)).containsExactlyInAnyOrder(confirmedId, codeOnlyId, namedId);
        assertThat(paged(w.cashier)).containsExactly(confirmedId);
        assertThat(paged(w.otherCashier)).isEmpty();

        // A direct lookup follows the very same scope.
        for (String id : List.of(confirmedId, codeOnlyId, namedId, unknownId)) {
            assertThat(w.owner.get(m("/bank-attributions/" + id)).status()).isEqualTo(200);
        }
        assertThat(w.manager.get(m("/bank-attributions/" + unknownId)).status()).isEqualTo(404);
        assertThat(w.manager.get(m("/bank-attributions/" + codeOnlyId)).status()).isEqualTo(200);
        assertThat(w.cashier.get(m("/bank-attributions/" + confirmedId)).status()).isEqualTo(200);
        for (String id : List.of(codeOnlyId, namedId, unknownId)) {
            assertThat(w.cashier.get(m("/bank-attributions/" + id)).status()).isEqualTo(404);
        }
    }

    private List<String> paged(rw.oupay.support.TestApi api) {
        List<String> seen = new ArrayList<>();
        String cursor = null;
        for (int guard = 0; guard < 20; guard++) {
            var page = api.get(m("/bank-attributions?limit=1" + (cursor == null ? "" : "&cursor=" + cursor)));
            assertThat(page.status()).as(page.body()).isEqualTo(200);
            seen.addAll(ids(page.json()));
            JsonNode next = page.json().path("nextCursor");
            if (next.isMissingNode() || next.isNull()) {
                return seen;
            }
            cursor = next.asString();
        }
        throw new AssertionError("the pages never ended");
    }

    @Test
    void aConflictBetweenTwoBranchesShowsOneBranchNothingOfTheOther() {
        // The manager works only at RM01. A payment reports RM01's code but names a sale made at RM02: a conflict about two branches.
        codeA();
        UUID rm02 = fixtures.branch(w.merchantId, "RM02", "ACTIVE");
        fixtures.assign(w.merchantId, cashierMembership, rm02);
        JsonNode codeRm02 = activeCodeAt("Second branch", "EQ-CODE-B2", rm02);
        assertThat(assign(codeRm02, cashierMembership).status()).isEqualTo(201);
        ensureProfile();
        var made = bill(w.cashier, "key-rm02-0001", body(9_000, null, UUID.fromString(id(codeRm02)), UUID.randomUUID()));
        assertThat(made.status()).as(made.body()).isEqualTo(201);

        var delivery = w.bank.payWithCode("POSTED", 9_000, made.json().path("saleReference").asString(), CODE_A);
        assertThat(tx(delivery.transactionId()).get("attribution_status")).isEqualTo("CONFLICT");
        String id = tx(delivery.transactionId()).get("id").toString();
        // The owner sees all of it; the RM01 manager must see none of RM02's sale or code, nor anything about it.
        assertThat(w.owner.get(m("/bank-attributions/" + id)).status()).isEqualTo(200);
        assertThat(w.manager.get(m("/bank-attributions/" + id)).status()).isEqualTo(404);
        assertThat(w.manager.get(m("/bank-attributions")).body()).doesNotContain(made.json().path("saleReference").asString()).doesNotContain("Second branch");
    }

    /** A bank-approved code at a given branch. */
    private JsonNode activeCodeAt(String label, String bankCode, UUID branchId) {
        JsonNode requested = requestedCode(label, branchId, destination);
        var submitted = w.owner.post(codes() + "/" + id(requested) + "/submission",
                Map.of("expectedVersion", requested.path("version").asLong(), "bankRequestRef", "EQ-" + label));
        assertThat(submitted.status()).isEqualTo(200);
        approvals.approve(w.merchantId, UUID.fromString(id(requested)), bankCode,
                new CollectionCodeApprovalService.Evidence(ApprovalSource.OPERATOR, "Equity letter EQ-2026-014", operatorA, operatorB));
        return w.owner.get(codes() + "/" + id(requested)).json();
    }

    // ---- the database refuses what the application must never do -------------------------------------------------------------

    @Test
    void noNullCanSlipPastTheConstraintsAndNoCrossTenantOrCrossAccountLinkCanBeStored() {
        JsonNode code = codeA();
        JsonNode sale = sale(12_000, code);
        var plain = w.bank.pay("POSTED", 1_000, null);
        String t = plain.transactionId();
        // A verdict without its basis, or a resolved one without a code, is refused (NULL cannot make a CHECK pass).
        assertThatThrownBy(() -> jdbc.update("update bank_transactions set attribution_status = 'RESOLVED', attribution_basis = null where provider_transaction_id = ?", t))
                .isNotNull();
        assertThatThrownBy(() -> jdbc.update("update bank_transactions set attribution_status = 'RESOLVED', attribution_basis = 'CODE_REPORTED' "
                + "where provider_transaction_id = ?", t)).isNotNull();
        // An agent cannot be "confirmed" without the sale, the code and the account agreeing.
        assertThatThrownBy(() -> jdbc.update("update bank_transactions set agent_attribution = 'CONFIRMED_FROM_SALE_SNAPSHOT', "
                + "referenced_code_sale_id = ?::uuid where provider_transaction_id = ?", sale.path("saleId").asString(), t)).isNotNull();
        // A named-but-unconfirmed agent needs a named sale.
        assertThatThrownBy(() -> jdbc.update("update bank_transactions set agent_attribution = 'SALE_NAMED_UNCONFIRMED' where provider_transaction_id = ?", t))
                .isNotNull();
        // Another business's destination, and a sale that does not exist for this business, cannot be attached to this business's money.
        Bank.link(mvc, w.cafeOwner, w.cafeMerchantId);
        UUID cafeDestination = jdbc.queryForObject("select id from payment_destinations where merchant_id = ?", UUID.class, w.cafeMerchantId);
        assertThatThrownBy(() -> jdbc.update("update bank_transactions set settlement_destination_id = ? where provider_transaction_id = ?", cafeDestination, t)).isNotNull();
        assertThatThrownBy(() -> jdbc.update("update bank_transactions set referenced_code_sale_id = ? where provider_transaction_id = ?", UUID.randomUUID(), t)).isNotNull();
        // Nothing above changed the row.
        assertThat(tx(t).get("attribution_status")).isEqualTo("NOT_REPORTED");
        assertThat(tx(t).get("agent_attribution")).isEqualTo("UNRESOLVED");
    }

    // ---- no allocation, and existing behaviour preserved ---------------------------------------------

    @Test
    void noCodeSaleIsEverAllocatedByAttribution() {
        JsonNode code = codeA();
        JsonNode sale = sale(12_000, code);
        // Exact reference, exact code, exact amount, right account: still only evidence.
        var delivery = w.bank.payWithCode("POSTED", 12_000, sale.path("saleReference").asString(), CODE_A);
        assertThat(allocations()).isZero();
        assertThat(tx(delivery.transactionId()).get("payment_request_id")).isNull();
        assertThat(w.owner.get(m("/invoices/" + sale.path("invoiceId").asString())).json().path("paymentStatus").asString()).isEqualTo("UNPAID");
        assertThat(attribution(delivery).path("saleReferenceMatched").asBoolean()).isFalse();
    }

    @Test
    void anOrdinaryInvoiceStillReconcilesAutomaticallyAndAnUnknownCodeDoesNotFlagMoneyThatWasApplied() {
        codeA();
        UUID invoice = w.issuedInvoice(30_000);
        String number = jdbc.queryForObject("select invoice_number from invoices where id = ?", String.class, invoice);
        var delivery = w.bank.payWithCode("POSTED", 30_000, number, "ZZ-UNKNOWN-9");
        assertThat(allocations()).isEqualTo(1);
        assertThat(jdbc.queryForObject("select origin from payment_allocations", String.class)).isEqualTo("AUTO_REFERENCE");
        var row = tx(delivery.transactionId());
        assertThat(row.get("attribution_status")).isEqualTo("UNRESOLVED");
        assertThat(row.get("review_state")).isEqualTo("NONE");
    }

    @Test
    void transactionsWithoutAnyAttributionStayExactlyAsTheyWere() {
        // Historical rows carry no attribution at all: every new column NULL, and the owner view says so plainly.
        var delivery = w.bank.pay("POSTED", 1_000, null);
        // (Recorded evidence cannot be erased by the application: to stage a historical row the guard is switched off for this one statement.)
        jdbc.execute("alter table bank_transactions disable trigger trg_bank_transactions_attribution");
        try {
            jdbc.update("update bank_transactions set attribution_status = null, attribution_basis = null, agent_attribution = null, attributed_at = null, "
                    + "attribution_note = null, settlement_destination_id = null where provider_transaction_id = ?", delivery.transactionId());
        } finally {
            jdbc.execute("alter table bank_transactions enable trigger trg_bank_transactions_attribution");
        }
        JsonNode view = attribution(delivery);
        assertThat(view.path("attributionStatus").asString()).isEqualTo("NOT_EVALUATED");
        assertThat(absent(view.path("attributionBasis"))).isTrue();
    }

    // ---- who may see what ----------------------------------------------------------------------------

    @Test
    void ownersSeeEverythingManagersTheirBranchesAndCashiersOnlyTheirOwnSales() {
        JsonNode code = codeA();
        JsonNode sale = sale(12_000, code);
        var bySale = w.bank.payWithCode("POSTED", 12_000, sale.path("saleReference").asString(), CODE_A);
        var codeOnly = w.bank.payWithCode("POSTED", 3_000, null, CODE_A);
        var unknown = w.bank.payWithCode("POSTED", 4_000, null, "ZZ-UNKNOWN-9");
        var none = w.bank.pay("POSTED", 5_000, null);

        List<String> owner = ids(w.owner.get(m("/bank-attributions")).json());
        assertThat(owner).hasSize(4);

        // The manager works at the code's branch: attributed to that branch, resolved only. Unresolved and account-only are the owner's.
        List<String> manager = ids(w.manager.get(m("/bank-attributions")).json());
        assertThat(manager).containsExactlyInAnyOrder(tx(bySale.transactionId()).get("id").toString(), tx(codeOnly.transactionId()).get("id").toString());
        // Another manager with no branch sees nothing.
        jdbc.update("update branch_assignments set status = 'ENDED', ended_at = now() where membership_id = ?", w.managerMembershipId);
        assertThat(ids(w.manager.get(m("/bank-attributions")).json())).isEmpty();

        // The cashier sees only the payment that names THEIR OWN sale, with the reported code masked.
        var cashier = w.cashier.get(m("/bank-attributions"));
        assertThat(cashier.status()).isEqualTo(200);
        assertThat(ids(cashier.json())).containsExactly(tx(bySale.transactionId()).get("id").toString());
        JsonNode mine = cashier.json().path("items").get(0);
        assertThat(mine.path("reportedCode").asString()).startsWith("••••");
        assertThat(mine.path("reportedCodeMasked").asBoolean()).isTrue();
        assertThat(mine.path("reportedCode").asString()).doesNotContain(CODE_A);
        assertThat(w.cashier.get(m("/bank-attributions/" + tx(codeOnly.transactionId()).get("id"))).status()).isEqualTo(404);
        assertThat(w.otherCashier.get(m("/bank-attributions")).json().path("items").size()).isZero();
        assertThat(unknown.outcome()).isEqualTo("APPLIED");
        assertThat(none.outcome()).isEqualTo("APPLIED");
    }

    @Test
    void aManagerSeesTheFullCodeOnlyWhenItResolvedAndNeverApprovalEvidenceOrInternalReferences() {
        JsonNode code = codeA();
        w.bank.payWithCode("POSTED", 3_000, null, CODE_A);
        var body = w.manager.get(m("/bank-attributions")).body();
        assertThat(body).contains(CODE_A).doesNotContain("Equity letter").doesNotContain("EQ-EQ-").doesNotContain("bankRequestRef")
                .doesNotContain(String.valueOf(code.path("internalRef").asString())).doesNotContain("evidence").doesNotContain("secret");
        var ownerBody = w.owner.get(m("/bank-attributions")).body();
        assertThat(ownerBody).doesNotContain("Equity letter").doesNotContain("evidence").doesNotContain("shared-secret");
    }

    @Test
    void aSuspendedMemberAndAnOutsiderGetNothingAndAnotherBusinessGetsNotFound() {
        codeA();
        var delivery = w.bank.payWithCode("POSTED", 3_000, null, CODE_A);
        jdbc.update("update memberships set status = 'SUSPENDED' where id = ?", cashierMembership);
        assertThat(w.cashier.get(m("/bank-attributions")).status()).isIn(401, 403, 404);
        UUID txId = (UUID) tx(delivery.transactionId()).get("id");
        assertThat(w.cafeOwner.get("/api/v1/merchants/" + w.cafeMerchantId + "/bank-attributions/" + txId).status()).isEqualTo(404);
        assertThat(w.cafeOwner.get(m("/bank-attributions/" + txId)).status()).isIn(403, 404);
        assertThat(w.cafeOwner.get(m("/bank-attributions")).status()).isIn(403, 404);
        assertThat(w.owner.get(m("/bank-attributions/" + UUID.randomUUID())).status()).isEqualTo(404);
        assertThat(w.cashier.get(m("/bank-attributions")).body()).doesNotContain(CODE_A);
    }

    // ---- the database keeps the evidence ------------------------------------------------------------------

    @Test
    void recordedEvidenceCannotBeOverwrittenAndACodeOfAnotherBusinessCannotBeAttributed() {
        codeA();
        var delivery = w.bank.payWithCode("POSTED", 3_000, null, CODE_A);
        String t = delivery.transactionId();
        assertThatThrownBy(() -> jdbc.update("update bank_transactions set reported_code = 'EQ-CHANGED' where provider_transaction_id = ?", t))
                .hasMessageContaining("exactly the value");
        assertThatThrownBy(() -> jdbc.update("update bank_transactions set origin_provider_event_id = 'evt-forged' where provider_transaction_id = ?", t))
                .hasMessageContaining("never overwritten");
        assertThatThrownBy(() -> jdbc.update("update bank_transactions set collection_code_id = null where provider_transaction_id = ?", t))
                .hasMessageContaining("never overwritten");
        assertThatThrownBy(() -> jdbc.update("update bank_transactions set attribution_status = 'UNRESOLVED' where provider_transaction_id = ?", t))
                .hasMessageContaining("not changed");
        // A code that is not the one the bank reported, or that settles to another account, cannot be recorded.
        JsonNode second = activeCode("Second", "EQ-CODE-B2");
        var other = w.bank.pay("POSTED", 1_000, null);
        assertThatThrownBy(() -> jdbc.update("update bank_transactions set reported_code = 'EQ-CODE-A1', collection_code_id = ?::uuid, "
                + "attribution_status = 'RESOLVED', attribution_basis = 'CODE_REPORTED' where provider_transaction_id = ?", id(second), other.transactionId()))
                .hasMessageContaining("exactly the value");
    }

    @Test
    void theDatabaseConfirmsAnAgentOnlyForASaleOfTheSameCodeAndAccount() {
        codeA();
        JsonNode other = activeCode("Second", "EQ-CODE-B2");
        assertThat(assign(other, cashierMembership).status()).isEqualTo(201);
        ensureProfile();
        var made = bill(w.cashier, "key-other-0001", body(5_000, null, UUID.fromString(id(other)), UUID.randomUUID()));
        assertThat(made.status()).as(made.body()).isEqualTo(201);
        // Money resolved to code A, with no sale named.
        var delivery = w.bank.payWithCode("POSTED", 5_000, null, CODE_A);
        // Naming a sale of ANOTHER code and calling its agent the collector is refused by the database.
        assertThatThrownBy(() -> jdbc.update("update bank_transactions set referenced_code_sale_id = ?::uuid, agent_attribution = 'CONFIRMED_FROM_SALE_SNAPSHOT' "
                + "where provider_transaction_id = ?", made.json().path("saleId").asString(), delivery.transactionId()))
                .hasMessageContaining("agree");
        assertThat(tx(delivery.transactionId()).get("agent_attribution")).isEqualTo("UNRESOLVED");
    }
}
