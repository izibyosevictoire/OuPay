package rw.oupay.measurement;

import static org.assertj.core.api.Assertions.assertThat;
import static rw.oupay.measurement.Expect.d;
import static rw.oupay.measurement.Expect.rejection;

import java.math.BigDecimal;
import org.junit.jupiter.api.Test;
import rw.oupay.measurement.MeasurementException.Reason;

class QuantityPolicyTest {

    private static MeasuredQuantity grams(String amount) {
        return new MeasuredQuantity(d(amount), MeasurementUnit.GRAM);
    }

    @Test
    void stockBalanceAllowsZeroAndPositiveButNotNegative() {
        assertThat(QuantityPolicy.STOCK_BALANCE.isSatisfiedBy(grams("0"))).isTrue();
        assertThat(QuantityPolicy.STOCK_BALANCE.isSatisfiedBy(grams("0.000001"))).isTrue();
        assertThat(QuantityPolicy.STOCK_BALANCE.isSatisfiedBy(grams("12.5"))).isTrue();
        assertThat(QuantityPolicy.STOCK_BALANCE.isSatisfiedBy(grams("-0.000001"))).isFalse();
        assertThat(rejection(() -> QuantityPolicy.STOCK_BALANCE.require(grams("-1")))).isEqualTo(Reason.OUT_OF_RANGE);
    }

    @Test
    void saleQuantityMustBeStrictlyPositive() {
        assertThat(QuantityPolicy.SALE_QUANTITY.isSatisfiedBy(grams("0.000001"))).isTrue();
        assertThat(QuantityPolicy.SALE_QUANTITY.isSatisfiedBy(grams("0"))).isFalse();
        assertThat(QuantityPolicy.SALE_QUANTITY.isSatisfiedBy(grams("0.000000"))).isFalse();
        assertThat(QuantityPolicy.SALE_QUANTITY.isSatisfiedBy(grams("-1"))).isFalse();
        assertThat(rejection(() -> QuantityPolicy.SALE_QUANTITY.require(grams("0")))).isEqualTo(Reason.OUT_OF_RANGE);
        assertThat(rejection(() -> QuantityPolicy.SALE_QUANTITY.require(grams("-3")))).isEqualTo(Reason.OUT_OF_RANGE);
    }

    @Test
    void stockDeltaAllowsEitherDirectionButNotNothing() {
        assertThat(QuantityPolicy.STOCK_DELTA.isSatisfiedBy(grams("5"))).isTrue();
        assertThat(QuantityPolicy.STOCK_DELTA.isSatisfiedBy(grams("-5"))).isTrue();
        assertThat(QuantityPolicy.STOCK_DELTA.isSatisfiedBy(grams("0"))).isFalse();
        assertThat(rejection(() -> QuantityPolicy.STOCK_DELTA.require(grams("0")))).isEqualTo(Reason.OUT_OF_RANGE);
    }

    @Test
    void conversionItselfStillCarriesNegativeAndZeroValues() {
        MeasuredQuantity negative = new MeasuredQuantity(d("-2.5"), MeasurementUnit.KILOGRAM).to(MeasurementUnit.GRAM);
        assertThat(negative.amount()).isEqualTo(d("-2500"));
        assertThat(new MeasuredQuantity(BigDecimal.ZERO, MeasurementUnit.LITER).to(MeasurementUnit.MILLILITER).signum()).isEqualTo(0);
    }

    @Test
    void policyChecksTheValueRegardlessOfUnit() {
        assertThat(QuantityPolicy.SALE_QUANTITY.isSatisfiedBy(new MeasuredQuantity(d("0"), MeasurementUnit.KILOGRAM))).isFalse();
        assertThat(QuantityPolicy.SALE_QUANTITY.isSatisfiedBy(new MeasuredQuantity(d("0.0000001"), MeasurementUnit.KILOGRAM))).isTrue();
        assertThat(QuantityPolicy.SALE_QUANTITY.isSatisfiedBy(new MeasuredQuantity(d("3"), MeasurementUnit.PIECE))).isTrue();
    }

    @Test
    void nullIsNeverSatisfied() {
        for (QuantityPolicy policy : QuantityPolicy.values()) {
            assertThat(policy.isSatisfiedBy(null)).isFalse();
            assertThat(rejection(() -> policy.require(null))).isEqualTo(Reason.INVALID_QUANTITY);
        }
    }

    @Test
    void requireReturnsTheSameQuantity() {
        MeasuredQuantity quantity = grams("4");
        assertThat(QuantityPolicy.SALE_QUANTITY.require(quantity) == quantity).isTrue();
    }
}
