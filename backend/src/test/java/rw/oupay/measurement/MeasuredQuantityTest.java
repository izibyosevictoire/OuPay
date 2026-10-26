package rw.oupay.measurement;

import static org.assertj.core.api.Assertions.assertThat;
import static rw.oupay.measurement.Expect.d;
import static rw.oupay.measurement.Expect.rejection;

import java.math.BigDecimal;
import java.util.Random;
import org.junit.jupiter.api.Test;
import rw.oupay.measurement.MeasurementException.Reason;

class MeasuredQuantityTest {

    private static MeasuredQuantity q(String amount, MeasurementUnit unit) {
        return new MeasuredQuantity(d(amount), unit);
    }

    private static void assertConverts(String amount, MeasurementUnit from, String expected, MeasurementUnit to) {
        MeasuredQuantity converted = q(amount, from).to(to);
        assertThat(converted).isEqualTo(q(expected, to));
        assertThat(converted.amount().compareTo(d(expected))).isEqualTo(0);
    }

    // --- required examples, both directions -------------------------------------------------------------

    @Test
    void convertsTheRequiredExamples() {
        assertConverts("2.5", MeasurementUnit.KILOGRAM, "2500", MeasurementUnit.GRAM);
        assertConverts("750", MeasurementUnit.GRAM, "0.75", MeasurementUnit.KILOGRAM);
        assertConverts("1.25", MeasurementUnit.LITER, "1250", MeasurementUnit.MILLILITER);
        assertConverts("0.5", MeasurementUnit.METER, "500", MeasurementUnit.MILLIMETER);
        assertConverts("1.5", MeasurementUnit.SQUARE_METER, "1500000", MeasurementUnit.SQUARE_MILLIMETER);
        assertConverts("0.25", MeasurementUnit.KILOGRAM, "250", MeasurementUnit.GRAM);
        assertConverts("0.75", MeasurementUnit.LITER, "750", MeasurementUnit.MILLILITER);
        assertConverts("2.5", MeasurementUnit.METER, "2500", MeasurementUnit.MILLIMETER);
        assertConverts("0.75", MeasurementUnit.SQUARE_METER, "750000", MeasurementUnit.SQUARE_MILLIMETER);
    }

    @Test
    void convertsEveryUnitInEveryDirection() {
        assertConverts("1", MeasurementUnit.KILOGRAM, "1000", MeasurementUnit.GRAM);
        assertConverts("1000", MeasurementUnit.GRAM, "1", MeasurementUnit.KILOGRAM);
        assertConverts("1", MeasurementUnit.LITER, "1000", MeasurementUnit.MILLILITER);
        assertConverts("1000", MeasurementUnit.MILLILITER, "1", MeasurementUnit.LITER);
        assertConverts("1", MeasurementUnit.METER, "1000", MeasurementUnit.MILLIMETER);
        assertConverts("1000", MeasurementUnit.MILLIMETER, "1", MeasurementUnit.METER);
        assertConverts("1", MeasurementUnit.SQUARE_METER, "1000000", MeasurementUnit.SQUARE_MILLIMETER);
        assertConverts("1000000", MeasurementUnit.SQUARE_MILLIMETER, "1", MeasurementUnit.SQUARE_METER);
        assertConverts("15", MeasurementUnit.PIECE, "15", MeasurementUnit.PIECE);
        for (MeasurementUnit unit : MeasurementUnit.values()) {
            assertConverts("7", unit, "7", unit);
        }
    }

    @Test
    void thereAreNoFloatingPointArtifacts() {
        // 0.1 + 0.2 style traps: conversions of "awkward" binary fractions stay exact.
        assertConverts("0.1", MeasurementUnit.KILOGRAM, "100", MeasurementUnit.GRAM);
        assertConverts("0.001", MeasurementUnit.KILOGRAM, "1", MeasurementUnit.GRAM);
        assertConverts("0.000001", MeasurementUnit.SQUARE_METER, "1", MeasurementUnit.SQUARE_MILLIMETER);
        assertConverts("1", MeasurementUnit.GRAM, "0.001", MeasurementUnit.KILOGRAM);
        assertConverts("1", MeasurementUnit.SQUARE_MILLIMETER, "0.000001", MeasurementUnit.SQUARE_METER);
    }

