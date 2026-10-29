package rw.oupay.checkout;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.sql.Connection;
import java.sql.SQLException;
import java.time.Clock;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import javax.sql.DataSource;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.TestPropertySource;
import org.springframework.transaction.support.TransactionTemplate;
import rw.oupay.audit.AuditService;
import rw.oupay.pos.PosFulfilmentService;
import rw.oupay.reservation.StockReservationService;
import rw.oupay.support.Bank;
import tools.jackson.databind.JsonNode;

/**
 * R7c review: fulfilment against bank reversals and crashes, with DETERMINISTIC coordination. A test-held PostgreSQL advisory lock holds one side
 * inside its own transaction (through a trigger that waits for the lock) until the other side is provably queued behind it, then lets both go.
 * No sleeps decide the order: the order is observed from {@code pg_stat_activity} before anything is released.
 */
@TestPropertySource(properties = {
        "oupay.collection-codes.approval-enabled=true",
        "oupay.code-checkout.live-enabled=true",
        "oupay.code-checkout.instructions=Open the bank app|Pay to the merchant code shown",
        "oupay.pos.approved-tax-treatments=EXEMPT:0,ZERO_RATED:0,STANDARD:1800,NOT_APPLICABLE:0",
        "oupay.pos.reservation-review-grace=PT0S",
        "oupay.pos.fulfilment.max-attempts=3"})
class PosFulfilmentRaceIT extends PosBillingTestSupport {

    private static final long GATE = 424_242L;

    @Autowired
    PosFulfilmentService fulfilments;
    @Autowired
    DataSource dataSource;
    @Autowired
    JdbcClient jdbcClient;
    @Autowired
    TransactionTemplate transactionTemplate;
    @Autowired
    StockReservationService stockReservations;
    @Autowired
    AuditService auditService;
    @Autowired
    Clock clock;

    private Connection gate;
    private final List<String> gatedTables = new ArrayList<>();

    @AfterEach
    void releaseEverything() throws SQLException {
        for (String table : gatedTables) {
            jdbc.execute("drop trigger if exists trg_pos_test_gate on " + table);
        }
        jdbc.execute("drop function if exists pos_test_gate()");
        if (gate != null && !gate.isClosed()) {
            gate.createStatement().execute("select pg_advisory_unlock_all()");
            gate.close();
        }
    }

    // ---- the gate -------------------------------------------------------------------------------------------------------------

    /** Makes every matching row operation wait for the test-held advisory lock, INSIDE its own transaction. */
    private void installGate(String table, String timing) throws SQLException {
        jdbc.execute("create or replace function pos_test_gate() returns trigger as $$ begin perform pg_advisory_lock(" + GATE + "); perform pg_advisory_unlock("
                + GATE + "); return new; end; $$ language plpgsql");
        jdbc.execute("create trigger trg_pos_test_gate " + timing + " on " + table + " for each row execute function pos_test_gate()");
        gatedTables.add(table);
        gate = dataSource.getConnection();
        gate.createStatement().execute("select pg_advisory_lock(" + GATE + ")");
    }

    private void openGate() throws SQLException {
        gate.createStatement().execute("select pg_advisory_unlock(" + GATE + ")");
    }

    /** Waits until at least n sessions are blocked on a lock: the order of the race is then fixed, not hoped for. */
    private void awaitBlocked(int n) throws InterruptedException {
        long deadline = System.currentTimeMillis() + 8_000;
        while (System.currentTimeMillis() < deadline) {
            Integer blocked = jdbc.queryForObject("select count(*) from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'", Integer.class);
            if (blocked != null && blocked >= n) {
                return;
            }
            Thread.sleep(20);
        }
        throw new AssertionError("expected " + n + " sessions blocked on a lock");
    }

    private <T> Future<T> async(ExecutorService pool, Callable<T> task) {
        return pool.submit(task);
    }

    // ---- helpers ----------------------------------------------------------------------------------------------------------------

    private JsonNode billedMixed() {
        live();
        return billed(saveDraft(line(rice, "2", "kg"), line(soda, "3", "pc"), line(repair, "1", "pc")));
    }

    private Bank.Delivery pay(JsonNode sale) {
        return w.bank.payWithCode("POSTED", sale.path("totalRwf").asLong(), reference(sale), "EQ-LIVE-77");
    }

    private List<Map<String, Object>> saleMovements() {
        return jdbc.queryForList("select * from stock_movements where movement_type = 'SALE'");
    }

    private String paymentStatusOf(JsonNode sale) {
        return w.owner.get("/api/v1/merchants/" + w.merchantId + "/invoices/" + sale.path("sale").path("invoiceId").asString()).json().path("paymentStatus").asString();
    }

