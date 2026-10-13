package rw.oupay.common;

import org.springframework.http.HttpStatus;

/**
 * A business-rule or access failure with a stable machine-readable {@code code}. The codes match
 * the error codes of the frontend service contracts (for example {@code not_found},
 * {@code forbidden}, {@code version_conflict}), so the HTTP client can map them one to one.
 */
public class ApiException extends RuntimeException {

    private final String code;
    private final HttpStatus status;

    public ApiException(HttpStatus status, String code, String message) {
        super(message);
        this.status = status;
        this.code = code;
    }

    public String code() {
        return code;
    }

    public HttpStatus status() {
        return status;
    }

    /** Also used for records the caller may not see, so existence is never revealed. */
    public static ApiException notFound(String message) {
        return new ApiException(HttpStatus.NOT_FOUND, "not_found", message);
    }

    public static ApiException forbidden(String message) {
        return new ApiException(HttpStatus.FORBIDDEN, "forbidden", message);
    }

    public static ApiException unauthenticated() {
        return new ApiException(HttpStatus.UNAUTHORIZED, "unauthenticated", "Please sign in to continue.");
    }

    public static ApiException validation(String message) {
        return new ApiException(HttpStatus.UNPROCESSABLE_CONTENT, "validation", message);
    }

    public static ApiException conflict(String code, String message) {
        return new ApiException(HttpStatus.CONFLICT, code, message);
    }

    public static ApiException invalidState(String code, String message) {
        return new ApiException(HttpStatus.CONFLICT, code, message);
    }

    public static ApiException notImplemented(String message) {
        return new ApiException(HttpStatus.NOT_IMPLEMENTED, "not_implemented", message);
    }
}
