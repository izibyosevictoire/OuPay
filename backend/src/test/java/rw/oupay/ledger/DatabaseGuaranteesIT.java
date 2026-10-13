package rw.oupay.ledger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import rw.oupay.support.Bank;
import rw.oupay.support.IntegrationTest;
import rw.oupay.support.World;

/**
 * What PostgreSQL itself refuses, bypassing every line of application code. If a bug (or a person
 * with database access and a typo) tried to break the books, these statements are what would run.
 */
class DatabaseGuaranteesIT extends IntegrationTest {

    World w;
    UUID invoice;
    UUID confirmedTx;
    UUID pendingTx;
    UUID draftInvoice;

    @BeforeEach
    void world() {
        w = World.create(this);
        invoice = w.issuedInvoice(10_000);
        confirmedTx = tx(w.bank.pay("POSTED", 4_000, null));
        pendingTx = tx(w.bank.pay("PENDING", 4_000, null));
        draftInvoice = UUID.fromString(w.owner.post("/api/v1/merchants/" + w.merchantId + "/invoices", w.draft(w.cashierPerson.userId(), 5_000))
                .json().path("id").asString());
    }

    private UUID tx(Bank.Delivery delivery) {
        return jdbc.queryForObject("select id from bank_transactions where provider_transaction_id = ?", UUID.class, delivery.transactionId());
    }

    private void insertAllocation(UUID txId, UUID invoiceId, long amount) {
        jdbc.update("insert into payment_allocations (id, merchant_id, bank_transaction_id, invoice_id, amount_rwf, status, origin, created_by_user_id, created_at) "
                        + "values (?, ?, ?, ?, ?, 'ACTIVE', 'MANUAL', ?, now())",
                UUID.randomUUID(), w.merchantId, txId(txId), invoiceId, amount, w.ownerPerson.userId());
    }

    private UUID txId(UUID id) {
        return id;
    }

    // ---- allocations ---------------------------------------------------------------------------

    @Test
    void anAllocationCannotExceedWhatTheTransactionHolds() {
        assertThatThrownBy(() -> insertAllocation(confirmedTx, invoice, 4_001)).hasMessageContaining("exceeds the unapplied amount");
        insertAllocation(confirmedTx, invoice, 4_000);
        assertThatThrownBy(() -> insertAllocation(confirmedTx, invoice, 1)).hasMessageContaining("exceeds the unapplied amount");
    }

    @Test
    void anAllocationCannotExceedWhatTheInvoiceOwes() {
        UUID big = tx(w.bank.pay("POSTED", 50_000, null));
        assertThatThrownBy(() -> insertAllocation(big, invoice, 10_001)).hasMessageContaining("exceeds the remaining balance");
    }

    @Test
    void onlyConfirmedMoneyCanBeAllocatedToAnIssuedInvoice() {
        assertThatThrownBy(() -> insertAllocation(pendingTx, invoice, 100)).hasMessageContaining("only bank-confirmed");
        assertThatThrownBy(() -> insertAllocation(confirmedTx, draftInvoice, 100)).hasMessageContaining("only an issued invoice");
    }

    @Test
    void aNonPositiveAmountOrACrossBusinessAllocationIsRefused() {
        assertThatThrownBy(() -> insertAllocation(confirmedTx, invoice, 0)).hasMessageContaining("ck_payment_allocations_amount");
        // Money of the shop, invoice of the cafe: the composite foreign keys keep every business apart.
        Bank cafeBank = Bank.link(mvc, w.cafeOwner, w.cafeMerchantId);
        UUID cafeTx = tx(cafeBank.pay("POSTED", 1_000, null));
        assertThatThrownBy(() -> jdbc.update("insert into payment_allocations (id, merchant_id, bank_transaction_id, invoice_id, amount_rwf, status, origin, created_by_user_id, created_at) "
                        + "values (?, ?, ?, ?, 100, 'ACTIVE', 'MANUAL', ?, now())",
                UUID.randomUUID(), w.merchantId, cafeTx, invoice, w.ownerPerson.userId()))
                .hasMessageContaining("inside one merchant");
    }

