package rw.oupay.measurement;

import rw.oupay.measurement.MeasurementException.Reason;

/**
 * Business sign rules, kept apart from the quantity type so conversion never forbids a value some use case
 * legitimately needs.
 */
public enum QuantityPolicy {
    /** A balance on hand: zero or more. */
    STOCK_BALANCE("A stock quantity cannot be negative.") {
        @Override
        boolean allows(int signum) {
            return signum >= 0;
        }
    },
    /** Something sold or reserved: strictly positive, zero is forbidden. */
    SALE_QUANTITY("A quantity must be greater than zero.") {
        @Override
        boolean allows(int signum) {
            return signum > 0;
        }
    },
    /** A stock movement delta: either direction, but a movement of nothing is meaningless. */
    STOCK_DELTA("A stock movement cannot be zero.") {
        @Override
        boolean allows(int signum) {
            return signum != 0;
        }
    };

    private final String message;

    QuantityPolicy(String message) {
        this.message = message;
    }

    abstract boolean allows(int signum);

    public boolean isSatisfiedBy(MeasuredQuantity quantity) {
        return quantity != null && allows(quantity.signum());
    }

    /** Returns the quantity unchanged when it satisfies the policy, otherwise rejects it. */
    public MeasuredQuantity require(MeasuredQuantity quantity) {
        if (quantity == null) {
            throw new MeasurementException(Reason.INVALID_QUANTITY, "A quantity is required.");
        }
        if (!allows(quantity.signum())) {
            throw new MeasurementException(Reason.OUT_OF_RANGE, message);
        }
        return quantity;
    }
}
