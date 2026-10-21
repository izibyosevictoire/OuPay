package rw.oupay.common;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.sql.SQLException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.springframework.dao.CannotAcquireLockException;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.transaction.support.TransactionSynchronizationManager;

class TransactionRetryTest {

    private final List<Duration> pauses = new ArrayList<>();

    private TransactionRetry retry(TransactionRetry.Policy policy, double jitter) {
        return new TransactionRetry(policy, pauses::add, () -> jitter);
    }

    private static RuntimeException deadlock() {
        return new CannotAcquireLockException("deadlock", new SQLException("deadlock detected", "40P01"));
    }

    @Test
    void retriesATransientFailureUntilItSucceeds() {
        AtomicInteger calls = new AtomicInteger();
        String result = retry(TransactionRetry.STANDARD, 0.0).execute(() -> {
            if (calls.incrementAndGet() < 3) {
                throw deadlock();
            }
            return "committed";
        });
        assertThat(result).isEqualTo("committed");
        assertThat(calls).hasValue(3);
        // Pauses happen between attempts, outside any transaction: half the delay at zero jitter, doubling each time.
        assertThat(pauses).containsExactly(Duration.ofMillis(25), Duration.ofMillis(50));
    }

    @Test
    void givesUpAfterTheLastAttemptAndRethrowsItsException() {
        AtomicInteger calls = new AtomicInteger();
        List<RuntimeException> failures = new ArrayList<>();
        assertThatThrownBy(() -> retry(TransactionRetry.STANDARD, 0.0).execute(() -> {
            calls.incrementAndGet();
            RuntimeException failure = deadlock();
            failures.add(failure);
            throw failure;
        })).isSameAs(failures.get(2));
        assertThat(calls).hasValue(3);
        assertThat(pauses).hasSize(2);
    }

    @Test
    void neverRetriesAFailureThatIsNotTransientContention() {
        for (RuntimeException failure : List.of(
                new DataIntegrityViolationException("dup", new SQLException("duplicate key", "23505")),
                ApiException.conflict("version_conflict", "stale"),
                new IllegalStateException("bug"))) {
            AtomicInteger calls = new AtomicInteger();
            assertThatThrownBy(() -> retry(TransactionRetry.STANDARD, 0.0).execute(() -> {
                calls.incrementAndGet();
                throw failure;
            })).isSameAs(failure);
            assertThat(calls).as(failure.getClass().getSimpleName()).hasValue(1);
        }
        assertThat(pauses).isEmpty();
    }

    @Test
    void theDelayDoublesUpToTheCapAndIsJittered() {
        var policy = new TransactionRetry.Policy(10, Duration.ofMillis(100), Duration.ofMillis(400));
        assertThat(retry(policy, 0.0).backoff(1)).isEqualTo(Duration.ofMillis(50));
        assertThat(retry(policy, 1.0).backoff(1)).isEqualTo(Duration.ofMillis(100));
        assertThat(retry(policy, 1.0).backoff(2)).isEqualTo(Duration.ofMillis(200));
        // 100 x 2^4 = 1600 ms, capped at 400 ms; jitter then takes between half and all of it.
        assertThat(retry(policy, 1.0).backoff(5)).isEqualTo(Duration.ofMillis(400));
        assertThat(retry(policy, 0.0).backoff(5)).isEqualTo(Duration.ofMillis(200));
        assertThat(retry(policy, 1.0).backoff(60)).isEqualTo(Duration.ofMillis(400));
    }

    @Test
    void refusesToRunInsideATransaction() {
        TransactionSynchronizationManager.setActualTransactionActive(true);
        try {
            AtomicInteger calls = new AtomicInteger();
            assertThatThrownBy(() -> retry(TransactionRetry.STANDARD, 0.0).execute(() -> {
                calls.incrementAndGet();
                return "never";
            })).isInstanceOf(IllegalStateException.class).hasMessageContaining("must wrap the transaction");
            assertThat(calls).hasValue(0);
        } finally {
            TransactionSynchronizationManager.setActualTransactionActive(false);
        }
    }

    @Test
    void stopsAndKeepsTheInterruptWhenTheWaitIsInterrupted() {
        var interruptedPause = new TransactionRetry(TransactionRetry.STANDARD, duration -> {
            throw new InterruptedException("shutting down");
        }, () -> 0.0);
        RuntimeException failure = deadlock();
        try {
            assertThatThrownBy(() -> interruptedPause.execute(() -> {
                throw failure;
            })).isSameAs(failure);
            assertThat(Thread.currentThread().isInterrupted()).isTrue();
        } finally {
            Thread.interrupted();
        }
    }

    @Test
    void rejectsAnInvalidPolicy() {
        assertThatThrownBy(() -> new TransactionRetry.Policy(0, Duration.ofMillis(1), Duration.ofMillis(2)))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new TransactionRetry.Policy(3, Duration.ofMillis(100), Duration.ofMillis(10)))
                .isInstanceOf(IllegalArgumentException.class);
    }
}
