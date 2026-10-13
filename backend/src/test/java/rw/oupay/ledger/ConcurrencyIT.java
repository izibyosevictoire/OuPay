package rw.oupay.ledger;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Instant;
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
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.RepeatedTest;
import org.junit.jupiter.api.Test;
import rw.oupay.support.Bank;
import rw.oupay.support.IntegrationTest;
import rw.oupay.support.TestApi;
import rw.oupay.support.World;

/**
 * REAL concurrency against PostgreSQL: many threads, many connections, no mocks. The point is that
 * the guarantees hold whatever the interleaving: no double allocation, no overpayment, no double
 * counting of replays, no deadlock.
 */
class ConcurrencyIT extends IntegrationTest {

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
            assertThat(ready.await(20, TimeUnit.SECONDS)).isTrue();
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

    /** The ledger invariants that must hold after ANY sequence of operations. */
    private void assertLedgerIsConsistent() {
        assertThat(jdbc.queryForObject(
                "select count(*) from (select i.id from payment_allocations a join invoices i on i.id = a.invoice_id "
                        + "where a.status = 'ACTIVE' group by i.id having sum(a.amount_rwf) > max(i.grand_total_rwf)) x", Integer.class))
                .as("no invoice is ever overpaid").isZero();
        assertThat(jdbc.queryForObject(
                "select count(*) from (select t.id from payment_allocations a join bank_transactions t on t.id = a.bank_transaction_id "
                        + "where a.status = 'ACTIVE' group by t.id having sum(a.amount_rwf) > max(t.amount_rwf)) x", Integer.class))
                .as("no transaction is ever allocated more than it holds").isZero();
        assertThat(jdbc.queryForObject(
                "select count(*) from payment_allocations a join bank_transactions t on t.id = a.bank_transaction_id "
                        + "where a.status = 'ACTIVE' and t.status <> 'CONFIRMED'", Integer.class))
                .as("only confirmed money carries active allocations").isZero();
        assertThat(jdbc.queryForObject(
                "select count(*) from payment_allocations a join invoices i on i.id = a.invoice_id "
                        + "where a.status = 'ACTIVE' and i.status <> 'ISSUED'", Integer.class))
                .as("only issued invoices carry active allocations").isZero();
        assertThat(jdbc.queryForObject("select count(*) from (select provider_id, provider_transaction_id from bank_transactions "
                + "group by 1, 2 having count(*) > 1) x", Integer.class)).as("one transaction per provider transaction id").isZero();
    }

    @Test
    void manyConcurrentPaymentsForOneInvoiceNeverOverpayIt() throws Exception {
        UUID invoice = w.issuedInvoice(30_000);
        String ref = number(invoice);
        List<Callable<Bank.Delivery>> tasks = new ArrayList<>();
        for (int i = 0; i < 8; i++) {
            int n = i;
            tasks.add(() -> bank.send("POSTED", 10_000, ref, "tx-race-" + n, "evt-race-" + n, bank.at(n + 1)));
        }
        var results = concurrently(tasks);

        assertThat(results).allSatisfy(r -> assertThat(r.response().status()).isEqualTo(200));
        assertThat(results).allSatisfy(r -> assertThat(r.outcome()).isEqualTo("APPLIED"));
        assertThat(jdbc.queryForObject("select sum(amount_rwf) from payment_allocations where status = 'ACTIVE'", Long.class)).isEqualTo(30_000L);
        assertThat(jdbc.queryForObject("select count(*) from bank_transactions where status = 'CONFIRMED'", Integer.class)).isEqualTo(8);
        // Exactly the 5 payments that did not fit are flagged for a human, not silently lost.
        assertThat(jdbc.queryForObject("select count(*) from bank_transactions where review_state = 'NEEDS_REVIEW'", Integer.class)).isEqualTo(5);
        assertThat(w.owner.get(m("/invoices/" + invoice)).json().path("paymentStatus").asString()).isEqualTo("PAID");
        assertLedgerIsConsistent();
    }

