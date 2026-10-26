package rw.oupay.measurement;

import java.math.BigDecimal;
import java.util.Locale;

/**
 * The fixed, global measurement units. Each converts to its dimension's canonical unit by an exact integer
 * factor (never a floating-point approximation). Product packaging such as cartons or bags is deliberately NOT
 * here: its factor belongs to a product, see {@link PackageConversion}.
 */
public enum MeasurementUnit {
    PIECE("pc", MeasurementDimension.COUNT, 1L),
    GRAM("g", MeasurementDimension.MASS, 1L),
    KILOGRAM("kg", MeasurementDimension.MASS, 1_000L),
    MILLILITER("ml", MeasurementDimension.VOLUME, 1L),
    LITER("l", MeasurementDimension.VOLUME, 1_000L),
    MILLIMETER("mm", MeasurementDimension.LENGTH, 1L),
    METER("m", MeasurementDimension.LENGTH, 1_000L),
    SQUARE_MILLIMETER("mm2", MeasurementDimension.AREA, 1L),
    SQUARE_METER("m2", MeasurementDimension.AREA, 1_000_000L);

    private final String code;
    private final MeasurementDimension dimension;
    private final BigDecimal canonicalFactor;

    MeasurementUnit(String code, MeasurementDimension dimension, long canonicalFactor) {
        this.code = code;
        this.dimension = dimension;
        this.canonicalFactor = BigDecimal.valueOf(canonicalFactor);
    }

    /** Stable lower-case code, for example {@code kg}. */
    public String code() {
        return code;
    }

    public MeasurementDimension dimension() {
        return dimension;
    }

    /** How many canonical units one of this unit equals. Always a positive whole number. */
    public BigDecimal canonicalFactor() {
        return canonicalFactor;
    }

    public boolean isCanonical() {
        return canonicalFactor.compareTo(BigDecimal.ONE) == 0;
    }

    /** Looks a unit up by code, ignoring case. Locale-independent. Anything unknown is rejected. */
    public static MeasurementUnit fromCode(String code) {
        if (code != null) {
            String normalized = code.trim().toLowerCase(Locale.ROOT);
            for (MeasurementUnit unit : values()) {
                if (unit.code.equals(normalized)) {
                    return unit;
                }
            }
        }
        throw new MeasurementException(MeasurementException.Reason.UNSUPPORTED_UNIT, "That unit is not supported.");
    }
}
