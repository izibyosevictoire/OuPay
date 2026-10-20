package rw.oupay.common;

import static org.assertj.core.api.Assertions.assertThat;

import java.sql.SQLException;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.dao.DeadlockLoserDataAccessException;
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
    void aDeadlockIsARetryableBusyResponseWithoutLeakingDetails() {
        var cause = new SQLException("ERROR: deadlock detected Detail: Process 4711 waits for ShareLock on transaction 99; "
                + "blocked by process 4712. Hint: See server log. Where: while updating tuple in relation \"stock_balances\"", "40P01");
        var response = handler.handleDataAccess(new DeadlockLoserDataAccessException("update stock_balances set on_hand = 1", cause));
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.SERVICE_UNAVAILABLE);
        assertThat(response.getHeaders().getFirst("Retry-After")).isEqualTo("1");
        assertThat(response.getBody().code()).isEqualTo("try_again");
        assertThat(response.getBody().fields()).isEmpty();
        assertThat(response.getBody().message()).doesNotContain("stock_balances").doesNotContain("4711")
                .doesNotContain("ShareLock").doesNotContain("deadlock");
    }

    @Test
    void aLockTimeoutIsTheSameRetryableResponse() {
        var cause = new SQLException("ERROR: canceling statement due to lock timeout Where: relation \"invoices\"", "55P03");
        var response = handler.handleDataAccess(new UncategorizedSQLException("update", "update invoices set status = 'VOIDED'", cause));
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.SERVICE_UNAVAILABLE);
        assertThat(response.getHeaders().getFirst("Retry-After")).isEqualTo("1");
        assertThat(response.getBody().code()).isEqualTo("try_again");
        assertThat(response.getBody().message()).doesNotContain("invoices").doesNotContain("timeout");
    }

    @Test
    void contentionWrappedInAnyOtherExceptionIsStillRecognised() throws Exception {
        var wrapped = new RuntimeException("commit failed", new SQLException("deadlock detected", "40P01"));
        var response = handler.handleUnexpected(wrapped);
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.SERVICE_UNAVAILABLE);
        assertThat(response.getBody().code()).isEqualTo("try_again");
    }

    @Test
    void aNumericOverflowIsAServerErrorByDefaultBecauseTheDatabaseCannotTellWhoSentTheValue() {
        var cause = new SQLException("ERROR: numeric field overflow Detail: A field with precision 20, scale 6 must round to an "
                + "absolute value less than 10^14. Where: column \"on_hand\" of relation \"stock_balances\"", "22003");
        var response = handler.handleIntegrity(new DataIntegrityViolationException("insert into stock_balances ...", cause));
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.INTERNAL_SERVER_ERROR);
        assertThat(response.getBody().code()).isEqualTo("service_unavailable");
        assertThat(response.getBody().message()).doesNotContain("stock_balances").doesNotContain("on_hand")
                .doesNotContain("precision").doesNotContain("overflow");
    }

    @Test
    void anOverflowSurfacingAsAGenericDataAccessErrorIsHandledTheSameWay() {
        var cause = new SQLException("numeric field overflow", "22003");
        var response = handler.handleDataAccess(new UncategorizedSQLException("insert", "insert ...", cause));
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.INTERNAL_SERVER_ERROR);
        assertThat(response.getBody().code()).isEqualTo("service_unavailable");
    }

    @Test
    void otherIntegrityViolationsKeepTheirExistingConflictResponse() {
        var cause = new SQLException("ERROR: duplicate key value violates unique constraint \"ux_invoices_number\"", "23505");
        var response = handler.handleIntegrity(new DataIntegrityViolationException("insert", cause));
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(response.getBody().code()).isEqualTo("conflict");
        assertThat(response.getBody().message()).doesNotContain("ux_invoices_number");
    }

    @Test
    void everyErrorKeepsThePublicShapeOfCodeMessageAndFields() {
        var busy = handler.handleDataAccess(new DeadlockLoserDataAccessException("x", new SQLException("d", "40P01"))).getBody();
        var overflow = handler.handleIntegrity(new DataIntegrityViolationException("x", new SQLException("o", "22003"))).getBody();
        for (var body : new GlobalExceptionHandler.ErrorResponse[] {busy, overflow}) {
            assertThat(body.code()).isNotBlank();
            assertThat(body.message()).isNotBlank();
            assertThat(body.fields()).isNotNull().isEmpty();
        }
    }

    @Test
    void apiExceptionsKeepTheirStatusAndCode() {
        var response = handler.handleApi(ApiException.forbidden("no"));
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(response.getBody().code()).isEqualTo("forbidden");
    }
}
