package rw.oupay.measurement;

import static org.assertj.core.api.Assertions.assertThat;
import static rw.oupay.measurement.Expect.d;
import static rw.oupay.measurement.Expect.rejection;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;
import rw.oupay.measurement.MeasurementException.Reason;

/** Canonical-versus-display precision, safety against extreme BigDecimal input, and value-object semantics. */
class MeasurementPrecisionTest {

    private static MeasuredQuantity q(String amount, MeasurementUnit unit) {
        return new MeasuredQuantity(d(amount), unit);
    }

    // --- canonical precision versus display-unit precision ----------------------------------------------

    @Test
    void aDisplayUnitMayNeedMoreThanSixDecimalsWhenTheCanonicalValueIsExact() {
        MeasuredQuantity microgram = q("0.000001", MeasurementUnit.GRAM);
        MeasuredQuantity inKilograms = microgram.to(MeasurementUnit.KILOGRAM);
        assertThat(inKilograms.amount()).isEqualTo(d("0.000000001"));
        assertThat(inKilograms.amount().scale()).isEqualTo(9);
        assertThat(inKilograms.to(MeasurementUnit.GRAM)).isEqualTo(microgram);
        assertThat(inKilograms.storageValue().toPlainString()).isEqualTo("0.000001");
        assertThat(inKilograms.toCanonical()).isEqualTo(microgram);
    }

    @Test
    void everyDivisibleDimensionKeepsItsSmallestCanonicalValueExactInTheLargeUnit() {
        assertRoundTrip("0.000001", MeasurementUnit.MILLILITER, MeasurementUnit.LITER, "0.000000001");
        assertRoundTrip("0.000001", MeasurementUnit.MILLIMETER, MeasurementUnit.METER, "0.000000001");
        assertRoundTrip("0.000001", MeasurementUnit.SQUARE_MILLIMETER, MeasurementUnit.SQUARE_METER, "0.000000000001");
        assertRoundTrip("99999999999999.999999", MeasurementUnit.GRAM, MeasurementUnit.KILOGRAM, "99999999999.999999999");
    }

    private static void assertRoundTrip(String canonical, MeasurementUnit small, MeasurementUnit large, String inLarge) {
        MeasuredQuantity original = q(canonical, small);
        MeasuredQuantity converted = original.to(large);
        assertThat(converted.amount()).isEqualTo(d(inLarge));
        assertThat(converted.to(small)).isEqualTo(original);
        assertThat(converted.storageValue().toPlainString()).isEqualTo(original.storageValue().toPlainString());
    }

    @Test
    void precisionIsCheckedOnTheCanonicalValueOnly() {
        // 0.0000001 kg = 0.0001 g: valid. 0.0000001 g: not representable in NUMERIC(20,6).
        assertThat(q("0.0000001", MeasurementUnit.KILOGRAM).toCanonical().amount()).isEqualTo(d("0.0001"));
        assertThat(rejection(() -> q("0.0000001", MeasurementUnit.GRAM))).isEqualTo(Reason.PRECISION_EXCEEDED);
        // The conversion that would produce a sub-storage canonical value is the one rejected, not the display scale.
        assertThat(rejection(() -> q("0.0000000001", MeasurementUnit.KILOGRAM))).isEqualTo(Reason.PRECISION_EXCEEDED);
        assertThat(q("0.000000001", MeasurementUnit.KILOGRAM).storageValue().toPlainString()).isEqualTo("0.000001");
    }

    @Test
    void parsingHasNoDigitCountCap() {
        // A long run of trailing zeros is a valid exact value.
        String longZeros = "1.5" + "0".repeat(500);
        assertThat(MeasuredQuantity.parse(longZeros, MeasurementUnit.GRAM)).isEqualTo(q("1.5", MeasurementUnit.GRAM));
        // ...while a genuinely over-precise one is still rejected, by the canonical rule rather than a length cap.
        assertThat(rejection(() -> MeasuredQuantity.parse("0." + "0".repeat(300) + "1", MeasurementUnit.GRAM)))
                .isEqualTo(Reason.PRECISION_EXCEEDED);
        assertThat(rejection(() -> MeasuredQuantity.parse("9".repeat(41), MeasurementUnit.GRAM))).isEqualTo(Reason.OUT_OF_RANGE);
    }

    // --- extreme programmatic BigDecimal input ----------------------------------------------------------

    private static final BigDecimal HUGE = new BigDecimal(BigInteger.ONE, Integer.MIN_VALUE);
    private static final BigDecimal TINY = new BigDecimal(BigInteger.ONE, Integer.MAX_VALUE);
    /** Stripping zeros from this would push the scale below Integer.MIN_VALUE. */
    private static final BigDecimal STRIP_UNDERFLOW = new BigDecimal(BigInteger.TEN, Integer.MIN_VALUE);

