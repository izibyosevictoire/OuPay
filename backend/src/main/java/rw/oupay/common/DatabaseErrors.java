package rw.oupay.common;

import java.sql.SQLException;
import java.util.Optional;
import java.util.function.Supplier;
import org.springframework.dao.CannotAcquireLockException;
import org.springframework.dao.DeadlockLoserDataAccessException;

/**
 * Recognises PostgreSQL failures by SQLSTATE, whatever Spring or Hibernate wrapped them in. The SQLSTATE is the only
 * thing ever inspected: messages, table names and constraint names are never parsed or returned to a caller.
 */
public final class DatabaseErrors {

    /** {@code numeric_value_out_of_range}. */
    public static final String NUMERIC_VALUE_OUT_OF_RANGE = "22003";
    /** {@code deadlock_detected}: PostgreSQL chose this transaction as the victim and rolled it back. */
    public static final String DEADLOCK_DETECTED = "40P01";
    /** {@code lock_not_available}: a lock (or {@code lock_timeout}) was not granted in time. */
    public static final String LOCK_NOT_AVAILABLE = "55P03";

    private static final int MAX_CAUSE_DEPTH = 16;

    private DatabaseErrors() {}

    /** The SQLSTATE of the first database error in the cause chain, if there is one. */
    public static Optional<String> sqlState(Throwable failure) {
        Throwable current = failure;
        for (int depth = 0; current != null && depth < MAX_CAUSE_DEPTH; depth++) {
            if (current instanceof SQLException sql && sql.getSQLState() != null) {
                return Optional.of(sql.getSQLState());
            }
            current = current.getCause();
        }
        return Optional.empty();
    }

    public static boolean isNumericOutOfRange(Throwable failure) {
        return sqlState(failure).filter(NUMERIC_VALUE_OUT_OF_RANGE::equals).isPresent();
    }

    /**
     * A deadlock or a lock timeout. These abort only the current transaction and say nothing about the request, so the
     * whole transaction can safely be attempted again.
     */
    public static boolean isTransientContention(Throwable failure) {
        if (failure instanceof CannotAcquireLockException || failure instanceof DeadlockLoserDataAccessException) {
            return true;
        }
        return sqlState(failure).filter(state -> DEADLOCK_DETECTED.equals(state) || LOCK_NOT_AVAILABLE.equals(state)).isPresent();
    }

    /**
     * For a write whose numbers come straight from the client: a value too large for its column is then the client's
     * mistake, so it becomes a 422 instead of a server error. Use it ONLY around writes of client-supplied values.
     * An overflow anywhere else (a sum, a derived value) is a server fault and must stay one, which is why the global
     * handler does not make this assumption for you.
     *
     * <p>The write must include its flush (for example {@code saveAndFlush}), because a JPA overflow surfaces at flush
     * time. The exception propagates, so the surrounding transaction rolls back as usual.
     */
    public static <T> T rejectingOverflowAsInput(Supplier<T> write, String message) {
        try {
            return write.get();
        } catch (RuntimeException failure) {
            if (isNumericOutOfRange(failure)) {
                throw ApiException.validation(message);
            }
            throw failure;
        }
    }
}
