package rw.oupay.ledger;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import rw.oupay.support.Bank;
import rw.oupay.support.IntegrationTest;
import rw.oupay.support.World;

/**
 * The financial rules, exercised through the real provider boundary and the real merchant API,
 * against PostgreSQL.
 */
class LedgerIT extends IntegrationTest {

    World w;
    Bank bank;

    @BeforeEach
    void world() {
        w = World.create(this);
        bank = w.bank;
    }

    private String m(String path) {
        return "/api/v1/merchants/" + w.merchantId + path;
    }

    private String number(UUID invoiceId) {
        return jdbc.queryForObject("select invoice_number from invoices where id = ?", String.class, invoiceId);
    }

    private long remaining(UUID invoiceId) {
        return w.owner.get(m("/invoices/" + invoiceId)).json().path("payment").path("remainingBalance").asLong();
    }

    private String paymentStatus(UUID invoiceId) {
        return w.owner.get(m("/invoices/" + invoiceId)).json().path("paymentStatus").asString();
    }

    private String txId(Bank.Delivery d) {
        return jdbc.queryForObject("select id from bank_transactions where provider_transaction_id = ?", String.class, d.transactionId());
    }

    // ---- invoice balances derived from allocations ---------------------------------------------

    @Test
    void partialFullThenReversalOfTheFirstPayment() {
        UUID invoice = w.issuedInvoice(50_000);
        String ref = number(invoice);

        var first = bank.pay("POSTED", 20_000, ref);
        assertThat(first.outcome()).isEqualTo("APPLIED");
        assertThat(remaining(invoice)).isEqualTo(30_000);
        assertThat(paymentStatus(invoice)).isEqualTo("PARTIALLY_PAID");

        var second = bank.pay("POSTED", 30_000, ref);
        assertThat(second.outcome()).isEqualTo("APPLIED");
        assertThat(remaining(invoice)).isZero();
        assertThat(paymentStatus(invoice)).isEqualTo("PAID");

        assertThat(bank.update(first.transactionId(), "REVERSED", 20_000, ref).outcome()).isEqualTo("APPLIED");
        assertThat(remaining(invoice)).isEqualTo(20_000);
        assertThat(paymentStatus(invoice)).isEqualTo("PARTIALLY_PAID");
        // The reversed allocation stays on record.
        assertThat(jdbc.queryForObject("select count(*) from payment_allocations where status = 'REVERSED' and reversal_kind = 'BANK_REVERSAL'", Integer.class)).isEqualTo(1);
    }

    @Test
    void pendingAndFailedMoneyIsNeverCounted() {
        UUID invoice = w.issuedInvoice(10_000);
        String ref = number(invoice);
        var pending = bank.pay("PENDING", 10_000, ref);
        bank.pay("REJECTED", 10_000, ref);
        assertThat(paymentStatus(invoice)).isEqualTo("UNPAID");
        assertThat(bank.update(pending.transactionId(), "POSTED", 10_000, ref).outcome()).isEqualTo("APPLIED");
        assertThat(paymentStatus(invoice)).isEqualTo("PAID");
    }

    // ---- matching rules ------------------------------------------------------------------------

    @Test
    void onlyAnExactReferenceMatches() {
        UUID invoice = w.issuedInvoice(5_000);
        bank.pay("POSTED", 5_000, null);                                     // same amount, no reference
        bank.pay("POSTED", 5_000, number(invoice).toLowerCase());           // near miss
        bank.pay("POSTED", 5_000, number(invoice) + "X");                   // extra character
        assertThat(paymentStatus(invoice)).isEqualTo("UNPAID");
        var list = w.owner.get(m("/bank-transactions")).json();
        assertThat(list.size()).isEqualTo(3);
        for (var tx : list) {
            assertThat(tx.path("reconciliationStatus").asString()).isEqualTo("UNMATCHED");
            assertThat(tx.path("unappliedAmount").asLong()).isEqualTo(5_000);
        }
    }

    @Test
    void sameAmountConcurrentPaymentsMatchOnlyTheirOwnReference() {
        UUID a = w.issuedInvoice(7_000);
        UUID b = w.issuedInvoice(7_000);
        bank.pay("POSTED", 7_000, number(a));
        bank.pay("POSTED", 7_000, null);
        assertThat(paymentStatus(a)).isEqualTo("PAID");
        assertThat(paymentStatus(b)).isEqualTo("UNPAID");
    }

