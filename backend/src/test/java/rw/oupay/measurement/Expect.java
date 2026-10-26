package rw.oupay.measurement;

import java.math.BigDecimal;
import rw.oupay.measurement.MeasurementException.Reason;

/** Small shared helpers for the measurement tests. */
final class Expect {

    private Expect() {}

    static BigDecimal d(String value) {
        return new BigDecimal(value);
    }

    /** Runs the action, which must be rejected, and returns why. */
    static Reason rejection(Runnable action) {
        try {
            action.run();
        } catch (MeasurementException e) {
            return e.reason();
        }
        throw new AssertionError("expected the input to be rejected");
    }
}
