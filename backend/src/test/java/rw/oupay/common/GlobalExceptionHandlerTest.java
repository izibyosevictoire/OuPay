package rw.oupay.common;

import static org.assertj.core.api.Assertions.assertThat;

import java.sql.SQLException;
import org.junit.jupiter.api.Test;
import org.springframework.dao.OptimisticLockingFailureException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.UncategorizedSQLException;

class GlobalExceptionHandlerTest {

    private final GlobalExceptionHandler handler = new GlobalExceptionHandler();

    @Test
    void aDatabaseRuleRefusalBecomesAConflictWithoutLeakingSql() {
        var cause = new SQLException("ERROR: allocation exceeds the remaining balance of the invoice", "P0001");
        var response = handler.handleDataAccess(new UncategorizedSQLException("insert", "insert into payment_allocations ...", cause));
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(response.getBody().code()).isEqualTo("ledger_rule_violation");
        assertThat(response.getBody().message()).doesNotContain("payment_allocations").doesNotContain("remaining balance");
    }

    @Test
    void otherDatabaseErrorsAreAGenericServerError() {
        var cause = new SQLException("connection to 10.0.0.5:5432 refused", "08001");
        var response = handler.handleDataAccess(new UncategorizedSQLException("select", "select 1", cause));
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.INTERNAL_SERVER_ERROR);
        assertThat(response.getBody().message()).doesNotContain("10.0.0.5");
    }

    @Test
    void anOptimisticLockFailureIsAVersionConflict() {
        var response = handler.handleOptimistic(new OptimisticLockingFailureException("stale"));
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(response.getBody().code()).isEqualTo("version_conflict");
    }

    @Test
    void apiExceptionsKeepTheirStatusAndCode() {
        var response = handler.handleApi(ApiException.forbidden("no"));
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(response.getBody().code()).isEqualTo("forbidden");
    }
}