    @Test
    void anUnknownReferenceNeedsReviewAndMatchesNothing() {
        w.issuedInvoice(5_000);
        bank.pay("POSTED", 5_000, "NO-SUCH-INVOICE");
        var tx = w.owner.get(m("/bank-transactions")).json().get(0);
        assertThat(tx.path("reviewState").asString()).isEqualTo("NEEDS_REVIEW");
        assertThat(tx.path("reconciliationStatus").asString()).isEqualTo("UNMATCHED");
    }

    // ---- idempotency, ordering, validation ------------------------------------------------------

    @Test
    void aReplayedEventIsCountedOnce() {
        UUID invoice = w.issuedInvoice(10_000);
        var first = bank.send("POSTED", 10_000, number(invoice), "tx-dup", "evt-dup", bank.at(1));
        var replay = bank.send("POSTED", 10_000, number(invoice), "tx-dup", "evt-dup", bank.at(1));
        assertThat(first.outcome()).isEqualTo("APPLIED");
        assertThat(replay.outcome()).isEqualTo("DUPLICATE");
        assertThat(jdbc.queryForObject("select count(*) from bank_transactions", Integer.class)).isEqualTo(1);
        assertThat(jdbc.queryForObject("select count(*) from payment_allocations", Integer.class)).isEqualTo(1);
        assertThat(jdbc.queryForObject("select count(*) from bank_events", Integer.class)).isEqualTo(1);
        assertThat(remaining(invoice)).isZero();
    }

    @Test
    void theSameTransactionUnderANewEventIdIsAlsoCountedOnce() {
        UUID invoice = w.issuedInvoice(10_000);
        bank.send("POSTED", 10_000, number(invoice), "tx-same", "evt-1", bank.at(1));
        var again = bank.send("POSTED", 10_000, number(invoice), "tx-same", "evt-2", bank.at(2));
        assertThat(again.outcome()).isEqualTo("DUPLICATE");
        assertThat(jdbc.queryForObject("select count(*) from payment_allocations", Integer.class)).isEqualTo(1);
    }

    @Test
    void aLateOlderConfirmationNeverUndoesANewerReversal() {
        UUID invoice = w.issuedInvoice(10_000);
        bank.send("REVERSED", 10_000, number(invoice), "tx-ooo", "evt-new", bank.at(10));
        var late = bank.send("POSTED", 10_000, number(invoice), "tx-ooo", "evt-old", bank.at(2));
        assertThat(late.outcome()).isEqualTo("STALE");
        assertThat(paymentStatus(invoice)).isEqualTo("UNPAID");
        assertThat(jdbc.queryForObject("select status from bank_transactions where provider_transaction_id = 'tx-ooo'", String.class)).isEqualTo("REVERSED");
    }

    @Test
    void changedAmountsAndForeignAccountsAreRejected() {
        UUID invoice = w.issuedInvoice(10_000);
        bank.send("PENDING", 10_000, number(invoice), "tx-amt", "e1", bank.at(1));
        assertThat(bank.send("POSTED", 99_000, number(invoice), "tx-amt", "e2", bank.at(2)).outcome()).isEqualTo("REJECTED");
        var unknownAccount = new Bank(mvc, "bacc-unknown").send("POSTED", 1_000, null, "tx-unk", "e3", bank.at(3));
        assertThat(unknownAccount.outcome()).isEqualTo("REJECTED");
        assertThat(jdbc.queryForObject("select count(*) from bank_transactions where provider_transaction_id = 'tx-unk'", Integer.class)).isZero();
        // The rejection is still recorded in the immutable event log.
        assertThat(jdbc.queryForObject("select outcome from bank_events where provider_event_id = 'e3'", String.class)).isEqualTo("REJECTED");
    }

    @Test
    void aDisabledConnectionStopsAcceptingEvents() {
        String connection = w.owner.get(m("/bank-connections")).json().get(0).path("id").asString();
        assertThat(w.owner.post(m("/bank-connections/" + connection + "/disable"), null).status()).isEqualTo(200);
        assertThat(bank.pay("POSTED", 1_000, null).outcome()).isEqualTo("REJECTED");
    }