    @Test
    void allocationsAreNeverEditedOrDeletedOnlyReversed() {
        insertAllocation(confirmedTx, invoice, 1_000);
        UUID id = jdbc.queryForObject("select id from payment_allocations", UUID.class);
        assertThatThrownBy(() -> jdbc.update("update payment_allocations set amount_rwf = 1 where id = ?", id)).hasMessageContaining("immutable");
        assertThatThrownBy(() -> jdbc.update("delete from payment_allocations where id = ?", id)).hasMessageContaining("never deleted");
        jdbc.update("update payment_allocations set status = 'REVERSED', reversed_at = now(), reversal_kind = 'MANUAL_CORRECTION', reversal_reason = 'test' where id = ?", id);
        assertThatThrownBy(() -> jdbc.update("update payment_allocations set reversal_reason = 'edit' where id = ?", id)).hasMessageContaining("final");
        // A reversal with no kind, or a reversal that pretends nothing happened, is invalid.
        insertAllocation(confirmedTx, invoice, 1_000);
        UUID again = jdbc.queryForObject("select id from payment_allocations where status = 'ACTIVE'", UUID.class);
        assertThatThrownBy(() -> jdbc.update("update payment_allocations set status = 'REVERSED' where id = ?", again)).hasMessageContaining("ck_payment_allocations_reversal");
    }

    // ---- bank transactions ---------------------------------------------------------------------

    @Test
    void aBankTransactionKeepsItsAmountAndFollowsOnlyLegalStatusTransitions() {
        assertThatThrownBy(() -> jdbc.update("update bank_transactions set amount_rwf = 1 where id = ?", confirmedTx)).hasMessageContaining("immutable");
        assertThatThrownBy(() -> jdbc.update("update bank_transactions set status = 'PENDING' where id = ?", confirmedTx)).hasMessageContaining("illegal bank transaction status");
        assertThatThrownBy(() -> jdbc.update("update bank_transactions set status = 'FAILED' where id = ?", confirmedTx)).hasMessageContaining("illegal bank transaction status");
        jdbc.update("update bank_transactions set status = 'FAILED' where id = ?", pendingTx);
        assertThatThrownBy(() -> jdbc.update("update bank_transactions set status = 'CONFIRMED' where id = ?", pendingTx)).hasMessageContaining("illegal bank transaction status");
        assertThatThrownBy(() -> jdbc.update("delete from bank_transactions where id = ?", confirmedTx)).hasMessageContaining("never deleted");
    }

    @Test
    void statusCannotMoveBackwardsInProviderTime() {
        UUID later = tx(w.bank.send("PENDING", 500, null, "tx-time", "evt-time", w.bank.at(100)));
        assertThatThrownBy(() -> jdbc.update("update bank_transactions set status = 'CONFIRMED', status_applied_at = status_applied_at - interval '1 hour' where id = ?", later))
                .hasMessageContaining("backwards in provider time");
    }

    @Test
    void moneyCannotBeReversedWhileItStillCountsOnAnInvoice() {
        insertAllocation(confirmedTx, invoice, 2_000);
        // The commit-time invariant refuses a REVERSED transaction that still carries active allocations.
        assertThatThrownBy(() -> jdbc.update("update bank_transactions set status = 'REVERSED' where id = ?", confirmedTx))
                .hasMessageContaining("cannot carry active allocations");
        assertThat(jdbc.queryForObject("select status from bank_transactions where id = ?", String.class, confirmedTx)).isEqualTo("CONFIRMED");
    }

    @Test
    void oneTransactionPerProviderTransactionAndOneRowPerProviderEvent() {
        assertThatThrownBy(() -> jdbc.update("insert into bank_transactions (id, merchant_id, bank_connection_id, provider_id, provider_transaction_id, last_provider_event_id, "
                        + "direction, amount_rwf, payer_display_name, provider_occurred_at, status_applied_at, received_at, status, is_simulated, created_at, updated_at) "
                        + "select gen_random_uuid(), merchant_id, bank_connection_id, provider_id, provider_transaction_id, 'x', direction, amount_rwf, payer_display_name, "
                        + "provider_occurred_at, status_applied_at, received_at, status, is_simulated, created_at, updated_at from bank_transactions where id = ?", confirmedTx))
                .hasMessageContaining("ux_bank_transactions_provider_tx");
        assertThatThrownBy(() -> jdbc.update("insert into bank_events (id, provider_id, provider_event_id, provider_transaction_id, outcome, raw_payload, received_at) "
                        + "select gen_random_uuid(), provider_id, provider_event_id, provider_transaction_id, 'RECEIVED', 'x', now() from bank_events limit 1"))
                .hasMessageContaining("ux_bank_events_provider_event");
    }

