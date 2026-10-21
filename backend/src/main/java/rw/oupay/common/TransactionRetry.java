package rw.oupay.common;

import java.time.Duration;
import java.util.concurrent.ThreadLocalRandom;
import java.util.function.DoubleSupplier;
import java.util.function.Supplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.transaction.support.TransactionSynchronizationManager;

/**
 * Runs a WHOLE transaction again when PostgreSQL aborted it for a transient reason (a deadlock or a lock timeout).
 *
 * <p>How to use it safely:
 * <ul>
 *   <li>Wrap the outermost call, never code that is already inside a transaction: this class refuses to run inside one,
 *       because a failed statement leaves PostgreSQL's transaction aborted and nothing inside it can be repeated.</li>
 *   <li>The supplied function must start its own transaction (a service call, or a {@code TransactionTemplate}), so every
 *       attempt gets a fresh transaction and a fresh snapshot.</li>
 *   <li>Only use it for an operation that is safe to repeat: it has no irreversible external side effect (no e-mail,
 *       no bank call) and it either changes nothing when it fails or carries a durable operation identity (an
 *       idempotency key AND a uniqueness constraint on the business row) so a repeat cannot double-apply.</li>
 *   <li>The pause between attempts happens here, outside any transaction, so no connection or lock is held while waiting.</li>
 * </ul>
 * Only deadlocks and lock timeouts are retried; every other failure is rethrown at once. The attempts are bounded and the
 * pause grows exponentially up to a cap, with jitter so competing requests do not retry in lock-step. When the last
 * attempt fails, its exception is rethrown unchanged.
 *
 * <p>No caller exists yet (R2 ships the infrastructure); the first billing or stock operation that needs it is the
 * place to adopt it.
 */
public final class TransactionRetry {

    private static final Logger log = LoggerFactory.getLogger(TransactionRetry.class);

    public record Policy(int maxAttempts, Duration baseDelay, Duration maxDelay) {
        public Policy {
            if (maxAttempts < 1 || baseDelay.isNegative() || maxDelay.compareTo(baseDelay) < 0) {
                throw new IllegalArgumentException("invalid retry policy");
            }
        }
    }

    /** How the pause is made. Replaced in tests so they do not really wait. */
    @FunctionalInterface
    public interface Pause {
        void pause(Duration duration) throws InterruptedException;
    }

    /** Three attempts, pausing about 25 to 50 ms and then 50 to 100 ms: contention in this system clears within moments. */
    public static final Policy STANDARD = new Policy(3, Duration.ofMillis(50), Duration.ofMillis(500));

    private final Policy policy;
    private final Pause pause;
    private final DoubleSupplier jitter;

    public TransactionRetry(Policy policy, Pause pause, DoubleSupplier jitter) {
        this.policy = policy;
        this.pause = pause;
        this.jitter = jitter;
    }

    public static TransactionRetry standard() {
        return new TransactionRetry(STANDARD, duration -> Thread.sleep(duration.toMillis()), () -> ThreadLocalRandom.current().nextDouble());
    }

    public <T> T execute(Supplier<T> transaction) {
        if (TransactionSynchronizationManager.isActualTransactionActive()) {
            throw new IllegalStateException("A transaction retry must wrap the transaction, not run inside one.");
        }
        for (int attempt = 1;; attempt++) {
            try {
                return transaction.get();
            } catch (RuntimeException failure) {
                if (!DatabaseErrors.isTransientContention(failure) || attempt >= policy.maxAttempts()) {
                    throw failure;
                }
                log.warn("Transaction attempt {} of {} was aborted by database contention (SQLState {}); trying again",
                        attempt, policy.maxAttempts(), DatabaseErrors.sqlState(failure).orElse("n/a"));
                pauseBeforeNextAttempt(attempt, failure);
            }
        }
    }

    /** Half to all of the exponential delay, capped. Exposed for tests. */
    Duration backoff(int failedAttempts) {
        long exponential = policy.baseDelay().toMillis() * (1L << Math.min(failedAttempts - 1, 20));
        long capped = Math.min(policy.maxDelay().toMillis(), exponential);
        double fraction = 0.5 + 0.5 * Math.min(Math.max(jitter.getAsDouble(), 0.0), 1.0);
        return Duration.ofMillis(Math.round(capped * fraction));
    }

    private void pauseBeforeNextAttempt(int failedAttempts, RuntimeException failure) {
        try {
            pause.pause(backoff(failedAttempts));
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw failure;
        }
    }
}
