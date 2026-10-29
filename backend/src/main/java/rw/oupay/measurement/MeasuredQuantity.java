package rw.oupay.measurement;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.regex.Pattern;
import rw.oupay.measurement.MeasurementException.Reason;

/**
 * An exact amount of one unit. Immutable. The amount is normalised (no trailing zeros, never a negative scale),
 * so {@code 1} and {@code 1.000000} are the same quantity.
 *
 * <p>Equality: the record's {@code equals}/{@code hashCode} compare the normalised amount AND the unit, so
 * {@code 1 g} equals {@code 1.000000 g} (safe in sets and map keys) but does NOT equal {@code 0.001 kg}.
 * Equivalent quantities in different units are compared with {@link #compareValue} /
 * {@link #isNumericallyEqualTo}, which are explicit, reject different dimensions, and are not tied to
 * {@code equals}. The type deliberately does not implement {@code Comparable}, because ordering across
 * dimensions is undefined and would make it inconsistent with {@code equals}.
 *
 * <p>Invariants, checked on construction: the amount converted to its canonical unit fits
 * {@link QuantityPrecision} exactly, and a COUNT quantity is a whole number. Sign is NOT constrained here, so
 * the type can carry stock movement deltas; business rules such as "a sale must be positive" live in
 * {@link QuantityPolicy}. Because the check runs on the canonical value, 0.0000001 kg is valid (it is 0.1 g)
 * while 0.0000001 g is not.
 */
public record MeasuredQuantity(BigDecimal amount, MeasurementUnit unit) {

    /** No digit-count cap: a long run of trailing zeros is a valid exact value and parsing it is linear. */
    private static final Pattern PLAIN_DECIMAL = Pattern.compile("-?[0-9]+(\\.[0-9]+)?");

    public MeasuredQuantity {
        if (amount == null || unit == null) {
            throw new MeasurementException(Reason.INVALID_QUANTITY, "A quantity and a unit are required.");
        }
        BigDecimal stripped = QuantityPrecision.strip(amount);
        BigDecimal canonical = QuantityPrecision.multiply(stripped, unit.canonicalFactor());
        if (unit.dimension().wholeUnitsOnly() && QuantityPrecision.strip(canonical).scale() > 0) {
            throw new MeasurementException(Reason.INVALID_COUNT, "A count must be a whole number.");
        }
        QuantityPrecision.requireStorable(canonical);
        amount = QuantityPrecision.withoutNegativeScale(stripped);
    }

    public static MeasuredQuantity of(long amount, MeasurementUnit unit) {
        return new MeasuredQuantity(BigDecimal.valueOf(amount), unit);
    }

    /**
     * Parses plain decimal text such as {@code 2.5} or {@code -0.25}. Exponents, a leading plus, thousands
     * separators, {@code NaN} and {@code Infinity} are all rejected. Always uses '.', never the default locale.
     */
    public static MeasuredQuantity parse(String text, MeasurementUnit unit) {
        String trimmed = text == null ? "" : text.trim();
        if (!PLAIN_DECIMAL.matcher(trimmed).matches()) {
            throw new MeasurementException(Reason.INVALID_QUANTITY, "That is not a valid quantity.");
        }
        return new MeasuredQuantity(new BigDecimal(trimmed), unit);
    }

    public static MeasuredQuantity parse(String text, String unitCode) {
        return parse(text, MeasurementUnit.fromCode(unitCode));
    }

    public MeasurementDimension dimension() {
        return unit.dimension();
    }

    public int signum() {
        return amount.signum();
    }

    /** Converts exactly to another unit of the same dimension; never rounds. */
    public MeasuredQuantity to(MeasurementUnit target) {
        if (target == null) {
            throw new MeasurementException(Reason.UNSUPPORTED_UNIT, "That unit is not supported.");
        }
        requireSameDimension(target.dimension());
        if (target == unit) {
            return this;
        }
        BigDecimal canonical = amount.multiply(unit.canonicalFactor());
        try {
            return new MeasuredQuantity(canonical.divide(target.canonicalFactor()), target);
        } catch (ArithmeticException e) {
            // Unreachable with power-of-ten factors, kept so a future unit cannot silently round.
            throw new MeasurementException(Reason.PRECISION_EXCEEDED, "That quantity cannot be converted exactly.");
        }
    }

    public MeasuredQuantity toCanonical() {
        return to(unit.dimension().canonicalUnit());
    }

    /** The amount in the canonical unit, for example grams for any mass. */
    public BigDecimal canonicalAmount() {
        return toCanonical().amount;
    }

    /** The canonical amount at exactly scale 6, ready for a NUMERIC(20,6) column. Never rounds. */
    public BigDecimal storageValue() {
        return canonicalAmount().setScale(QuantityPrecision.SCALE, RoundingMode.UNNECESSARY);
    }

    /** Compares by value across units of one dimension (1000 g equals 1 kg). Different dimensions are rejected. */
    public int compareValue(MeasuredQuantity other) {
        if (other == null) {
            throw new MeasurementException(Reason.INVALID_QUANTITY, "A quantity is required.");
        }
        requireSameDimension(other.dimension());
        return amount.multiply(unit.canonicalFactor()).compareTo(other.amount.multiply(other.unit.canonicalFactor()));
    }

    public boolean isNumericallyEqualTo(MeasuredQuantity other) {
        return compareValue(other) == 0;
    }

    private void requireSameDimension(MeasurementDimension other) {
        if (unit.dimension() != other) {
            throw new MeasurementException(Reason.DIMENSION_MISMATCH, "These units measure different things.");
        }
    }

    @Override
    public String toString() {
        return amount.toPlainString() + " " + unit.code();
    }
}
