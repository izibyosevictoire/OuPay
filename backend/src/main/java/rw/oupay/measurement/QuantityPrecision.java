package rw.oupay.measurement;

import java.math.BigDecimal;
import rw.oupay.measurement.MeasurementException.Reason;

/**
 * The storage contract for canonical quantities: PostgreSQL {@code NUMERIC(20,6)}, that is 14 integral digits and
 * 6 fractional digits. Nothing is ever rounded to fit; a value that does not fit exactly is rejected.
 *
 * <p>This limit applies to the CANONICAL value only. A quantity shown in a larger unit may legitimately need more
 * than six decimals (0.000001 g is 0.000000001 kg) and is still exact and valid.
 *
 * <p>The package-private helpers make arbitrary programmatic {@link BigDecimal} input safe: an extreme exponent
 * such as {@code 1E+2147483647} or {@code 1E-2147483647} makes {@code BigDecimal} itself throw
 * {@link ArithmeticException} when it adjusts the scale, and that must surface as a domain error, never a 500.
 */
public final class QuantityPrecision {

    public static final int SCALE = 6;
    public static final int INTEGRAL_DIGITS = 14;
    /** 99999999999999.999999, the largest magnitude NUMERIC(20,6) holds. */
    public static final BigDecimal MAX_MAGNITUDE =
            BigDecimal.TEN.pow(INTEGRAL_DIGITS).subtract(BigDecimal.ONE.movePointLeft(SCALE));

    private QuantityPrecision() {}

    /**
     * Checks an amount that is already in a canonical unit. Sign is not judged here (stock movement deltas may
     * be negative); see {@link QuantityPolicy} for that. Comparison and scale inspection never expand the number.
     */
    public static void requireStorable(BigDecimal canonicalAmount) {
        BigDecimal stripped = strip(canonicalAmount);
        if (stripped.abs().compareTo(MAX_MAGNITUDE) > 0) {
            throw outOfRange();
        }
        if (stripped.scale() > SCALE) {
            throw new MeasurementException(Reason.PRECISION_EXCEEDED,
                    "That quantity has more decimal places than can be stored exactly.");
        }
    }

    /** Removes trailing zeros; an exponent too extreme for BigDecimal to represent is rejected as a domain error. */
    static BigDecimal strip(BigDecimal amount) {
        try {
            return amount.stripTrailingZeros();
        } catch (ArithmeticException e) {
            throw scaleOverflow(amount.scale());
        }
    }

    /** Exact product; a scale that overflows is rejected as a domain error. */
    static BigDecimal multiply(BigDecimal left, BigDecimal right) {
        try {
            return left.multiply(right);
        } catch (ArithmeticException e) {
            throw scaleOverflow((long) left.scale() + right.scale());
        }
    }

    /**
     * Gives a stripped value a scale of at least 0 (100, not 1E+2). Call it only AFTER the range check, which
     * bounds the magnitude, so that this cannot expand an enormous exponent into digits.
     */
    static BigDecimal withoutNegativeScale(BigDecimal stripped) {
        return stripped.scale() < 0 ? stripped.setScale(0) : stripped;
    }

    private static MeasurementException outOfRange() {
        return new MeasurementException(Reason.OUT_OF_RANGE, "That quantity is too large.");
    }

    /** A negative scale means astronomically large, a positive one astronomically fine. */
    private static MeasurementException scaleOverflow(long scale) {
        return scale < 0
                ? outOfRange()
                : new MeasurementException(Reason.PRECISION_EXCEEDED,
                        "That quantity has more decimal places than can be stored exactly.");
    }
}