    @Test
    void theSameAccountEventCannotTouchAnotherBusinessTransaction() {
        // The cafe links its own account; a shop-account event cannot reuse a cafe transaction id.
        Bank cafeBank = Bank.link(mvc, w.cafeOwner, w.cafeMerchantId);
        cafeBank.send("POSTED", 1_000, null, "tx-shared", "cafe-1", cafeBank.at(1));
        var spoof = bank.send("POSTED", 1_000, null, "tx-shared", "shop-1", bank.at(2));
        assertThat(spoof.outcome()).isEqualTo("REJECTED");
        assertThat(jdbc.queryForObject("select merchant_id from bank_transactions where provider_transaction_id = 'tx-shared'", UUID.class))
                .isEqualTo(w.cafeMerchantId);
    }

    // ---- overpayment and invoice state ---------------------------------------------------------

    @Test
    void anOverpaymentAppliesOnlyWhatIsOwedAndFlagsTheRest() {
        UUID invoice = w.issuedInvoice(50_000);
        bank.pay("POSTED", 60_000, number(invoice));
        assertThat(remaining(invoice)).isZero();
        assertThat(paymentStatus(invoice)).isEqualTo("PAID");
        var tx = w.owner.get(m("/bank-transactions")).json().get(0);
        assertThat(tx.path("allocatedAmount").asLong()).isEqualTo(50_000);
        assertThat(tx.path("unappliedAmount").asLong()).isEqualTo(10_000);
        assertThat(tx.path("reviewState").asString()).isEqualTo("NEEDS_REVIEW");
    }

    @Test
    void aPaidVoidedOrCancelledInvoiceReceivesNothingMore() {
        UUID paid = w.issuedInvoice(5_000);
        bank.pay("POSTED", 5_000, number(paid));
        bank.pay("POSTED", 5_000, number(paid));
        assertThat(jdbc.queryForObject("select coalesce(sum(amount_rwf),0) from payment_allocations where invoice_id = ?", Long.class, paid)).isEqualTo(5_000);

        UUID voided = w.issuedInvoice(5_000);
        long version = w.owner.get(m("/invoices/" + voided)).json().path("version").asLong();
        assertThat(w.owner.post(m("/invoices/" + voided + "/void?expectedVersion=" + version), Map.of("reason", "Wrong customer")).status()).isEqualTo(200);
        var result = bank.pay("POSTED", 5_000, number(voided));
        assertThat(result.outcome()).isEqualTo("APPLIED");
        assertThat(jdbc.queryForObject("select count(*) from payment_allocations where invoice_id = ?", Integer.class, voided)).isZero();
        assertThat(jdbc.queryForObject("select review_state from bank_transactions where provider_transaction_id = ?", String.class, result.transactionId())).isEqualTo("NEEDS_REVIEW");
    }

    @Test
    void anInvoiceWithPaymentActivityCannotBeVoided() {
        UUID invoice = w.issuedInvoice(10_000);
        bank.pay("POSTED", 4_000, number(invoice));
        long version = w.owner.get(m("/invoices/" + invoice)).json().path("version").asLong();
        var attempt = w.owner.post(m("/invoices/" + invoice + "/void?expectedVersion=" + version), Map.of("reason", "Changed my mind"));
        assertThat(attempt.status()).isEqualTo(409);
        assertThat(attempt.code()).isEqualTo("void_not_allowed");
    }

    // ---- manual reconciliation -----------------------------------------------------------------

    private Map<String, Object> allocate(String txId, long version, Object... lines) {
        return Map.of("bankTransactionId", txId, "expectedTransactionVersion", version, "allocations", List.of(lines), "note", "Checked with customer");
    }

    private Map<String, Object> line(UUID invoice, long amount, long expectedRemaining) {
        return Map.of("invoiceId", invoice.toString(), "amount", amount, "expectedRemainingBalance", expectedRemaining);
    }

    private long version(String txId) {
        return w.owner.get(m("/bank-transactions/" + txId)).json().path("transaction").path("version").asLong();
    }

    @Test
    void anAuthorisedPersonSplitsUnmatchedMoneyAcrossInvoices() {
        UUID a = w.issuedInvoice(30_000);
        UUID b = w.issuedInvoice(20_000);
        String tx = txId(bank.pay("POSTED", 50_000, null));
        var response = w.manager.post(m("/reconciliation/allocations"), allocate(tx, version(tx), line(a, 30_000, 30_000), line(b, 20_000, 20_000)));
        assertThat(response.status()).isEqualTo(200);
        assertThat(paymentStatus(a)).isEqualTo("PAID");
        assertThat(paymentStatus(b)).isEqualTo("PAID");
        var details = response.json();
        assertThat(details.path("transaction").path("reconciliationStatus").asString()).isEqualTo("FULLY_ALLOCATED");
        assertThat(details.path("transaction").path("unappliedAmount").asLong()).isZero();
        assertThat(details.path("auditHistory").size()).isGreaterThanOrEqualTo(3);
    }