    private void dueNow() {
        jdbc.update("update pos_fulfilments set next_attempt_at = now() - interval '1 minute' where status = 'PENDING'");
    }

    private PosFulfilmentService anotherInstance() {
        return new PosFulfilmentService(jdbcClient, transactionTemplate, stockReservations, auditService, clock, 3, java.time.Duration.ofMinutes(1));
    }

    // ---- reversal versus fulfilment ----------------------------------------------------------------------------------------------

    @Test
    void aReversalThatCommitsFirstLeavesNoSaleMovementAndNothingElseChanges() throws Exception {
        JsonNode sale = billedMixed();
        Bank.Delivery delivery = pay(sale);
        installGate("payment_allocations", "after update");
        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            // The bank reversal is inside its transaction: it has reversed the allocation and has not committed.
            Future<Bank.Delivery> reversal = async(pool, () -> w.bank.updateWithCode(delivery.transactionId(), "REVERSED", sale.path("totalRwf").asLong(), reference(sale), "EQ-LIVE-77"));
            awaitBlocked(1);
            // The worker comes now: it must wait for the reversal (the allocation row), not read the old, still-active allocation.
            Future<PosFulfilmentService.Summary> worker = async(pool, () -> fulfilments.processDue(50));
            awaitBlocked(2);
            openGate();
            assertThat(reversal.get(20, TimeUnit.SECONDS).outcome()).isEqualTo("APPLIED");
            PosFulfilmentService.Summary summary = worker.get(20, TimeUnit.SECONDS);
            assertThat(summary.posted()).isZero();
            assertThat(summary.failed()).isZero();
        } finally {
            pool.shutdownNow();
        }
        assertThat(saleMovements()).isEmpty();
        assertThat(count("pos_fulfilment_lines")).isZero();
        assertThat(count("pos_fulfilments")).isZero();
        assertThat(count("pos_fulfilment_exceptions")).isZero();
        assertThat(jdbc.queryForObject("select status from stock_reservations", String.class)).isEqualTo("ACTIVE");
        assertThat(onHand(rice)).isEqualByComparingTo("10000");
        assertThat(onHand(soda)).isEqualByComparingTo("100");
        assertThat(reserved(rice)).isEqualByComparingTo("2000");
        assertThat(count("payment_allocations")).isEqualTo(1);
        assertThat(jdbc.queryForObject("select status from payment_allocations", String.class)).isEqualTo("REVERSED");
        assertThat(paymentStatusOf(sale)).isEqualTo("UNPAID");
        // Run again: still nothing, and the sale says what is true (reversed, not posted, handover not tracked).
        assertThat(fulfilments.processDue(50).posted()).isZero();
        JsonNode f = w.cashier.get(pos() + "/sales/" + sale.path("sale").path("saleId").asString()).json().path("fulfilment");
        assertThat(f.path("paymentState").asString()).isEqualTo("REVERSED");
        assertThat(f.path("inventoryState").asString()).isEqualTo("NOT_POSTED");
        assertThat(f.path("handover").asString()).isEqualTo("NOT_TRACKED");
    }

    @Test
    void aFulfilmentThatCommitsFirstPostsOnceAndTheReversalIsThenRecordedAsOneException() throws Exception {
        JsonNode sale = billedMixed();
        Bank.Delivery delivery = pay(sale);
        installGate("stock_movements", "before insert");
        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            // The worker is inside its posting transaction (invoice and allocations locked), waiting at its first movement.
            Future<PosFulfilmentService.Summary> worker = async(pool, () -> fulfilments.processDue(50));
            awaitBlocked(1);
            // The bank reversal arrives now: it can not update the allocation until the posting has finished.
            Future<Bank.Delivery> reversal = async(pool, () -> w.bank.updateWithCode(delivery.transactionId(), "REVERSED", sale.path("totalRwf").asLong(), reference(sale), "EQ-LIVE-77"));
            awaitBlocked(2);
            openGate();
            PosFulfilmentService.Summary summary = worker.get(20, TimeUnit.SECONDS);
            assertThat(summary.posted()).isEqualTo(1);
            assertThat(summary.failed()).isZero();
            assertThat(reversal.get(20, TimeUnit.SECONDS).outcome()).isEqualTo("APPLIED");
        } finally {
            pool.shutdownNow();
        }
        // Exactly one complete set of movements: no half-deducted stock, no duplicate.
        assertThat(saleMovements()).hasSize(2);
        assertThat(count("pos_fulfilment_lines")).isEqualTo(2);
        assertThat(onHand(rice)).isEqualByComparingTo("8000");
        assertThat(onHand(soda)).isEqualByComparingTo("97");
        assertThat(jdbc.queryForObject("select status from stock_reservations", String.class)).isEqualTo("FULFILLED");
        assertThat(count("payment_allocations")).isEqualTo(1);
        assertThat(jdbc.queryForObject("select status from payment_allocations", String.class)).isEqualTo("REVERSED");
        assertThat(paymentStatusOf(sale)).isEqualTo("UNPAID");
        // The reversal is recorded once, by the next worker run, and the deduction is never undone by itself.
        assertThat(count("pos_fulfilment_exceptions")).isZero();
        assertThat(fulfilments.processDue(50).reversals()).isEqualTo(1);
        assertThat(fulfilments.processDue(50).reversals()).isZero();
        assertThat(jdbc.queryForObject("select kind from pos_fulfilment_exceptions", String.class)).isEqualTo("PAYMENT_REVERSED_AFTER_POSTING");
        assertThat(saleMovements()).hasSize(2);
        assertThat(onHand(rice)).isEqualByComparingTo("8000");
        assertThat(jdbc.queryForObject("select status from pos_fulfilments", String.class)).isEqualTo("POSTED");
        // The sale never claims the goods were handed over: the stock ledger was updated, the payment is reversed.
        JsonNode f = w.cashier.get(pos() + "/sales/" + sale.path("sale").path("saleId").asString()).json().path("fulfilment");
        assertThat(f.path("paymentState").asString()).isEqualTo("REVERSED");
        assertThat(f.path("inventoryState").asString()).isEqualTo("POSTED");
        assertThat(f.path("handover").asString()).isEqualTo("NOT_TRACKED");
        assertThat(f.path("note").asString()).contains("not recorded");
    }

    // ---- crashes and restarts ---------------------------------------------------------------------------------------------------

    @Test
    void aWorkerKilledBeforeItsCommitDeductsNothingAndTheSaleIsStillDiscoverable() throws Exception {
        JsonNode sale = billedMixed();
        pay(sale);
        installGate("stock_movements", "before insert");
        ExecutorService pool = Executors.newFixedThreadPool(1);
        try {
            Future<PosFulfilmentService.Summary> worker = async(pool, () -> fulfilments.processDue(50));
            awaitBlocked(1);
            // Its transaction has already changed the reservation and holds every lock. Kill the database session: a crash before the commit.
            Integer pid = jdbc.queryForObject("select pid from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' limit 1", Integer.class);
            jdbc.queryForObject("select pg_terminate_backend(?)", Boolean.class, pid);
            PosFulfilmentService.Summary summary = worker.get(20, TimeUnit.SECONDS);
            assertThat(summary.posted()).isZero();
        } finally {
            pool.shutdownNow();
        }
        openGate();
        jdbc.execute("drop trigger if exists trg_pos_test_gate on stock_movements");
        // Nothing was deducted and nothing is half-changed.
        assertThat(saleMovements()).isEmpty();
        assertThat(count("pos_fulfilment_lines")).isZero();
        assertThat(jdbc.queryForObject("select status from stock_reservations", String.class)).isEqualTo("ACTIVE");
        assertThat(onHand(rice)).isEqualByComparingTo("10000");
        assertThat(reserved(rice)).isEqualByComparingTo("2000");
        // The sale is still found, whether or not the failure was recorded: eligibility is derived from the allocations, not from a queue.
        jdbc.update("update pos_fulfilments set next_attempt_at = now() - interval '1 minute' where status = 'PENDING'");
        assertThat(fulfilments.processDue(50).posted()).isEqualTo(1);
        assertThat(saleMovements()).hasSize(2);
        assertThat(onHand(rice)).isEqualByComparingTo("8000");
    }

    @Test
    void aRestartedWorkerFindsPendingWorkAndACrashAfterCommitCanNeverDeductTwice() {
        JsonNode sale = billedMixed();
        pay(sale);
        jdbc.execute("create or replace function pos_test_fail() returns trigger as $$ begin raise exception 'injected failure'; end; $$ language plpgsql");
        jdbc.execute("create trigger trg_pos_test_fail before insert on pos_fulfilment_lines for each row execute function pos_test_fail()");
        try {
            assertThat(fulfilments.processDue(50).failed()).isEqualTo(1);
        } finally {
            jdbc.execute("drop trigger trg_pos_test_fail on pos_fulfilment_lines");
            jdbc.execute("drop function pos_test_fail()");
        }
        // The retry state is in the database: a brand new service instance (a restarted application) sees it, and honours its back-off.
        PosFulfilmentService restarted = anotherInstance();
        assertThat(jdbc.queryForObject("select attempts from pos_fulfilments", Integer.class)).isEqualTo(1);
        assertThat(restarted.processDue(50).posted()).isZero();
        dueNow();
        assertThat(restarted.processDue(50).posted()).isEqualTo(1);
        assertThat(saleMovements()).hasSize(2);
        // The first instance "crashed after the commit" and starts again: it finds the posted sale and does nothing.
        assertThat(fulfilments.processDue(50).posted()).isZero();
        assertThat(anotherInstance().processDue(50).posted()).isZero();
        assertThat(saleMovements()).hasSize(2);
        assertThat(onHand(rice)).isEqualByComparingTo("8000");
        assertThat(onHand(soda)).isEqualByComparingTo("97");
    }

    @Test
    void severalWorkerInstancesClaimEachSaleOnceWithoutDuplicatingAPost() throws Exception {
        live();
        List<JsonNode> sales = new ArrayList<>();
        for (int i = 0; i < 4; i++) {
            sales.add(billed(saveDraft(line(rice, "1", "kg"), line(soda, "2", "pc"))));
        }
        for (JsonNode sale : sales) {
            pay(sale);
        }
        List<PosFulfilmentService> workers = List.of(fulfilments, anotherInstance(), anotherInstance(), anotherInstance());
        ExecutorService pool = Executors.newFixedThreadPool(workers.size());
        try {
            List<Future<PosFulfilmentService.Summary>> futures = new ArrayList<>();
            for (PosFulfilmentService worker : workers) {
                futures.add(async(pool, () -> worker.processDue(50)));
            }
            int posted = 0;
            for (Future<PosFulfilmentService.Summary> future : futures) {
                PosFulfilmentService.Summary summary = future.get(30, TimeUnit.SECONDS);
                assertThat(summary.failed()).isZero();
                posted += summary.posted();
            }
            assertThat(posted).isEqualTo(4);
        } finally {
            pool.shutdownNow();
        }
        assertThat(count("pos_fulfilments")).isEqualTo(4);
        assertThat(saleMovements()).hasSize(8);
        assertThat(onHand(rice)).isEqualByComparingTo("6000");
        assertThat(onHand(soda)).isEqualByComparingTo("92");
        assertThat(jdbc.queryForObject("select count(distinct operation_id) from stock_movements where movement_type = 'SALE'", Integer.class)).isEqualTo(8);
    }

    // ---- services only, exceptions and database invariants ---------------------------------------------------------------------

    @Test
    void aPaidServicesOnlySaleNeedsNoStockAndLeavesNoFailedWorkBehind() {
        live();
        JsonNode sale = billed(saveDraft(line(repair, "2", "pc")));
        pay(sale);
        for (int i = 0; i < 3; i++) {
            PosFulfilmentService.Summary summary = fulfilments.processDue(50);
            assertThat(summary.posted() + summary.exceptions() + summary.failed() + summary.reversals()).isZero();
        }
        assertThat(count("pos_fulfilments")).isZero();
        assertThat(count("pos_fulfilment_events")).isZero();
        assertThat(count("pos_fulfilment_exceptions")).isZero();
        assertThat(saleMovements()).isEmpty();
        JsonNode f = w.cashier.get(pos() + "/sales/" + sale.path("sale").path("saleId").asString()).json().path("fulfilment");
        assertThat(f.path("paymentState").asString()).isEqualTo("PAID");
        assertThat(f.path("inventoryState").asString()).isEqualTo("NOT_REQUIRED");
        assertThat(f.path("handover").asString()).isEqualTo("NOT_TRACKED");
    }

    @Test
    void anExceptionIsNeverResolvedByTheSystemOrWithoutAPersonAndNoEndpointResolvesOne() {
        JsonNode sale = billedMixed();
        pay(sale);
        jdbc.execute("create or replace function pos_test_fail() returns trigger as $$ begin raise exception 'injected failure'; end; $$ language plpgsql");
        jdbc.execute("create trigger trg_pos_test_fail before insert on pos_fulfilment_lines for each row execute function pos_test_fail()");
        try {
            for (int i = 0; i < 3; i++) {
                fulfilments.processDue(50);
                dueNow();
            }
        } finally {
            jdbc.execute("drop trigger trg_pos_test_fail on pos_fulfilment_lines");
            jdbc.execute("drop function pos_test_fail()");
        }
        assertThat(jdbc.queryForObject("select status from pos_fulfilment_exceptions", String.class)).isEqualTo("OPEN");
        // Running the worker again never resolves, re-opens or retries it.
        for (int i = 0; i < 3; i++) {
            fulfilments.processDue(50);
        }
        assertThat(count("pos_fulfilment_exceptions")).isEqualTo(1);
        assertThat(jdbc.queryForObject("select status from pos_fulfilment_exceptions", String.class)).isEqualTo("OPEN");
        assertThat(jdbc.queryForObject("select attempts from pos_fulfilments", Integer.class)).isEqualTo(3);
        // The database refuses to mark it resolved without a person and a written resolution, and a fulfilment in exception is not retried by hand.
        assertThatThrownBy(() -> jdbc.update("update pos_fulfilment_exceptions set status = 'RESOLVED', resolved_at = now()")).isNotNull();
        assertThatThrownBy(() -> jdbc.update("update pos_fulfilment_exceptions set status = 'RESOLVED', resolved_at = now(), resolved_by_user_id = ?, resolution_note = 'short'",
                w.ownerPerson.userId())).isNotNull();
        assertThatThrownBy(() -> jdbc.update("update pos_fulfilments set status = 'PENDING'")).hasMessageContaining("resolved by a person");
        // There is no route that resolves one (the list is the only exceptions route, and it is read-only).
        String id = w.owner.get(pos() + "/fulfilment/exceptions").json().get(0).path("id").asString();
        assertThat(w.owner.put(pos() + "/fulfilment/exceptions/" + id, Map.of("status", "RESOLVED")).status()).isIn(404, 405);
        assertThat(w.owner.post(pos() + "/fulfilment/exceptions/" + id + "/resolve", Map.of("note", "Resolved by hand, trust me")).status()).isIn(404, 405);
        assertThat(w.owner.delete(pos() + "/fulfilment/exceptions/" + id).status()).isIn(404, 405);
        // Another business never sees it.
        assertThat(w.cafeOwner.get("/api/v1/merchants/" + w.cafeMerchantId + "/pos/fulfilment/exceptions").json().size()).isZero();
    }

    @Test
    void theDatabaseRefusesAPostedFulfilmentWithoutAPostingForEveryLineAndForeignAssociations() {
        JsonNode sale = billedMixed();
        pay(sale);
        jdbc.execute("create or replace function pos_test_fail() returns trigger as $$ begin raise exception 'injected failure'; end; $$ language plpgsql");
        jdbc.execute("create trigger trg_pos_test_fail before insert on pos_fulfilment_lines for each row execute function pos_test_fail()");
        try {
            fulfilments.processDue(50);
        } finally {
            jdbc.execute("drop trigger trg_pos_test_fail on pos_fulfilment_lines");
            jdbc.execute("drop function pos_test_fail()");
        }
        // A PENDING fulfilment exists. Declaring it POSTED and its reservation FULFILLED with no postings fails at commit: all or nothing.
        assertThatThrownBy(() -> transactionTemplate.executeWithoutResult(status -> {
            jdbc.update("update stock_reservations set status = 'FULFILLED', fulfilled_at = now()");
            jdbc.update("update pos_fulfilments set status = 'POSTED', posted_at = now()");
        })).rootCause().hasMessageContaining("posting for every reserved line");
        assertThat(jdbc.queryForObject("select status from stock_reservations", String.class)).isEqualTo("ACTIVE");
        assertThat(jdbc.queryForObject("select status from pos_fulfilments", String.class)).isEqualTo("PENDING");
        // A posting must be its own reservation line deducted by a SALE movement: an opening movement, or another item, is refused.
        UUID line = jdbc.queryForObject("select id from stock_reservation_lines order by quantity desc limit 1", UUID.class);
        UUID saleId = jdbc.queryForObject("select sale_id from pos_fulfilments", UUID.class);
        UUID opening = jdbc.queryForObject("select id from stock_movements where movement_type = 'OPENING' limit 1", UUID.class);
        assertThatThrownBy(() -> jdbc.update("insert into pos_fulfilment_lines (reservation_line_id, sale_id, merchant_id, branch_id, item_id, movement_id, quantity, created_at) "
                + "select r.id, ?, r.merchant_id, r.branch_id, r.item_id, ?, r.quantity, now() from stock_reservation_lines r where r.id = ?", saleId, opening, line))
                .hasMessageContaining("SALE movement");
        // A fulfilment can not point at a reservation of another branch (composite key): the branch of the shop is not the branch of the cafe.
        assertThatThrownBy(() -> jdbc.update("update pos_fulfilments set branch_id = ?", w.cafeBranchId)).isNotNull();
        assertThat(saleMovements()).isEmpty();
        assertThat(count("pos_fulfilment_lines")).isZero();
    }
}