    // --- scale and numeric equality ---------------------------------------------------------------------

    @Test
    void valuesWithDifferentScalesAreTheSameQuantity() {
        assertThat(q("1", MeasurementUnit.GRAM)).isEqualTo(q("1.000000", MeasurementUnit.GRAM));
        assertThat(q("1", MeasurementUnit.GRAM).hashCode()).isEqualTo(q("1.000000", MeasurementUnit.GRAM).hashCode());
        assertThat(q("100", MeasurementUnit.GRAM)).isEqualTo(q("1E+2", MeasurementUnit.GRAM));
        assertThat(q("100", MeasurementUnit.GRAM).amount().scale()).isEqualTo(0);
        assertThat(q("0.000", MeasurementUnit.GRAM)).isEqualTo(q("0", MeasurementUnit.GRAM));
        assertThat(q("1.500", MeasurementUnit.KILOGRAM).amount().toPlainString()).isEqualTo("1.5");
    }

    @Test
    void valuesCompareAcrossUnitsOfOneDimension() {
        assertThat(q("1000", MeasurementUnit.GRAM).isNumericallyEqualTo(q("1", MeasurementUnit.KILOGRAM))).isTrue();
        assertThat(q("1.0", MeasurementUnit.KILOGRAM).isNumericallyEqualTo(q("1.000000", MeasurementUnit.KILOGRAM))).isTrue();
        assertThat(q("999", MeasurementUnit.GRAM).compareValue(q("1", MeasurementUnit.KILOGRAM))).isEqualTo(-1);
        assertThat(q("1001", MeasurementUnit.GRAM).compareValue(q("1", MeasurementUnit.KILOGRAM))).isEqualTo(1);
        assertThat(rejection(() -> q("1", MeasurementUnit.GRAM).compareValue(q("1", MeasurementUnit.MILLILITER))))
                .isEqualTo(Reason.DIMENSION_MISMATCH);
    }

    @Test
    void storageValueIsExactlyScaleSix() {
        assertThat(q("2.5", MeasurementUnit.KILOGRAM).storageValue().toPlainString()).isEqualTo("2500.000000");
        assertThat(q("1.123456", MeasurementUnit.GRAM).storageValue().toPlainString()).isEqualTo("1.123456");
        assertThat(q("0", MeasurementUnit.GRAM).storageValue().toPlainString()).isEqualTo("0.000000");
        assertThat(q("15", MeasurementUnit.PIECE).storageValue().toPlainString()).isEqualTo("15.000000");
    }

    // --- precision, judged on the canonical value --------------------------------------------------------

    @Test
    void sixDecimalsAreAcceptedAndSevenAreRejected() {
        assertThat(q("1.123456", MeasurementUnit.GRAM).canonicalAmount()).isEqualTo(d("1.123456"));
        assertThat(q("0.000001", MeasurementUnit.GRAM).canonicalAmount()).isEqualTo(d("0.000001"));
        assertThat(rejection(() -> q("1.1234567", MeasurementUnit.GRAM))).isEqualTo(Reason.PRECISION_EXCEEDED);
        assertThat(rejection(() -> q("0.0000001", MeasurementUnit.GRAM))).isEqualTo(Reason.PRECISION_EXCEEDED);
        assertThat(rejection(() -> q("0.0000001", MeasurementUnit.MILLILITER))).isEqualTo(Reason.PRECISION_EXCEEDED);
        assertThat(rejection(() -> q("0.0000001", MeasurementUnit.MILLIMETER))).isEqualTo(Reason.PRECISION_EXCEEDED);
        assertThat(rejection(() -> q("0.0000001", MeasurementUnit.SQUARE_MILLIMETER))).isEqualTo(Reason.PRECISION_EXCEEDED);
    }

