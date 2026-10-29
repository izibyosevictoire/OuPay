package rw.oupay.measurement;

import org.springframework.http.HttpStatus;
import rw.oupay.common.ApiException;

/**
 * A measurement input was rejected. It is an {@link ApiException} (HTTP 422), so invalid user input reaches the
 * client through the normal error handler with a stable {@code code} instead of becoming a generic 500.
 * Messages are written for end users and never echo raw input.
 */
public final class MeasurementException extends ApiException {

    public enum Reason {
        UNSUPPORTED_UNIT("unsupported_unit"),
        DIMENSION_MISMATCH("dimension_mismatch"),
        INVALID_QUANTITY("invalid_quantity"),
        INVALID_COUNT("invalid_count"),
        PRECISION_EXCEEDED("precision_exceeded"),
        OUT_OF_RANGE("quantity_out_of_range"),
        INVALID_PACKAGE_CONVERSION("invalid_package_conversion");

        private final String code;

        Reason(String code) {
            this.code = code;
        }

        public String code() {
            return code;
        }
    }

    private final Reason reason;

    public MeasurementException(Reason reason, String message) {
        super(HttpStatus.UNPROCESSABLE_CONTENT, reason.code(), message);
        this.reason = reason;
    }

    public Reason reason() {
        return reason;
    }
}