    @Test
    void extremeExponentsAreRejectedWithADomainError() {
        for (MeasurementUnit unit : MeasurementUnit.values()) {
            assertThat(rejection(() -> new MeasuredQuantity(HUGE, unit))).isEqualTo(Reason.OUT_OF_RANGE);
            assertThat(rejection(() -> new MeasuredQuantity(HUGE.negate(), unit))).isEqualTo(Reason.OUT_OF_RANGE);
            assertThat(rejection(() -> new MeasuredQuantity(STRIP_UNDERFLOW, unit))).isEqualTo(Reason.OUT_OF_RANGE);
        }
        assertThat(rejection(() -> new MeasuredQuantity(TINY, MeasurementUnit.GRAM))).isEqualTo(Reason.PRECISION_EXCEEDED);
        assertThat(rejection(() -> new MeasuredQuantity(TINY, MeasurementUnit.KILOGRAM))).isEqualTo(Reason.PRECISION_EXCEEDED);
        assertThat(rejection(() -> new MeasuredQuantity(TINY, MeasurementUnit.PIECE))).isEqualTo(Reason.INVALID_COUNT);
    }

    @Test
    void zeroWithAnExtremeScaleIsJustZero() {
        assertThat(new MeasuredQuantity(new BigDecimal(BigInteger.ZERO, Integer.MAX_VALUE), MeasurementUnit.GRAM).signum()).isEqualTo(0);
        assertThat(new MeasuredQuantity(new BigDecimal(BigInteger.ZERO, Integer.MIN_VALUE), MeasurementUnit.PIECE).amount())
                .isEqualTo(BigDecimal.ZERO);
    }

    @Test
    void extremePackageInputIsRejectedWithADomainError() {
        PackageConversion carton = PackageConversion.of(24, MeasurementUnit.PIECE);
        PackageConversion halfGram = PackageConversion.of(d("0.5"), MeasurementUnit.GRAM);
        assertThat(rejection(() -> carton.toQuantity(HUGE))).isEqualTo(Reason.OUT_OF_RANGE);
        assertThat(rejection(() -> carton.toQuantity(STRIP_UNDERFLOW))).isEqualTo(Reason.OUT_OF_RANGE);
        assertThat(rejection(() -> carton.toQuantity(TINY))).isEqualTo(Reason.INVALID_COUNT);
        // 1E-2147483647 x 0.5 overflows the scale arithmetic itself.
        assertThat(rejection(() -> halfGram.toQuantity(TINY))).isEqualTo(Reason.PRECISION_EXCEEDED);
        for (MeasurementDimension dimension : MeasurementDimension.values()) {
            assertThat(rejection(() -> new PackageConversion(dimension, HUGE))).isEqualTo(Reason.INVALID_PACKAGE_CONVERSION);
            assertThat(rejection(() -> new PackageConversion(dimension, TINY))).isEqualTo(Reason.INVALID_PACKAGE_CONVERSION);
            assertThat(rejection(() -> new PackageConversion(dimension, STRIP_UNDERFLOW))).isEqualTo(Reason.INVALID_PACKAGE_CONVERSION);
        }
        assertThat(rejection(() -> PackageConversion.of(HUGE, MeasurementUnit.GRAM))).isEqualTo(Reason.INVALID_PACKAGE_CONVERSION);
        assertThat(rejection(() -> PackageConversion.of(TINY, MeasurementUnit.GRAM))).isEqualTo(Reason.INVALID_PACKAGE_CONVERSION);
    }

    @Test
    void nonTerminatingAndInexactResultsAreDomainErrors() {
        PackageConversion carton = PackageConversion.of(24, MeasurementUnit.PIECE);
        PackageConversion third = PackageConversion.of(3, MeasurementUnit.PIECE);
        assertThat(rejection(() -> carton.toPackages(MeasuredQuantity.of(25, MeasurementUnit.PIECE)))).isEqualTo(Reason.PRECISION_EXCEEDED);
        assertThat(rejection(() -> third.toPackages(MeasuredQuantity.of(1, MeasurementUnit.PIECE)))).isEqualTo(Reason.PRECISION_EXCEEDED);
        assertThat(rejection(() -> third.toPackages(MeasuredQuantity.of(2, MeasurementUnit.PIECE)))).isEqualTo(Reason.PRECISION_EXCEEDED);
    }

    // --- discrete pieces and packaging ------------------------------------------------------------------