    @Test
    void theSameEventDeliveredTwelveTimesAtOnceIsCountedOnce() throws Exception {
        UUID invoice = w.issuedInvoice(10_000);
        String ref = number(invoice);
        List<Callable<Bank.Delivery>> tasks = new ArrayList<>();
        for (int i = 0; i < 12; i++) {
            tasks.add(() -> bank.send("POSTED", 10_000, ref, "tx-storm", "evt-storm", bank.at(1)));
        }
        var results = concurrently(tasks);

        assertThat(results.stream().filter(r -> r.outcome().equals("APPLIED"))).hasSize(1);
        assertThat(results.stream().filter(r -> r.outcome().equals("DUPLICATE"))).hasSize(11);
        assertThat(jdbc.queryForObject("select count(*) from bank_transactions", Integer.class)).isEqualTo(1);
        assertThat(jdbc.queryForObject("select count(*) from payment_allocations", Integer.class)).isEqualTo(1);
        assertThat(jdbc.queryForObject("select count(*) from bank_events", Integer.class)).isEqualTo(1);
        assertThat(jdbc.queryForObject("select count(*) from notifications where kind = 'INVOICE_SETTLED'", Integer.class)).isEqualTo(3);
        assertLedgerIsConsistent();
    }

    @Test
    void theSameTransactionUnderDifferentEventIdsAtOnceIsCountedOnce() throws Exception {
        UUID invoice = w.issuedInvoice(10_000);
        String ref = number(invoice);
        List<Callable<Bank.Delivery>> tasks = new ArrayList<>();
        for (int i = 0; i < 10; i++) {
            int n = i;
            tasks.add(() -> bank.send("POSTED", 10_000, ref, "tx-one", "evt-variant-" + n, bank.at(1)));
        }
        var results = concurrently(tasks);

        assertThat(results.stream().filter(r -> r.outcome().equals("APPLIED"))).hasSize(1);
        assertThat(jdbc.queryForObject("select count(*) from payment_allocations", Integer.class)).isEqualTo(1);
        assertLedgerIsConsistent();
    }

    @Test
    void twoPeopleAllocatingTheLastBalanceAtOnceOnlyOneWins() throws Exception {
        UUID invoice = w.issuedInvoice(10_000);
        String first = jdbc.queryForObject("select id from bank_transactions where provider_transaction_id = ?", String.class, bank.pay("POSTED", 10_000, null).transactionId());
        String second = jdbc.queryForObject("select id from bank_transactions where provider_transaction_id = ?", String.class, bank.pay("POSTED", 10_000, null).transactionId());
        long v1 = jdbc.queryForObject("select version from bank_transactions where id = ?::uuid", Long.class, first);
        long v2 = jdbc.queryForObject("select version from bank_transactions where id = ?::uuid", Long.class, second);

        var results = concurrently(List.<Callable<TestApi.Response>>of(
                () -> w.owner.post(m("/reconciliation/allocations"), body(first, v1, invoice, 10_000, 10_000)),
                () -> w.manager.post(m("/reconciliation/allocations"), body(second, v2, invoice, 10_000, 10_000))));

        assertThat(results.stream().filter(r -> r.status() == 200)).hasSize(1);
        assertThat(results.stream().filter(r -> r.status() == 409)).hasSize(1);
        assertThat(jdbc.queryForObject("select sum(amount_rwf) from payment_allocations where status = 'ACTIVE'", Long.class)).isEqualTo(10_000L);
        assertLedgerIsConsistent();
    }

    @Test
    void twoPeopleSplittingTheSameTransactionAtOnceOnlyOneWins() throws Exception {
        UUID a = w.issuedInvoice(10_000);
        UUID b = w.issuedInvoice(10_000);
        String tx = jdbc.queryForObject("select id from bank_transactions where provider_transaction_id = ?", String.class, bank.pay("POSTED", 10_000, null).transactionId());
        long version = jdbc.queryForObject("select version from bank_transactions where id = ?::uuid", Long.class, tx);

        var results = concurrently(List.<Callable<TestApi.Response>>of(
                () -> w.owner.post(m("/reconciliation/allocations"), body(tx, version, a, 10_000, 10_000)),
                () -> w.manager.post(m("/reconciliation/allocations"), body(tx, version, b, 10_000, 10_000))));

        assertThat(results.stream().filter(r -> r.status() == 200)).hasSize(1);
        assertThat(jdbc.queryForObject("select sum(amount_rwf) from payment_allocations where status = 'ACTIVE'", Long.class)).isEqualTo(10_000L);
        assertLedgerIsConsistent();
    }

