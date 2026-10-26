package rw.oupay.measurement;

import static org.assertj.core.api.Assertions.assertThat;
import static rw.oupay.measurement.Expect.d;
import static rw.oupay.measurement.Expect.rejection;

import java.math.BigDecimal;
import java.util.Random;
import org.junit.jupiter.api.Test;
import rw.oupay.measurement.MeasurementException.Reason;

class PackageConversionTest {

    private static final PackageConversion CARTON_OF_24 = PackageConversion.of(24, MeasurementUnit.PIECE);
    private static final PackageConversion BAG_OF_25_KG = PackageConversion.of(25, MeasurementUnit.KILOGRAM);
    private static final PackageConversion BOTTLE_750_ML = PackageConversion.of(750, MeasurementUnit.MILLILITER);

    @Test
    void definesWhatOnePackageHolds() {
        assertThat(CARTON_OF_24.dimension()).isEqualTo(MeasurementDimension.COUNT);
        assertThat(CARTON_OF_24.canonicalPerPackage()).isEqualTo(d("24"));
        assertThat(BAG_OF_25_KG.dimension()).isEqualTo(MeasurementDimension.MASS);
        assertThat(BAG_OF_25_KG.canonicalPerPackage()).isEqualTo(d("25000"));
        assertThat(BOTTLE_750_ML.dimension()).isEqualTo(MeasurementDimension.VOLUME);
        assertThat(BOTTLE_750_ML.canonicalPerPackage()).isEqualTo(d("750"));
        assertThat(PackageConversion.of(d("0.75"), MeasurementUnit.LITER)).isEqualTo(BOTTLE_750_ML);
    }

    @Test
    void differentProductsMayUseDifferentFactorsForTheSamePackageKind() {
        PackageConversion small = PackageConversion.of(12, MeasurementUnit.PIECE);
        PackageConversion large = PackageConversion.of(48, MeasurementUnit.PIECE);
        assertThat(small.toQuantity(d("2")).amount()).isEqualTo(d("24"));
        assertThat(large.toQuantity(d("2")).amount()).isEqualTo(d("96"));
    }

    @Test
    void convertsPackagesToCanonicalQuantities() {
        assertThat(CARTON_OF_24.toQuantity(d("3"))).isEqualTo(MeasuredQuantity.of(72, MeasurementUnit.PIECE));
        assertThat(BAG_OF_25_KG.toQuantity(d("2")).amount()).isEqualTo(d("50000"));
        assertThat(BAG_OF_25_KG.toQuantity(d("2")).unit()).isEqualTo(MeasurementUnit.GRAM);
        assertThat(BAG_OF_25_KG.toQuantity(d("0.5")).toString()).isEqualTo("12500 g");
        assertThat(BOTTLE_750_ML.toQuantity(d("6")).to(MeasurementUnit.LITER).amount()).isEqualTo(d("4.5"));
    }

    @Test
    void aFractionOfAPackageIsFineWhenItStaysWholePieces() {
        assertThat(CARTON_OF_24.toQuantity(d("1.5")).amount()).isEqualTo(d("36"));
        assertThat(CARTON_OF_24.toQuantity(d("0.25")).amount()).isEqualTo(d("6"));
    }

    @Test
    void neverCreatesAFractionalPhysicalPiece() {
        PackageConversion boxOf25 = PackageConversion.of(25, MeasurementUnit.PIECE);
        assertThat(rejection(() -> boxOf25.toQuantity(d("1.5")))).isEqualTo(Reason.INVALID_COUNT);
        assertThat(rejection(() -> CARTON_OF_24.toQuantity(d("0.1")))).isEqualTo(Reason.INVALID_COUNT);
        assertThat(rejection(() -> CARTON_OF_24.toQuantity(d("1.0000001")))).isEqualTo(Reason.INVALID_COUNT);
    }