    @Test
    void aFailingLineLeavesNothingHalfApplied() {
        UUID a = w.issuedInvoice(30_000);
        UUID b = w.issuedInvoice(1_000);
        String tx = txId(bank.pay("POSTED", 40_000, null));
        var response = w.owner.post(m("/reconciliation/allocations"), allocate(tx, version(tx), line(a, 30_000, 30_000), line(b, 5_000, 1_000)));
        assertThat(response.status()).isEqualTo(409);
        assertThat(response.code()).isEqualTo("exceeds_remaining");
        assertThat(jdbc.queryForObject("select count(*) from payment_allocations", Integer.class)).isZero();
        assertThat(paymentStatus(a)).isEqualTo("UNPAID");
    }

    @Test
    void manualAllocationCannotExceedUnappliedOrBalanceOrUseUnconfirmedMoney() {
        UUID a = w.issuedInvoice(100_000);
        String confirmed = txId(bank.pay("POSTED", 40_000, null));
        var tooMuch = w.owner.post(m("/reconciliation/allocations"), allocate(confirmed, version(confirmed), line(a, 40_001, 100_000)));
        assertThat(tooMuch.code()).isEqualTo("exceeds_unapplied");
        String pending = txId(bank.pay("PENDING", 40_000, null));
        var unconfirmed = w.owner.post(m("/reconciliation/allocations"), allocate(pending, version(pending), line(a, 10_000, 100_000)));
        assertThat(unconfirmed.code()).isEqualTo("exceeds_unapplied");
        assertThat(jdbc.queryForObject("select count(*) from payment_allocations", Integer.class)).isZero();
    }

    @Test
    void staleVersionsAndStaleBalancesAreConflicts() {
        UUID a = w.issuedInvoice(30_000);
        String tx = txId(bank.pay("POSTED", 30_000, null));
        long v = version(tx);
        assertThat(w.owner.post(m("/reconciliation/allocations"), allocate(tx, v, line(a, 10_000, 30_000))).status()).isEqualTo(200);
        // A second person still holds the old version and balance.
        var staleVersion = w.manager.post(m("/reconciliation/allocations"), allocate(tx, v, line(a, 20_000, 20_000)));
        assertThat(staleVersion.status()).isEqualTo(409);
        assertThat(staleVersion.code()).isEqualTo("allocation_conflict");
        var staleBalance = w.manager.post(m("/reconciliation/allocations"), allocate(tx, version(tx), line(a, 20_000, 30_000)));
        assertThat(staleBalance.code()).isEqualTo("allocation_conflict");
    }

    @Test
    void reversingAnAllocationRestoresTheBalanceAndKeepsHistory() {
        UUID a = w.issuedInvoice(10_000);
        String tx = txId(bank.pay("POSTED", 10_000, number(a)));
        String allocation = jdbc.queryForObject("select id from payment_allocations", String.class);
        assertThat(w.cashier.post(m("/reconciliation/allocations/" + allocation + "/reverse"), Map.of("reason", "Wrong invoice")).status()).isEqualTo(403);
        assertThat(w.owner.post(m("/reconciliation/allocations/" + allocation + "/reverse"), Map.of("reason", "x")).status()).isEqualTo(422);
        var reversed = w.manager.post(m("/reconciliation/allocations/" + allocation + "/reverse"), Map.of("reason", "Paid the wrong invoice"));
        assertThat(reversed.status()).isEqualTo(200);
        assertThat(remaining(a)).isEqualTo(10_000);
        assertThat(reversed.json().path("transaction").path("unappliedAmount").asLong()).isEqualTo(10_000);
        assertThat(w.owner.post(m("/reconciliation/allocations/" + allocation + "/reverse"), Map.of("reason", "Again please")).code()).isEqualTo("allocation_not_active");
        assertThat(jdbc.queryForObject("select count(*) from payment_allocations", Integer.class)).isEqualTo(1);
        assertThat(tx).isNotNull();
    }