    @RepeatedTest(5)
    void aPaymentAndAVoidNeverBothSucceed() throws Exception {
        UUID invoice = w.issuedInvoice(5_000);
        String ref = number(invoice);
        long version = w.owner.get(m("/invoices/" + invoice)).json().path("version").asLong();
        String key = UUID.randomUUID().toString().substring(0, 8);

        var results = concurrently(List.<Callable<Object>>of(
                () -> w.owner.post(m("/invoices/" + invoice + "/void?expectedVersion=" + version), Map.of("reason", "Issued to the wrong customer")),
                () -> bank.send("POSTED", 5_000, ref, "tx-void-" + key, "evt-void-" + key, bank.at(1))));

        String status = jdbc.queryForObject("select status from invoices where id = ?", String.class, invoice);
        int allocations = jdbc.queryForObject("select count(*) from payment_allocations where invoice_id = ? and status = 'ACTIVE'", Integer.class, invoice);
        // Either the invoice was voided (and the payment was flagged for review) or it was paid (and the void refused).
        assertThat(status.equals("VOIDED") && allocations > 0).as("voided AND paid").isFalse();
        assertThat(status.equals("ISSUED") && allocations == 0).as("neither happened").isFalse();
        assertThat(results).hasSize(2);
        assertLedgerIsConsistent();
    }

    @RepeatedTest(5)
    void aBankReversalAndAManualAllocationNeverLeaveMoneyAllocatedOnReversedMoney() throws Exception {
        UUID a = w.issuedInvoice(20_000);
        var delivery = bank.pay("POSTED", 20_000, null);
        String tx = jdbc.queryForObject("select id from bank_transactions where provider_transaction_id = ?", String.class, delivery.transactionId());
        long version = jdbc.queryForObject("select version from bank_transactions where id = ?::uuid", Long.class, tx);

        var results = concurrently(List.<Callable<Object>>of(
                () -> w.owner.post(m("/reconciliation/allocations"), body(tx, version, a, 20_000, 20_000)),
                () -> bank.send("REVERSED", 20_000, null, delivery.transactionId(), "evt-rev-" + UUID.randomUUID(), Instant.parse("2026-10-12T11:00:00Z"))));

        assertThat(results).hasSize(2);
        assertThat(jdbc.queryForObject("select status from bank_transactions where id = ?::uuid", String.class, tx)).isEqualTo("REVERSED");
        assertThat(jdbc.queryForObject("select count(*) from payment_allocations where status = 'ACTIVE'", Integer.class)).isZero();
        assertThat(w.owner.get(m("/invoices/" + a)).json().path("paymentStatus").asString()).isEqualTo("UNPAID");
        assertLedgerIsConsistent();
    }

    @Test
    void aMixedStormOfOperationsNeitherDeadlocksNorBreaksTheLedger() throws Exception {
        UUID inv1 = w.issuedInvoice(40_000);
        UUID inv2 = w.issuedInvoice(40_000);
        String ref1 = number(inv1);
        String ref2 = number(inv2);
        List<Callable<Integer>> tasks = new ArrayList<>();
        for (int i = 0; i < 6; i++) {
            int n = i;
            tasks.add(() -> bank.send("POSTED", 10_000, ref1, "tx-s1-" + n, "e-s1-" + n, bank.at(n + 1)).response().status());
            tasks.add(() -> bank.send("POSTED", 10_000, ref2, "tx-s2-" + n, "e-s2-" + n, bank.at(n + 1)).response().status());
            tasks.add(() -> bank.send("POSTED", 3_000, null, "tx-s3-" + n, "e-s3-" + n, bank.at(n + 1)).response().status());
        }
        tasks.add(() -> bank.send("REVERSED", 10_000, ref1, "tx-s1-0", "e-s1-rev", bank.at(50)).response().status());
        tasks.add(() -> bank.send("REVERSED", 10_000, ref2, "tx-s2-0", "e-s2-rev", bank.at(50)).response().status());
        var statuses = concurrently(tasks);

        assertThat(statuses).allSatisfy(status -> assertThat(status).isEqualTo(200));
        assertLedgerIsConsistent();
    }

    private Map<String, Object> body(String tx, long version, UUID invoice, long amount, long expectedRemaining) {
        return Map.of("bankTransactionId", tx, "expectedTransactionVersion", version,
                "allocations", List.of(Map.of("invoiceId", invoice.toString(), "amount", amount, "expectedRemainingBalance", expectedRemaining)));
    }
}