    @Test
    void trailingZerosBeyondSixDecimalsDoNotCountAsPrecision() {
        assertThat(q("1.12345600000000", MeasurementUnit.GRAM)).isEqualTo(q("1.123456", MeasurementUnit.GRAM));
    }

    @Test
    void precisionIsEvaluatedAfterConversionNotOnTheInputScale() {
        // 0.0000001 kg is 0.1 g: seven input decimals, but exact in grams.
        MeasuredQuantity tiny = q("0.0000001", MeasurementUnit.KILOGRAM);
        assertThat(tiny.canonicalAmount()).isEqualTo(d("0.0001"));
        assertThat(q("0.000000001", MeasurementUnit.KILOGRAM).canonicalAmount()).isEqualTo(d("0.000001"));
        assertThat(rejection(() -> q("0.0000000001", MeasurementUnit.KILOGRAM))).isEqualTo(Reason.PRECISION_EXCEEDED);
        // The same twelve-decimal square metre value is the smallest exact one.
        assertThat(q("0.000000000001", MeasurementUnit.SQUARE_METER).canonicalAmount()).isEqualTo(d("0.000001"));
        assertThat(rejection(() -> q("0.0000000000001", MeasurementUnit.SQUARE_METER))).isEqualTo(Reason.PRECISION_EXCEEDED);
    }

    @Test
    void conversionNeverRoundsAResultThatDoesNotFit() {
        // 1 mm2 is exactly 0.000001 m2, but 0.5 mm2 is 0.0000005 m2: fine, it is exact at the target...
        assertThat(q("0.5", MeasurementUnit.SQUARE_MILLIMETER).to(MeasurementUnit.SQUARE_METER).amount())
                .isEqualTo(d("0.0000005"));
        // ...and the canonical form of a stored value can always be reached again.
        assertThat(q("0.0000005", MeasurementUnit.SQUARE_METER).to(MeasurementUnit.SQUARE_MILLIMETER).amount())
                .isEqualTo(d("0.5"));
    }

    // --- bounds -----------------------------------------------------------------------------------------

    @Test
    void acceptsTheLargestStorableValueAndRejectsOneMoreUnitInTheLastPlace() {
        assertThat(q("99999999999999.999999", MeasurementUnit.GRAM).storageValue().toPlainString())
                .isEqualTo("99999999999999.999999");
        assertThat(rejection(() -> q("100000000000000", MeasurementUnit.GRAM))).isEqualTo(Reason.OUT_OF_RANGE);
        assertThat(rejection(() -> q("99999999999999.9999991", MeasurementUnit.GRAM))).isEqualTo(Reason.OUT_OF_RANGE);
        assertThat(rejection(() -> q("99999999999998.9999991", MeasurementUnit.GRAM))).isEqualTo(Reason.PRECISION_EXCEEDED);
        assertThat(rejection(() -> q("-100000000000000", MeasurementUnit.GRAM))).isEqualTo(Reason.OUT_OF_RANGE);
        assertThat(q("-99999999999999.999999", MeasurementUnit.GRAM).signum()).isEqualTo(-1);
    }

    @Test
    void rejectsOverflowCreatedByConversionToTheCanonicalUnit() {
        // The bound applies to the canonical value, not to the number as typed.
        assertThat(rejection(() -> q("100000000000", MeasurementUnit.KILOGRAM))).isEqualTo(Reason.OUT_OF_RANGE);
        assertThat(q("99999999999", MeasurementUnit.KILOGRAM).canonicalAmount()).isEqualTo(d("99999999999000"));
        assertThat(rejection(() -> q("100000000", MeasurementUnit.SQUARE_METER))).isEqualTo(Reason.OUT_OF_RANGE);
        assertThat(q("99999999", MeasurementUnit.SQUARE_METER).canonicalAmount()).isEqualTo(d("99999999000000"));
    }