    @Test
    void reviewingRecordsANoteWithoutMovingMoney() {
        bank.pay("POSTED", 4_000, null);
        String tx = jdbc.queryForObject("select id from bank_transactions", String.class);
        var reviewed = w.manager.post(m("/bank-transactions/" + tx + "/review"), Map.of("note", "A donation, confirmed with the customer", "expectedTransactionVersion", version(tx)));
        assertThat(reviewed.status()).isEqualTo(200);
        assertThat(reviewed.json().path("transaction").path("reviewState").asString()).isEqualTo("REVIEWED");
        assertThat(reviewed.json().path("transaction").path("unappliedAmount").asLong()).isEqualTo(4_000);
    }

    // ---- who may see and do what ---------------------------------------------------------------

    @Test
    void cashiersSeeOnlyMoneyAppliedToTheirInvoicesAndCannotReconcile() {
        UUID mine = w.issuedInvoice(5_000); // assigned to cashier
        var other = w.owner.post(m("/invoices"), w.draft(w.otherCashierPerson.userId(), 6_000));
        UUID theirs = UUID.fromString(other.json().path("id").asString());
        w.owner.post(m("/invoices/" + theirs + "/issue?expectedVersion=" + other.json().path("version").asLong()), null);
        bank.pay("POSTED", 5_000, number(mine));
        bank.pay("POSTED", 6_000, number(theirs));
        var unmatched = bank.pay("POSTED", 3_333, null);

        var visible = w.cashier.get(m("/bank-transactions")).json();
        assertThat(visible.size()).isEqualTo(1);
        assertThat(visible.get(0).path("paymentReference").asString()).isEqualTo(number(mine));
        assertThat(visible.get(0).path("unappliedAmount").asLong()).isZero();
        assertThat(w.cashier.get(m("/bank-transactions/" + txId(unmatched))).status()).isEqualTo(404);
        assertThat(w.cashier.get(m("/payment-allocations")).json().size()).isEqualTo(1);
        assertThat(w.cashier.get(m("/payable-invoices")).status()).isEqualTo(403);
        assertThat(w.cashier.post(m("/reconciliation/allocations"), allocate(txId(unmatched), 0, line(mine, 1, 1))).status()).isEqualTo(403);
        assertThat(w.owner.get(m("/bank-transactions")).json().size()).isEqualTo(3);
    }

    @Test
    void anotherBusinessSeesNoneOfThisLedger() {
        UUID a = w.issuedInvoice(5_000);
        String tx = txId(bank.pay("POSTED", 5_000, number(a)));
        String cafe = "/api/v1/merchants/" + w.cafeMerchantId;
        assertThat(w.cafeOwner.get(cafe + "/bank-transactions").json().size()).isZero();
        assertThat(w.cafeOwner.get(cafe + "/bank-transactions/" + tx).status()).isEqualTo(404);
        assertThat(w.cafeOwner.get(m("/bank-transactions")).status()).isEqualTo(404);
        assertThat(w.cafeOwner.post(cafe + "/reconciliation/allocations", allocate(tx, 0, line(a, 1, 5_000))).status()).isIn(404, 409);
    }

    @Test
    void thereIsNoMerchantApiThatCreatesOrConfirmsATransaction() {
        UUID a = w.issuedInvoice(5_000);
        for (var api : List.of(w.owner, w.manager, w.cashier)) {
            for (String path : List.of("/bank-transactions", "/bank-transactions/confirm", "/payments/confirm", "/invoices/" + a + "/pay", "/invoices/" + a + "/mark-paid")) {
                var response = api.post(m(path), Map.of("amount", 5_000, "status", "CONFIRMED", "reference", number(a)));
                assertThat(response.status()).isIn(403, 404, 405);
            }
        }
        assertThat(jdbc.queryForObject("select count(*) from bank_transactions", Integer.class)).isZero();
        assertThat(paymentStatus(a)).isEqualTo("UNPAID");
    }

    // ---- notifications -------------------------------------------------------------------------

    private List<String> recipientsOf(String kind) {
        return jdbc.queryForList("select u.email from notifications n join users u on u.id = n.recipient_user_id where n.kind = ? order by u.email", String.class, kind);
    }