    @Test
    void convertsQuantitiesBackToPackages() {
        assertThat(CARTON_OF_24.toPackages(MeasuredQuantity.of(72, MeasurementUnit.PIECE))).isEqualTo(d("3"));
        assertThat(CARTON_OF_24.toPackages(MeasuredQuantity.of(30, MeasurementUnit.PIECE))).isEqualTo(d("1.25"));
        assertThat(BAG_OF_25_KG.toPackages(new MeasuredQuantity(d("12.5"), MeasurementUnit.KILOGRAM))).isEqualTo(d("0.5"));
        assertThat(BAG_OF_25_KG.toPackages(MeasuredQuantity.of(50000, MeasurementUnit.GRAM))).isEqualTo(d("2"));
        assertThat(BOTTLE_750_ML.toPackages(new MeasuredQuantity(d("4.5"), MeasurementUnit.LITER))).isEqualTo(d("6"));
        assertThat(BOTTLE_750_ML.toPackages(MeasuredQuantity.of(0, MeasurementUnit.MILLILITER))).isEqualTo(d("0"));
    }

    @Test
    void rejectsAPackageCountThatIsNotRepresentableExactly() {
        // 25 / 24 = 1.041666..., a repeating decimal.
        assertThat(rejection(() -> CARTON_OF_24.toPackages(MeasuredQuantity.of(25, MeasurementUnit.PIECE))))
                .isEqualTo(Reason.PRECISION_EXCEEDED);
        PackageConversion thirds = PackageConversion.of(3, MeasurementUnit.PIECE);
        assertThat(rejection(() -> thirds.toPackages(MeasuredQuantity.of(1, MeasurementUnit.PIECE))))
                .isEqualTo(Reason.PRECISION_EXCEEDED);
        // 1 / 128 = 0.0078125 terminates but needs seven places.
        PackageConversion box128 = PackageConversion.of(128, MeasurementUnit.PIECE);
        assertThat(rejection(() -> box128.toPackages(MeasuredQuantity.of(1, MeasurementUnit.PIECE))))
                .isEqualTo(Reason.PRECISION_EXCEEDED);
        assertThat(box128.toPackages(MeasuredQuantity.of(2, MeasurementUnit.PIECE))).isEqualTo(d("0.015625"));
    }

    @Test
    void supportsExactDecimalFactors() {
        PackageConversion roll = PackageConversion.of(d("12.5"), MeasurementUnit.METER);
        assertThat(roll.canonicalPerPackage()).isEqualTo(d("12500"));
        assertThat(roll.toPackages(new MeasuredQuantity(d("6.25"), MeasurementUnit.METER))).isEqualTo(d("0.5"));
        PackageConversion pinch = new PackageConversion(MeasurementDimension.MASS, d("0.000001"));
        assertThat(pinch.toQuantity(d("1000000")).amount()).isEqualTo(d("1"));
        assertThat(PackageConversion.of(d("0.000001"), MeasurementUnit.GRAM).canonicalPerPackage()).isEqualTo(d("0.000001"));
    }

    @Test
    void factorScaleDoesNotMatter() {
        assertThat(new PackageConversion(MeasurementDimension.COUNT, d("24.000")))
                .isEqualTo(new PackageConversion(MeasurementDimension.COUNT, d("24")));
        assertThat(new PackageConversion(MeasurementDimension.COUNT, d("2.4E+1")).canonicalPerPackage()).isEqualTo(d("24"));
    }

    @Test
    void rejectsADimensionMismatch() {
        assertThat(rejection(() -> CARTON_OF_24.toPackages(MeasuredQuantity.of(24, MeasurementUnit.GRAM))))
                .isEqualTo(Reason.DIMENSION_MISMATCH);
        assertThat(rejection(() -> BAG_OF_25_KG.toPackages(MeasuredQuantity.of(25, MeasurementUnit.LITER))))
                .isEqualTo(Reason.DIMENSION_MISMATCH);
    }