    @Test
    void rejectsVeryLargeAndVerySmallMagnitudesWithoutExpandingThem() {
        assertThat(rejection(() -> new MeasuredQuantity(new BigDecimal("1E+999999999"), MeasurementUnit.GRAM)))
                .isEqualTo(Reason.OUT_OF_RANGE);
        assertThat(rejection(() -> new MeasuredQuantity(new BigDecimal("-1E+999999999"), MeasurementUnit.PIECE)))
                .isEqualTo(Reason.OUT_OF_RANGE);
        assertThat(rejection(() -> new MeasuredQuantity(new BigDecimal("1E-999999999"), MeasurementUnit.GRAM)))
                .isEqualTo(Reason.PRECISION_EXCEEDED);
        assertThat(rejection(() -> new MeasuredQuantity(new BigDecimal("9".repeat(500)), MeasurementUnit.GRAM)))
                .isEqualTo(Reason.OUT_OF_RANGE);
        assertThat(new MeasuredQuantity(new BigDecimal("0E+999999999"), MeasurementUnit.GRAM).signum()).isEqualTo(0);
        assertThat(new MeasuredQuantity(new BigDecimal("1E+13"), MeasurementUnit.GRAM).amount().scale()).isEqualTo(0);
    }

    // --- counts -----------------------------------------------------------------------------------------

    @Test
    void countsMustBeWholePieces() {
        assertThat(q("1", MeasurementUnit.PIECE).signum()).isEqualTo(1);
        assertThat(q("15", MeasurementUnit.PIECE).amount()).isEqualTo(d("15"));
        assertThat(q("15.000", MeasurementUnit.PIECE).amount()).isEqualTo(d("15"));
        assertThat(q("1E+3", MeasurementUnit.PIECE).amount()).isEqualTo(d("1000"));
        assertThat(rejection(() -> q("1.5", MeasurementUnit.PIECE))).isEqualTo(Reason.INVALID_COUNT);
        assertThat(rejection(() -> q("0.5", MeasurementUnit.PIECE))).isEqualTo(Reason.INVALID_COUNT);
        assertThat(rejection(() -> q("0.000001", MeasurementUnit.PIECE))).isEqualTo(Reason.INVALID_COUNT);
        assertThat(rejection(() -> q("1.0000001", MeasurementUnit.PIECE))).isEqualTo(Reason.INVALID_COUNT);
        assertThat(rejection(() -> q("-2.5", MeasurementUnit.PIECE))).isEqualTo(Reason.INVALID_COUNT);
    }

    @Test
    void divisibleDimensionsAcceptSixDecimalValues() {
        assertThat(q("0.000001", MeasurementUnit.GRAM).signum()).isEqualTo(1);
        assertThat(q("0.000001", MeasurementUnit.MILLILITER).signum()).isEqualTo(1);
        assertThat(q("0.000001", MeasurementUnit.MILLIMETER).signum()).isEqualTo(1);
        assertThat(q("0.000001", MeasurementUnit.SQUARE_MILLIMETER).signum()).isEqualTo(1);
    }

    // --- dimensions and null handling -------------------------------------------------------------------

    @Test
    void rejectsConversionBetweenDimensions() {
        MeasurementUnit[] units = MeasurementUnit.values();
        for (MeasurementUnit from : units) {
            for (MeasurementUnit to : units) {
                if (from.dimension() != to.dimension()) {
                    assertThat(rejection(() -> q("1", from).to(to))).isEqualTo(Reason.DIMENSION_MISMATCH);
                }
            }
        }
    }

    @Test
    void rejectsNullAndUnsupportedInput() {
        assertThat(rejection(() -> new MeasuredQuantity(null, MeasurementUnit.GRAM))).isEqualTo(Reason.INVALID_QUANTITY);
        assertThat(rejection(() -> new MeasuredQuantity(BigDecimal.ONE, null))).isEqualTo(Reason.INVALID_QUANTITY);
        assertThat(rejection(() -> q("1", MeasurementUnit.GRAM).to(null))).isEqualTo(Reason.UNSUPPORTED_UNIT);
        assertThat(rejection(() -> q("1", MeasurementUnit.GRAM).compareValue(null))).isEqualTo(Reason.INVALID_QUANTITY);
        assertThat(rejection(() -> MeasuredQuantity.parse(null, MeasurementUnit.GRAM))).isEqualTo(Reason.INVALID_QUANTITY);
        assertThat(rejection(() -> MeasuredQuantity.parse("1", (MeasurementUnit) null))).isEqualTo(Reason.INVALID_QUANTITY);
        assertThat(rejection(() -> MeasuredQuantity.parse("1", "stone"))).isEqualTo(Reason.UNSUPPORTED_UNIT);
    }