    // ---- immutable logs ------------------------------------------------------------------------

    @Test
    void rawBankEventsAndTheAuditLogAreImmutable() {
        assertThatThrownBy(() -> jdbc.update("update bank_events set raw_payload = 'tampered'")).hasMessageContaining("immutable");
        assertThatThrownBy(() -> jdbc.update("update bank_events set outcome = 'REJECTED'")).hasMessageContaining("immutable");
        assertThatThrownBy(() -> jdbc.update("delete from bank_events")).hasMessageContaining("never deleted");
        assertThat(jdbc.queryForObject("select count(*) from audit_log", Integer.class)).isPositive();
        assertThatThrownBy(() -> jdbc.update("update audit_log set message = 'edited'")).hasMessageContaining("append-only");
        assertThatThrownBy(() -> jdbc.update("delete from audit_log")).hasMessageContaining("append-only");
    }

    // ---- business isolation and uniqueness -----------------------------------------------------

    @Test
    void recordsCannotPointAcrossBusinesses() {
        // An invoice for the shop referencing the cafe's branch.
        assertThatThrownBy(() -> jdbc.update("update invoices set branch_id = ? where id = ?", w.cafeBranchId, draftInvoice))
                .hasMessageContaining("fk_invoices_branch");
        // A branch assignment joining the shop's membership to the cafe's branch.
        assertThatThrownBy(() -> jdbc.update("insert into branch_assignments (id, merchant_id, membership_id, branch_id, status, created_at, updated_at) values (?, ?, ?, ?, 'ACTIVE', now(), now())",
                UUID.randomUUID(), w.merchantId, w.cashierMembershipId, w.cafeBranchId)).hasMessageContaining("fk_branch_assignments_branch");
    }

    @Test
    void invoiceNumbersTinsAndEmailsAreUnique() {
        assertThatThrownBy(() -> jdbc.update("update invoices set invoice_number = (select invoice_number from invoices where id = ?) where id = ?", invoice, draftInvoice))
                .hasMessageContaining("immutable");
        assertThatThrownBy(() -> jdbc.update("insert into users (id, email, full_name, status, password_hash, created_at, updated_at) values (?, 'OWNER@shop.rw', 'Dup', 'ACTIVE', 'x', now(), now())", UUID.randomUUID()))
                .hasMessageContaining("ux_users_email_lower");
        assertThatThrownBy(() -> jdbc.update("update merchants set tin = '987654321' where id = ?", w.merchantId)).hasMessageContaining("ux_merchants_tin");
    }

    @Test
    void aProviderAccountCanBeLiveForOnlyOneBusiness() {
        Bank.link(mvc, w.cafeOwner, w.cafeMerchantId);
        String account = jdbc.queryForObject("select provider_account_id from bank_connections where merchant_id = ?", String.class, w.merchantId);
        assertThatThrownBy(() -> jdbc.update("update bank_connections set provider_account_id = ? where merchant_id = ?", account, w.cafeMerchantId))
                .hasMessageContaining("ux_bank_connections_live_account");
    }

    @Test
    void notificationsCannotBeDuplicatedForOnePersonAndEvent() {
        w.bank.pay("POSTED", 1_000, null);
        assertThat(jdbc.queryForObject("select count(*) from notifications", Integer.class)).isPositive();
        assertThatThrownBy(() -> jdbc.update("insert into notifications (id, merchant_id, recipient_user_id, kind, title, body, dedupe_key, created_at) "
                        + "select gen_random_uuid(), merchant_id, recipient_user_id, kind, title, body, dedupe_key, now() from notifications limit 1"))
                .hasMessageContaining("ux_notifications_dedupe");
    }
}