    @Test
    void rejectsZeroNegativeAndMissingFactors() {
        for (MeasurementDimension dimension : MeasurementDimension.values()) {
            assertThat(rejection(() -> new PackageConversion(dimension, BigDecimal.ZERO))).isEqualTo(Reason.INVALID_PACKAGE_CONVERSION);
            assertThat(rejection(() -> new PackageConversion(dimension, d("0.000")))).isEqualTo(Reason.INVALID_PACKAGE_CONVERSION);
            assertThat(rejection(() -> new PackageConversion(dimension, d("-1")))).isEqualTo(Reason.INVALID_PACKAGE_CONVERSION);
            assertThat(rejection(() -> new PackageConversion(dimension, null))).isEqualTo(Reason.INVALID_PACKAGE_CONVERSION);
        }
        assertThat(rejection(() -> new PackageConversion(null, d("1")))).isEqualTo(Reason.INVALID_PACKAGE_CONVERSION);
        assertThat(rejection(() -> PackageConversion.of(0, MeasurementUnit.KILOGRAM))).isEqualTo(Reason.INVALID_PACKAGE_CONVERSION);
        assertThat(rejection(() -> PackageConversion.of(-25, MeasurementUnit.KILOGRAM))).isEqualTo(Reason.INVALID_PACKAGE_CONVERSION);
        assertThat(rejection(() -> PackageConversion.of(null, MeasurementUnit.KILOGRAM))).isEqualTo(Reason.INVALID_PACKAGE_CONVERSION);
        assertThat(rejection(() -> PackageConversion.of(BigDecimal.ONE, null))).isEqualTo(Reason.INVALID_PACKAGE_CONVERSION);
    }

    @Test
    void rejectsFactorsThatAreNotExactOrNotInRange() {
        assertThat(rejection(() -> new PackageConversion(MeasurementDimension.MASS, d("0.0000001"))))
                .isEqualTo(Reason.INVALID_PACKAGE_CONVERSION);
        assertThat(rejection(() -> new PackageConversion(MeasurementDimension.MASS, d("100000000000000"))))
                .isEqualTo(Reason.INVALID_PACKAGE_CONVERSION);
        assertThat(rejection(() -> PackageConversion.of(d("100000000000"), MeasurementUnit.KILOGRAM)))
                .isEqualTo(Reason.INVALID_PACKAGE_CONVERSION);
        assertThat(rejection(() -> PackageConversion.of(d("0.0000000001"), MeasurementUnit.KILOGRAM)))
                .isEqualTo(Reason.INVALID_PACKAGE_CONVERSION);
        assertThat(rejection(() -> new PackageConversion(MeasurementDimension.MASS, new BigDecimal("1E+999999999"))))
                .isEqualTo(Reason.INVALID_PACKAGE_CONVERSION);
    }

    @Test
    void aDiscretePackageMustContainWholePieces() {
        assertThat(rejection(() -> new PackageConversion(MeasurementDimension.COUNT, d("24.5"))))
                .isEqualTo(Reason.INVALID_PACKAGE_CONVERSION);
        assertThat(rejection(() -> PackageConversion.of(d("0.5"), MeasurementUnit.PIECE)))
                .isEqualTo(Reason.INVALID_PACKAGE_CONVERSION);
    }

    @Test
    void rejectsOverflowWhenMultiplyingPackages() {
        PackageConversion pallet = PackageConversion.of(50_000_000_000L, MeasurementUnit.PIECE);
        assertThat(pallet.toQuantity(d("1")).amount()).isEqualTo(d("50000000000"));
        assertThat(rejection(() -> pallet.toQuantity(d("2000")))).isEqualTo(Reason.OUT_OF_RANGE);
        assertThat(rejection(() -> CARTON_OF_24.toQuantity(new BigDecimal("1E+999999999")))).isEqualTo(Reason.OUT_OF_RANGE);
        assertThat(rejection(() -> CARTON_OF_24.toQuantity(null))).isEqualTo(Reason.INVALID_QUANTITY);
        assertThat(rejection(() -> CARTON_OF_24.toPackages(null))).isEqualTo(Reason.INVALID_QUANTITY);
    }

    @Test
    void packageRoundTripsAreExactWhenRepresentable() {
        Random random = new Random(99L);
        for (int i = 0; i < 2_000; i++) {
            long perPackage = random.nextLong(1, 5_000);
            long packages = random.nextLong(0, 1_000_000);
            PackageConversion conversion = PackageConversion.of(perPackage, MeasurementUnit.PIECE);
            MeasuredQuantity pieces = conversion.toQuantity(BigDecimal.valueOf(packages));
            assertThat(conversion.toPackages(pieces).compareTo(BigDecimal.valueOf(packages))).isEqualTo(0);

            PackageConversion mass = PackageConversion.of(BigDecimal.valueOf(perPackage, 3), MeasurementUnit.KILOGRAM);
            MeasuredQuantity grams = mass.toQuantity(BigDecimal.valueOf(packages));
            assertThat(mass.toPackages(grams).compareTo(BigDecimal.valueOf(packages))).isEqualTo(0);
        }
    }
}
