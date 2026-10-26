package rw.oupay.measurement;

/**
 * What a quantity measures. Quantities of different dimensions can never be converted into one another.
 * Each dimension is stored in one canonical unit, which is the unit future stock tables will use.
 */
public enum MeasurementDimension {
    COUNT(true),
    MASS(false),
    VOLUME(false),
    LENGTH(false),
    AREA(false);

    private final boolean wholeUnitsOnly;

    MeasurementDimension(boolean wholeUnitsOnly) {
        this.wholeUnitsOnly = wholeUnitsOnly;
    }

    /**
     * The one unit of this dimension whose factor is 1. Looked up rather than held as a field, because the unit
     * enum already references this one and a mutual field would be null during class initialisation.
     */
    public MeasurementUnit canonicalUnit() {
        for (MeasurementUnit unit : MeasurementUnit.values()) {
            if (unit.dimension() == this && unit.isCanonical()) {
                return unit;
            }
        }
        throw new IllegalStateException("No canonical unit declared for " + name());
    }

    /** True for discrete things (pieces): a fraction of one is not a physical quantity. */
    public boolean wholeUnitsOnly() {
        return wholeUnitsOnly;
    }
}