    @Test
    void parsesOnlyPlainDecimalText() {
        assertThat(MeasuredQuantity.parse("2.5", "kg")).isEqualTo(q("2.5", MeasurementUnit.KILOGRAM));
        assertThat(MeasuredQuantity.parse(" 0.250 ", MeasurementUnit.KILOGRAM).amount()).isEqualTo(d("0.25"));
        assertThat(MeasuredQuantity.parse("-3", MeasurementUnit.GRAM).signum()).isEqualTo(-1);
        for (String bad : new String[] {"", " ", "NaN", "nan", "Infinity", "-Infinity", "+Infinity", "1e3", "1E+3", "+1",
                "1,5", "1 000", ".5", "5.", "--1", "1.2.3", "0x10", "١٢", "1٫5", "abc", "1_000"}) {
            assertThat(rejection(() -> MeasuredQuantity.parse(bad, MeasurementUnit.GRAM))).isEqualTo(Reason.INVALID_QUANTITY);
        }
    }

    // --- immutability and round trips -------------------------------------------------------------------

    @Test
    void conversionLeavesTheOriginalUntouched() {
        MeasuredQuantity original = q("2.5", MeasurementUnit.KILOGRAM);
        MeasuredQuantity converted = original.to(MeasurementUnit.GRAM);
        assertThat(original.amount()).isEqualTo(d("2.5"));
        assertThat(original.unit()).isEqualTo(MeasurementUnit.KILOGRAM);
        assertThat(converted.unit()).isEqualTo(MeasurementUnit.GRAM);
        assertThat(original.toCanonical()).isEqualTo(converted);
    }

    @Test
    void roundTripsAreExactForRandomValuesInEveryDivisibleUnitPair() {
        Random random = new Random(20260526L);
        MeasurementUnit[][] pairs = {
            {MeasurementUnit.GRAM, MeasurementUnit.KILOGRAM},
            {MeasurementUnit.MILLILITER, MeasurementUnit.LITER},
            {MeasurementUnit.MILLIMETER, MeasurementUnit.METER},
            {MeasurementUnit.SQUARE_MILLIMETER, MeasurementUnit.SQUARE_METER},
        };
        for (MeasurementUnit[] pair : pairs) {
            for (int i = 0; i < 2_000; i++) {
                // A random canonical amount with up to 6 decimals and up to 13 integral digits.
                BigDecimal canonical = new BigDecimal(java.math.BigInteger.valueOf(random.nextLong(1, 10_000_000_000_000_000L)), 6);
                MeasuredQuantity small = new MeasuredQuantity(canonical, pair[0]);
                MeasuredQuantity big = small.to(pair[1]);
                assertThat(big.to(pair[0])).isEqualTo(small);
                assertThat(big.canonicalAmount().compareTo(canonical)).isEqualTo(0);
                assertThat(big.isNumericallyEqualTo(small)).isTrue();
                assertThat(big.storageValue().compareTo(canonical)).isEqualTo(0);
            }
        }
    }

    @Test
    void conversionIsConsistentWithPlainDecimalArithmetic() {
        Random random = new Random(7L);
        for (int i = 0; i < 2_000; i++) {
            BigDecimal kilograms = new BigDecimal(java.math.BigInteger.valueOf(random.nextLong(0, 100_000_000_000L)), 3);
            MeasuredQuantity grams = new MeasuredQuantity(kilograms, MeasurementUnit.KILOGRAM).to(MeasurementUnit.GRAM);
            assertThat(grams.amount().compareTo(kilograms.multiply(BigDecimal.valueOf(1000)))).isEqualTo(0);
        }
    }
}
