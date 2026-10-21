package rw.oupay.common;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.dao.DataAccessException;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import rw.oupay.support.IntegrationTest;
import rw.oupay.support.World;

/**
 * Real PostgreSQL deadlocks, lock timeouts and numeric overflows: the retry utility and the error translation are
 * checked against the errors the database really raises, not against hand-built exceptions.
 */
class DatabaseContentionIT extends IntegrationTest {

    private final GlobalExceptionHandler handler = new GlobalExceptionHandler();

    @Autowired
    PlatformTransactionManager transactionManager;

    World w;
    TransactionTemplate transaction;

    @BeforeEach
    void world() {
        w = World.create(this);
        transaction = new TransactionTemplate(transactionManager);
    }

    private void touch(UUID merchantId) {
        jdbc.update("update merchant_settings set updated_at = now() where merchant_id = ?", merchantId);
    }

    private long currentTransactionId() {
        return jdbc.queryForObject("select txid_current()", Long.class);
    }

    private static void await(CyclicBarrier barrier) {
        try {
            barrier.await(15, TimeUnit.SECONDS);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private static void await(CountDownLatch latch) {
        try {
            latch.await(60, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    @Test
    void aRealDeadlockIsRetriedAsAFreshTransactionAndBothSidesFinish() throws Exception {
        UUID first = w.merchantId;
        UUID second = w.cafeMerchantId;
        CyclicBarrier bothHoldTheirFirstLock = new CyclicBarrier(2);
        ConcurrentLinkedQueue<Long> transactionIds = new ConcurrentLinkedQueue<>();
        TransactionRetry retry = TransactionRetry.standard();

        // Each side locks its own row, waits for the other, then asks for the other's row: a genuine lock cycle.
        Callable<Integer> shopFirst = () -> runCrossing(retry, first, second, bothHoldTheirFirstLock, transactionIds);
        Callable<Integer> cafeFirst = () -> runCrossing(retry, second, first, bothHoldTheirFirstLock, transactionIds);
        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            Future<Integer> a = pool.submit(shopFirst);
            Future<Integer> b = pool.submit(cafeFirst);
            int attemptsA = a.get(60, TimeUnit.SECONDS);
            int attemptsB = b.get(60, TimeUnit.SECONDS);

            // PostgreSQL chose one victim and aborted its transaction; the retry ran as a NEW transaction.
            assertThat(attemptsA + attemptsB).isEqualTo(3);
            assertThat(transactionIds).hasSize(3);
            assertThat(Set.copyOf(transactionIds)).as("every attempt used its own transaction").hasSize(3);
        } finally {
            pool.shutdownNow();
        }
    }

    private int runCrossing(TransactionRetry retry, UUID mine, UUID theirs, CyclicBarrier barrier, ConcurrentLinkedQueue<Long> transactionIds) {
        AtomicInteger attempts = new AtomicInteger();
        retry.execute(() -> transaction.execute(status -> {
            int attempt = attempts.incrementAndGet();
            transactionIds.add(currentTransactionId());
            touch(mine);
            if (attempt == 1) {
                await(barrier);
            }
            touch(theirs);
            return attempt;
        }));
        return attempts.get();
    }

    @Test
    void aLockTimeoutIsRetriedUntilTheLockIsFree() throws Exception {
        ExecutorService pool = Executors.newFixedThreadPool(2);
        CountDownLatch locked = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        try {
            pool.submit(() -> transaction.executeWithoutResult(status -> {
                touch(w.merchantId);
                locked.countDown();
                await(release);
            }));
            assertThat(locked.await(10, TimeUnit.SECONDS)).isTrue();

            AtomicInteger attempts = new AtomicInteger();
            ConcurrentLinkedQueue<Long> transactionIds = new ConcurrentLinkedQueue<>();
            var patient = new TransactionRetry(new TransactionRetry.Policy(60, Duration.ofMillis(20), Duration.ofMillis(100)),
                    duration -> Thread.sleep(duration.toMillis()), () -> 0.5);
            Future<Integer> waiting = pool.submit(() -> patient.execute(() -> transaction.execute(status -> {
                attempts.incrementAndGet();
                transactionIds.add(currentTransactionId());
                jdbc.execute("set local lock_timeout = '100ms'");
                touch(w.merchantId);
                return attempts.get();
            })));

            Thread.sleep(500);
            release.countDown();

            assertThat(waiting.get(60, TimeUnit.SECONDS)).isGreaterThanOrEqualTo(2);
            assertThat(attempts.get()).isGreaterThanOrEqualTo(2);
            assertThat(Set.copyOf(transactionIds)).hasSize(attempts.get());
        } finally {
            release.countDown();
            pool.shutdownNow();
        }
    }

    @Test
    void aLockTimeoutThatNeverClearsGivesUpAfterTheLastAttemptWithoutLeakingSql() throws Exception {
        ExecutorService pool = Executors.newSingleThreadExecutor();
        CountDownLatch locked = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        try {
            pool.submit(() -> transaction.executeWithoutResult(status -> {
                touch(w.merchantId);
                locked.countDown();
                await(release);
            }));
            assertThat(locked.await(10, TimeUnit.SECONDS)).isTrue();

            AtomicInteger attempts = new AtomicInteger();
            var twoAttempts = new TransactionRetry(new TransactionRetry.Policy(2, Duration.ofMillis(1), Duration.ofMillis(2)), duration -> { }, () -> 0.0);
            Throwable failure = org.assertj.core.api.Assertions.catchThrowable(() -> twoAttempts.execute(() -> transaction.execute(status -> {
                attempts.incrementAndGet();
                jdbc.execute("set local lock_timeout = '100ms'");
                touch(w.merchantId);
                return null;
            })));

            assertThat(attempts).hasValue(2);
            assertThat(failure).isInstanceOf(DataAccessException.class);
            assertThat(DatabaseErrors.sqlState(failure)).contains(DatabaseErrors.LOCK_NOT_AVAILABLE);
            assertThat(DatabaseErrors.isTransientContention(failure)).isTrue();

            var response = handler.handleDataAccess((DataAccessException) failure);
            assertThat(response.getStatusCode()).isEqualTo(HttpStatus.SERVICE_UNAVAILABLE);
            assertThat(response.getBody().code()).isEqualTo("try_again");
            assertThat(response.getBody().message()).doesNotContain("merchant_settings").doesNotContain("lock").doesNotContain("55P03");
        } finally {
            release.countDown();
            pool.shutdownNow();
        }
    }

    @Test
    void aRealDeadlockVictimIsRecognisedAndTranslatedWithoutLeakingSql() throws Exception {
        CyclicBarrier bothHold = new CyclicBarrier(2);
        List<Throwable> failures = new ArrayList<>();
        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            Callable<Void> shopFirst = () -> crossOnce(w.merchantId, w.cafeMerchantId, bothHold, failures);
            Callable<Void> cafeFirst = () -> crossOnce(w.cafeMerchantId, w.merchantId, bothHold, failures);
            List<Future<Void>> both = List.of(pool.submit(shopFirst), pool.submit(cafeFirst));
            for (Future<Void> future : both) {
                future.get(60, TimeUnit.SECONDS);
            }
        } finally {
            pool.shutdownNow();
        }

        assertThat(failures).hasSize(1);
        Throwable victim = failures.get(0);
        assertThat(DatabaseErrors.sqlState(victim)).contains(DatabaseErrors.DEADLOCK_DETECTED);
        assertThat(DatabaseErrors.isTransientContention(victim)).isTrue();
        var response = handler.handleDataAccess((DataAccessException) victim);
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.SERVICE_UNAVAILABLE);
        assertThat(response.getBody().message()).doesNotContain("merchant_settings").doesNotContain("deadlock").doesNotContain("Process");
    }

    private Void crossOnce(UUID mine, UUID theirs, CyclicBarrier barrier, List<Throwable> failures) {
        try {
            transaction.executeWithoutResult(status -> {
                touch(mine);
                await(barrier);
                touch(theirs);
            });
        } catch (RuntimeException failure) {
            synchronized (failures) {
                failures.add(failure);
            }
        }
        return null;
    }

    @Test
    void aRealNumericOverflowIsAServerErrorByDefaultAndAClientErrorOnlyThroughTheExplicitGuard() {
        assertThatThrownBy(() -> jdbc.queryForObject("select cast(1e30 as numeric(20,6))", java.math.BigDecimal.class))
                .satisfies(failure -> {
                    assertThat(DatabaseErrors.isNumericOutOfRange(failure)).isTrue();
                    assertThat(DatabaseErrors.isTransientContention(failure)).isFalse();
                    // Spring files a 22xxx error under data integrity; either handler must give the same generic answer.
                    var response = failure instanceof DataIntegrityViolationException integrity
                            ? handler.handleIntegrity(integrity)
                            : handler.handleDataAccess((DataAccessException) failure);
                    assertThat(response.getStatusCode()).isEqualTo(HttpStatus.INTERNAL_SERVER_ERROR);
                    assertThat(response.getBody().message()).doesNotContain("numeric").doesNotContain("overflow").doesNotContain("precision");
                });

        // A write of a client-supplied value says so, and gets a 422 the caller can act on.
        assertThatThrownBy(() -> DatabaseErrors.rejectingOverflowAsInput(
                () -> jdbc.queryForObject("select cast(1e30 as numeric(20,6))", java.math.BigDecimal.class), "That quantity is too large."))
                .isInstanceOfSatisfying(ApiException.class, e -> {
                    assertThat(e.status()).isEqualTo(HttpStatus.UNPROCESSABLE_CONTENT);
                    assertThat(e.getMessage()).isEqualTo("That quantity is too large.");
                });
    }

    @Test
    void theRetryRefusesToRunInsideARealTransaction() {
        assertThatThrownBy(() -> transaction.executeWithoutResult(status -> TransactionRetry.standard().execute(() -> "never")))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("must wrap the transaction");
    }
}
