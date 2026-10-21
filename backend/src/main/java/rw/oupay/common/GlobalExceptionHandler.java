package rw.oupay.common;

import jakarta.validation.ConstraintViolationException;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataAccessException;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.dao.OptimisticLockingFailureException;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.HttpRequestMethodNotSupportedException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;

/**
 * One error shape for the whole API. Internal details (SQL, stack traces, constraint names) are
 * logged but never returned to the caller.
 */
@RestControllerAdvice
public class GlobalExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);

    public record ErrorResponse(String code, String message, List<FieldError> fields) {}

    public record FieldError(String field, String message) {}

    @ExceptionHandler(ApiException.class)
    ResponseEntity<ErrorResponse> handleApi(ApiException e) {
        return ResponseEntity.status(e.status()).body(new ErrorResponse(e.code(), e.getMessage(), List.of()));
    }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    ResponseEntity<ErrorResponse> handleBody(MethodArgumentNotValidException e) {
        List<FieldError> fields = e.getBindingResult().getFieldErrors().stream()
                .map(f -> new FieldError(f.getField(), f.getDefaultMessage()))
                .toList();
        return ResponseEntity.status(HttpStatus.UNPROCESSABLE_CONTENT)
                .body(new ErrorResponse("validation", "Some fields are not valid.", fields));
    }

    @ExceptionHandler(ConstraintViolationException.class)
    ResponseEntity<ErrorResponse> handleConstraint(ConstraintViolationException e) {
        List<FieldError> fields = e.getConstraintViolations().stream()
                .map(v -> new FieldError(v.getPropertyPath().toString(), v.getMessage()))
                .toList();
        return ResponseEntity.status(HttpStatus.UNPROCESSABLE_CONTENT)
                .body(new ErrorResponse("validation", "Some fields are not valid.", fields));
    }

    @ExceptionHandler({HttpMessageNotReadableException.class, MethodArgumentTypeMismatchException.class})
    ResponseEntity<ErrorResponse> handleUnreadable(Exception e) {
        return ResponseEntity.status(HttpStatus.BAD_REQUEST)
                .body(new ErrorResponse("bad_request", "The request could not be read.", List.of()));
    }

    @ExceptionHandler(HttpRequestMethodNotSupportedException.class)
    ResponseEntity<ErrorResponse> handleMethod(HttpRequestMethodNotSupportedException e) {
        return ResponseEntity.status(HttpStatus.METHOD_NOT_ALLOWED)
                .body(new ErrorResponse("method_not_allowed", "That method is not supported here.", List.of()));
    }

    @ExceptionHandler(OptimisticLockingFailureException.class)
    ResponseEntity<ErrorResponse> handleOptimistic(OptimisticLockingFailureException e) {
        return ResponseEntity.status(HttpStatus.CONFLICT)
                .body(new ErrorResponse("version_conflict",
                        "This record was changed by someone else. Reload it and try again.", List.of()));
    }

    @ExceptionHandler(DataIntegrityViolationException.class)
    ResponseEntity<ErrorResponse> handleIntegrity(DataIntegrityViolationException e) {
        if (DatabaseErrors.isNumericOutOfRange(e)) {
            return numericOutOfRange(e);
        }
        if (DatabaseErrors.isTransientContention(e)) {
            return busy(e);
        }
        // A database constraint caught something the service did not (or a race the service lost).
        log.warn("Data integrity violation: {}", e.getMostSpecificCause().getMessage());
        return ResponseEntity.status(HttpStatus.CONFLICT)
                .body(new ErrorResponse("conflict", "The change conflicts with existing data.", List.of()));
    }

    /**
     * A PostgreSQL trigger refused the change (SQLSTATE P0001): a financial or lifecycle rule that the
     * service layer did not catch first (typically a lost race). The details stay in the log.
     */
    @ExceptionHandler(DataAccessException.class)
    ResponseEntity<ErrorResponse> handleDataAccess(DataAccessException e) {
        if (DatabaseErrors.isTransientContention(e)) {
            return busy(e);
        }
        if (DatabaseErrors.isNumericOutOfRange(e)) {
            return numericOutOfRange(e);
        }
        Throwable cause = e.getMostSpecificCause();
        if (cause instanceof java.sql.SQLException sql && "P0001".equals(sql.getSQLState())) {
            log.warn("Database rule refused a change: {}", cause.getMessage());
            return ResponseEntity.status(HttpStatus.CONFLICT)
                    .body(new ErrorResponse("ledger_rule_violation", "The change was refused by a financial integrity rule.", List.of()));
        }
        log.error("Database error", e);
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                .body(new ErrorResponse("service_unavailable", "Something went wrong. Please try again.", List.of()));
    }

    @ExceptionHandler(Exception.class)
    ResponseEntity<ErrorResponse> handleUnexpected(Exception e) throws Exception {
        if (e instanceof org.springframework.security.access.AccessDeniedException
                || e instanceof org.springframework.security.core.AuthenticationException
                || e instanceof org.springframework.web.ErrorResponse) {
            throw e; // let the framework produce the proper 401/403/404
        }
        // A database failure that reached us wrapped in something other than a Spring data-access exception
        // (for example a JPA or transaction-commit wrapper) is still recognised by its SQLSTATE.
        if (DatabaseErrors.isTransientContention(e)) {
            return busy(e);
        }
        if (DatabaseErrors.isNumericOutOfRange(e)) {
            return numericOutOfRange(e);
        }
        log.error("Unexpected error", e);
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                .body(new ErrorResponse("service_unavailable", "Something went wrong. Please try again.", List.of()));
    }

    /**
     * A deadlock or lock timeout: PostgreSQL rolled this request's transaction back, so nothing was changed and the same
     * request can be sent again (with the same Idempotency-Key, if it has one). Only the SQLSTATE is logged.
     */
    private ResponseEntity<ErrorResponse> busy(Exception e) {
        log.warn("Database contention aborted a request (SQLState {}); the caller may retry", DatabaseErrors.sqlState(e).orElse("n/a"));
        return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
                .header(HttpHeaders.RETRY_AFTER, "1")
                .body(new ErrorResponse("try_again", "The system is busy finishing another change. Please try again in a moment.", List.of()));
    }

    /**
     * A number was too large for its column. The database cannot tell whether the client sent it or the server computed
     * it, so this is a server error by default; code that writes a client-supplied value says so explicitly with
     * {@link DatabaseErrors#rejectingOverflowAsInput}, which turns it into a 422 before it gets here.
     */
    private ResponseEntity<ErrorResponse> numericOutOfRange(Exception e) {
        log.error("A value was out of range for its database column (SQLState {}); it was not validated before being stored",
                DatabaseErrors.NUMERIC_VALUE_OUT_OF_RANGE, e);
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                .body(new ErrorResponse("service_unavailable", "Something went wrong. Please try again.", List.of()));
    }
}
