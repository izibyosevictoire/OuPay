package rw.oupay.measurement;

import java.math.BigDecimal;
import rw.oupay.measurement.MeasurementException.Reason;

/**
 * What ONE package of a product holds, in the canonical unit of its dimension: 1 carton = 24 pieces,
 * 1 bag = 25 kg (stored as 25000 g), 1 bottle = 750 mL. Cartons, bags and bottles are not global units; each
 * product defines its own factor, so this value is built per product and never shared.
 *
 * <p>The factor is a positive canonical amount that fits {@link QuantityPrecision}. For COUNT it must be whole,
 * so a package can never contain a fraction of a piece. Conversions are exact: a result that is not
 * representable (for example 25 pieces expressed in cartons of 24, or 1.5 boxes of 25 pieces) is rejected, never
 * rounded. Whether a product may be sold in whole packages only is a catalog rule, not decided here.
 */
public record PackageConversion(MeasurementDimension dimension, BigDecimal canonicalPerPackage) {

    public PackageConversion {
        if (dimension == null || canonicalPerPackage == null || canonicalPerPackage.signum() <= 0) {
            throw invalid();
        }
        try {
            BigDecimal stripped = QuantityPrecision.strip(canonicalPerPackage);
            QuantityPrecision.requireStorable(stripped);
            if (dimension.wholeUnitsOnly() && stripped.scale() > 0) {
                throw invalid();
            }
            canonicalPerPackage = QuantityPrecision.withoutNegativeScale(stripped);
        } catch (MeasurementException e) {
            throw invalid();
        }
    }

    /** One package holds {@code amount} of {@code unit}, for example {@code of(25, KILOGRAM)}. */
    public static PackageConversion of(BigDecimal amount, MeasurementUnit unit) {
        if (amount == null || unit == null) {
            throw invalid();
        }
        try {
            return new PackageConversion(unit.dimension(), new MeasuredQuantity(amount, unit).canonicalAmount());
        } catch (MeasurementException e) {
            throw invalid();
        }
    }

    public static PackageConversion of(long amount, MeasurementUnit unit) {
        return of(BigDecimal.valueOf(amount), unit);
    }

    /** The canonical quantity held by this many packages; a fractional package count is fine if the result is exact. */
    public MeasuredQuantity toQuantity(BigDecimal packages) {
        if (packages == null) {
            throw new MeasurementException(Reason.INVALID_QUANTITY, "A quantity is required.");
        }
        BigDecimal contents = QuantityPrecision.multiply(QuantityPrecision.strip(packages), canonicalPerPackage);
        return new MeasuredQuantity(contents, dimension.canonicalUnit());
    }

    /** How many packages a quantity amounts to. Rejects a different dimension or a result that is not exact at 6 places. */
    public BigDecimal toPackages(MeasuredQuantity quantity) {
        if (quantity == null) {
            throw new MeasurementException(Reason.INVALID_QUANTITY, "A quantity is required.");
        }
        if (quantity.dimension() != dimension) {
            throw new MeasurementException(Reason.DIMENSION_MISMATCH, "These units measure different things.");
        }
        BigDecimal packages;
        try {
            packages = quantity.canonicalAmount().divide(canonicalPerPackage).stripTrailingZeros();
        } catch (ArithmeticException e) {
            // Non-terminating expansion, for example 25 / 24.
            throw notExact();
        }
        if (packages.scale() > QuantityPrecision.SCALE) {
            throw notExact();
        }
        return QuantityPrecision.withoutNegativeScale(packages);
    }

    private static MeasurementException notExact() {
        return new MeasurementException(Reason.PRECISION_EXCEEDED, "That quantity is not an exact number of packages.");
    }

    private static MeasurementException invalid() {
        return new MeasurementException(Reason.INVALID_PACKAGE_CONVERSION, "That package definition is not valid.");
    }
}