    @Test
    void partialPaymentNotifiesTheResponsibleCashierAndManagersExactlyOnce() {
        UUID invoice = w.issuedInvoice(10_000);
        bank.send("POSTED", 4_000, number(invoice), "tx-n", "evt-n", bank.at(1));
        var expected = List.of("aline@shop.rw", "manager@shop.rw", "owner@shop.rw");
        assertThat(recipientsOf("INVOICE_PARTIALLY_SETTLED")).isEqualTo(expected);
        bank.send("POSTED", 4_000, number(invoice), "tx-n", "evt-n", bank.at(1)); // replay
        assertThat(recipientsOf("INVOICE_PARTIALLY_SETTLED")).isEqualTo(expected);
        bank.pay("POSTED", 6_000, number(invoice));
        assertThat(recipientsOf("INVOICE_SETTLED")).isEqualTo(expected);
    }

    @Test
    void unmatchedAndReviewAlertsGoToManagersOnly() {
        bank.pay("POSTED", 1_500, null);
        bank.pay("POSTED", 1_600, "NOPE-1");
        assertThat(recipientsOf("PAYMENT_UNMATCHED")).containsOnly("manager@shop.rw", "owner@shop.rw");
        assertThat(recipientsOf("NEEDS_REVIEW")).containsOnly("manager@shop.rw", "owner@shop.rw");
        assertThat(jdbc.queryForObject("select count(*) from notifications n join users u on u.id = n.recipient_user_id where u.email like '%aline%' or u.email like '%eric%'", Integer.class)).isZero();
    }

    @Test
    void peopleReadAndMarkOnlyTheirOwnNotifications() {
        UUID invoice = w.issuedInvoice(10_000);
        bank.pay("POSTED", 4_000, number(invoice));
        String n = "/api/v1/merchants/" + w.merchantId + "/notifications";
        var mine = w.cashier.get(n).json();
        assertThat(mine.size()).isEqualTo(1);
        assertThat(mine.get(0).path("isSimulated").asBoolean()).isTrue();
        String ownersId = jdbc.queryForObject("select n.id from notifications n join users u on u.id = n.recipient_user_id where u.email = 'owner@shop.rw'", String.class);
        assertThat(w.cashier.post(n + "/" + ownersId + "/read", null).status()).isEqualTo(404);
        assertThat(w.cashier.post(n + "/" + mine.get(0).path("id").asString() + "/read", null).status()).isEqualTo(200);
        assertThat(w.cashier.get(n).json().get(0).path("readAt").isNull()).isFalse();
        assertThat(w.owner.get(n).json().get(0).path("readAt").isMissingNode() || w.owner.get(n).json().get(0).path("readAt").isNull()).isTrue();
        assertThat(w.otherCashier.get(n).json().size()).isZero();
        assertThat(w.cafeOwner.get(n).status()).isEqualTo(404);
        assertThat(w.cashier.post(n + "/read-all", null).status()).isEqualTo(204);
    }

    @Test
    void aSuspendedCashierIsNotNotifiedAboutTheirOldInvoices() {
        UUID invoice = w.issuedInvoice(5_000);
        assertThat(w.manager.post(m("/memberships/" + w.cashierMembershipId + "/suspend"), null).status()).isEqualTo(200);
        bank.pay("POSTED", 5_000, number(invoice));
        assertThat(recipientsOf("INVOICE_SETTLED")).containsOnly("manager@shop.rw", "owner@shop.rw");
    }

    // ---- dashboard ----------------------------------------------------------------------------

    @Test
    void theDashboardIsDerivedFromTheSameLedger() {
        UUID invoice = w.issuedInvoice(10_000);
        bank.pay("POSTED", 4_000, number(invoice));
        bank.pay("POSTED", 2_500, null);
        bank.pay("PENDING", 9_000, null);
        var summary = w.owner.get(m("/dashboard/summary")).json();
        assertThat(summary.path("verifiedIncomingTotal").asLong()).isEqualTo(6_500);
        assertThat(summary.path("allocatedTotal").asLong()).isEqualTo(4_000);
        assertThat(summary.path("unappliedConfirmedTotal").asLong()).isEqualTo(2_500);
        assertThat(summary.path("verifiedIncomingTotal").asLong())
                .isEqualTo(summary.path("allocatedTotal").asLong() + summary.path("unappliedConfirmedTotal").asLong());
        assertThat(summary.path("requiresReviewCount").asInt()).isEqualTo(1);
        var cashierView = w.cashier.get(m("/dashboard/summary")).json();
        assertThat(cashierView.path("verifiedIncomingTotal").asLong()).isEqualTo(4_000);
        assertThat(cashierView.path("unappliedConfirmedTotal").asLong()).isZero();
        assertThat(w.cafeOwner.get(m("/dashboard/summary")).status()).isEqualTo(404);
    }
}
