package rw.oupay.common;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.sql.SQLException;
import org.junit.jupiter.api.Test;
import org.springframework.dao.CannotAcquireLockException;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;

class DatabaseErrorsTest {

    private static Exception wrapped(String sqlState) {
        return new RuntimeException("outer", new IllegalStateException("middle", new SQLException("detail the caller must never see", sqlState)));
    }

    @Test
    void findsTheSqlStateAnywhereInTheCauseChain() {
        assertThat(DatabaseErrors.sqlState(wrapped("40P01"))).contains("40P01");
        assertThat(DatabaseErrors.sqlState(new SQLException("x", "55P03"))).contains("55P03");
    }

    @Test
    void aFailureWithoutADatabaseErrorHasNoSqlState() {
        assertThat(DatabaseErrors.sqlState(new IllegalStateException("not the database"))).isEmpty();
        assertThat(DatabaseErrors.sqlState(new SQLException("no state given"))).isEmpty();
    }

    @Test
    void onlyDeadlocksAndLockTimeoutsAreTransientContention() {
        assertThat(DatabaseErrors.isTransientContention(wrapped("40P01"))).isTrue();
        assertThat(DatabaseErrors.isTransientContention(wrapped("55P03"))).isTrue();
        assertThat(DatabaseErrors.isTransientContention(wrapped("22003"))).isFalse();
        assertThat(DatabaseErrors.isTransientContention(wrapped("23505"))).isFalse();
        assertThat(DatabaseErrors.isTransientContention(wrapped("P0001"))).isFalse();
        assertThat(DatabaseErrors.isTransientContention(new IllegalStateException("x"))).isFalse();
    }

    @Test
    void springsLockExceptionIsRecognisedEvenWithoutASqlCause() {
        assertThat(DatabaseErrors.isTransientContention(new CannotAcquireLockException("lock"))).isTrue();
        // A deadlock victim is recognised by its SQLSTATE, whichever exception type Spring chose for it.
        assertThat(DatabaseErrors.isTransientContention(new CannotAcquireLockException("deadlock", new SQLException("deadlock detected", "40P01")))).isTrue();
    }

    @Test
    void recognisesNumericOverflowByItsSqlStateOnly() {
        assertThat(DatabaseErrors.isNumericOutOfRange(wrapped("22003"))).isTrue();
        assertThat(DatabaseErrors.isNumericOutOfRange(wrapped("22001"))).isFalse();
        assertThat(DatabaseErrors.isNumericOutOfRange(new RuntimeException("numeric field overflow"))).isFalse();
    }

    @Test
    void anOverflowBecomesAClientErrorOnlyThroughTheExplicitGuard() {
        assertThatThrownBy(() -> DatabaseErrors.rejectingOverflowAsInput(() -> {
            throw new DataIntegrityViolationException("write failed", new SQLException("numeric field overflow", "22003"));
        }, "That quantity is too large."))
                .isInstanceOfSatisfying(ApiException.class, e -> {
                    assertThat(e.status()).isEqualTo(HttpStatus.UNPROCESSABLE_CONTENT);
                    assertThat(e.code()).isEqualTo("validation");
                    assertThat(e.getMessage()).isEqualTo("That quantity is too large.");
                });
    }

    @Test
    void theGuardLeavesEveryOtherFailureAndEverySuccessAlone() {
        assertThat(DatabaseErrors.rejectingOverflowAsInput(() -> "stored", "unused")).isEqualTo("stored");
        var duplicate = new DataIntegrityViolationException("dup", new SQLException("duplicate key", "23505"));
        assertThatThrownBy(() -> DatabaseErrors.rejectingOverflowAsInput(() -> {
            throw duplicate;
        }, "unused")).isSameAs(duplicate);
        var contention = new CannotAcquireLockException("lock");
        assertThatThrownBy(() -> DatabaseErrors.rejectingOverflowAsInput(() -> {
            throw contention;
        }, "unused")).isSameAs(contention);
    }
}