    @Test
    void packageConversionsKeepTheDimensionAndNeverRoundDiscreteContents() {
        assertThat(PackageConversion.of(24, MeasurementUnit.PIECE).toQuantity(d("1.5"))).isEqualTo(MeasuredQuantity.of(36, MeasurementUnit.PIECE));
        assertThat(rejection(() -> PackageConversion.of(25, MeasurementUnit.PIECE).toQuantity(d("1.5")))).isEqualTo(Reason.INVALID_COUNT);
        assertThat(PackageConversion.of(d("0.75"), MeasurementUnit.LITER).toQuantity(d("2")).unit()).isEqualTo(MeasurementUnit.MILLILITER);
        assertThat(PackageConversion.of(d("1.2"), MeasurementUnit.METER).toQuantity(d("2")).unit()).isEqualTo(MeasurementUnit.MILLIMETER);
        assertThat(PackageConversion.of(d("0.5"), MeasurementUnit.SQUARE_METER).toQuantity(d("3")).amount()).isEqualTo(d("1500000"));
        assertThat(PackageConversion.of(d("0.5"), MeasurementUnit.SQUARE_METER).toQuantity(d("3")).unit()).isEqualTo(MeasurementUnit.SQUARE_MILLIMETER);
        // A fractional package count of a divisible product is not restricted by generic arithmetic.
        assertThat(PackageConversion.of(25, MeasurementUnit.KILOGRAM).toQuantity(d("0.3333")).amount()).isEqualTo(d("8332.5"));
    }

    // --- equality, hashing and comparison ---------------------------------------------------------------

    @Test
    void equalQuantitiesWorkAsSetMembersAndMapKeys() {
        Set<MeasuredQuantity> set = new HashSet<>();
        set.add(q("1", MeasurementUnit.GRAM));
        set.add(q("1.000000", MeasurementUnit.GRAM));
        set.add(q("1E+0", MeasurementUnit.GRAM));
        set.add(q("0.001", MeasurementUnit.KILOGRAM));
        assertThat(set.size()).isEqualTo(2);

        Map<MeasuredQuantity, String> map = new HashMap<>();
        map.put(q("2.50", MeasurementUnit.KILOGRAM), "bag");
        assertThat(map.get(q("2.5", MeasurementUnit.KILOGRAM))).isEqualTo("bag");
        assertThat(map.get(q("2.500000", MeasurementUnit.KILOGRAM))).isEqualTo("bag");
        assertThat(map.containsKey(q("2500", MeasurementUnit.GRAM))).isFalse();
        assertThat(q("0.000", MeasurementUnit.GRAM).hashCode()).isEqualTo(q("0", MeasurementUnit.GRAM).hashCode());
    }

    @Test
    void recordEqualityIsUnitSensitiveWhileExplicitComparisonIsNot() {
        MeasuredQuantity grams = q("1000", MeasurementUnit.GRAM);
        MeasuredQuantity kilogram = q("1", MeasurementUnit.KILOGRAM);
        assertThat(grams.equals(kilogram)).isFalse();
        assertThat(grams.isNumericallyEqualTo(kilogram)).isTrue();
        assertThat(kilogram.isNumericallyEqualTo(grams)).isTrue();
        assertThat(grams.compareValue(kilogram)).isEqualTo(0);
        assertThat(grams.equals(null)).isFalse();
    }

    @Test
    void explicitComparisonOrdersQuantitiesAcrossUnits() {
        List<MeasuredQuantity> quantities = new ArrayList<>(List.of(
                q("1.5", MeasurementUnit.KILOGRAM), q("999", MeasurementUnit.GRAM), q("0.0015", MeasurementUnit.KILOGRAM),
                q("1000", MeasurementUnit.GRAM)));
        quantities.sort(MeasuredQuantity::compareValue);
        assertThat(quantities.get(0)).isEqualTo(q("0.0015", MeasurementUnit.KILOGRAM));
        assertThat(quantities.get(1)).isEqualTo(q("999", MeasurementUnit.GRAM));
        assertThat(quantities.get(2)).isEqualTo(q("1000", MeasurementUnit.GRAM));
        assertThat(quantities.get(3)).isEqualTo(q("1.5", MeasurementUnit.KILOGRAM));
    }

    @Test
    void comparisonHandlesNullAndMismatchedDimensionsIntentionally() {
        MeasuredQuantity grams = q("1", MeasurementUnit.GRAM);
        assertThat(rejection(() -> grams.compareValue(null))).isEqualTo(Reason.INVALID_QUANTITY);
        assertThat(rejection(() -> grams.isNumericallyEqualTo(q("1", MeasurementUnit.MILLILITER)))).isEqualTo(Reason.DIMENSION_MISMATCH);
        assertThat(rejection(() -> grams.isNumericallyEqualTo(q("1", MeasurementUnit.PIECE)))).isEqualTo(Reason.DIMENSION_MISMATCH);
    }

    @Test
    void valueObjectsExposeNoMutableState() {
        MeasuredQuantity quantity = q("2.5", MeasurementUnit.KILOGRAM);
        BigDecimal exposed = quantity.amount();
        quantity.to(MeasurementUnit.GRAM);
        quantity.storageValue();
        assertThat(quantity.amount() == exposed).isTrue();
        assertThat(quantity).isEqualTo(q("2.5", MeasurementUnit.KILOGRAM));
        PackageConversion conversion = PackageConversion.of(25, MeasurementUnit.KILOGRAM);
        conversion.toQuantity(d("2"));
        assertThat(conversion).isEqualTo(PackageConversion.of(25, MeasurementUnit.KILOGRAM));
    }
}
