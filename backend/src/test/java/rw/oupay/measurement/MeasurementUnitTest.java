package rw.oupay.measurement;

import static org.assertj.core.api.Assertions.assertThat;
import static rw.oupay.measurement.Expect.rejection;

import java.math.BigDecimal;
import org.junit.jupiter.api.Test;
import rw.oupay.measurement.MeasurementException.Reason;

class MeasurementUnitTest {

    @Test
    void everyUnitDeclaresItsDimensionAndExactCanonicalFactor() {
        assertThat(MeasurementUnit.PIECE.dimension()).isEqualTo(MeasurementDimension.COUNT);
        assertThat(MeasurementUnit.GRAM.dimension()).isEqualTo(MeasurementDimension.MASS);
        assertThat(MeasurementUnit.KILOGRAM.dimension()).isEqualTo(MeasurementDimension.MASS);
        assertThat(MeasurementUnit.MILLILITER.dimension()).isEqualTo(MeasurementDimension.VOLUME);
        assertThat(MeasurementUnit.LITER.dimension()).isEqualTo(MeasurementDimension.VOLUME);
        assertThat(MeasurementUnit.MILLIMETER.dimension()).isEqualTo(MeasurementDimension.LENGTH);
        assertThat(MeasurementUnit.METER.dimension()).isEqualTo(MeasurementDimension.LENGTH);
        assertThat(MeasurementUnit.SQUARE_MILLIMETER.dimension()).isEqualTo(MeasurementDimension.AREA);
        assertThat(MeasurementUnit.SQUARE_METER.dimension()).isEqualTo(MeasurementDimension.AREA);

        assertThat(MeasurementUnit.PIECE.canonicalFactor()).isEqualTo(BigDecimal.valueOf(1));
        assertThat(MeasurementUnit.GRAM.canonicalFactor()).isEqualTo(BigDecimal.valueOf(1));
        assertThat(MeasurementUnit.KILOGRAM.canonicalFactor()).isEqualTo(BigDecimal.valueOf(1_000));
        assertThat(MeasurementUnit.MILLILITER.canonicalFactor()).isEqualTo(BigDecimal.valueOf(1));
        assertThat(MeasurementUnit.LITER.canonicalFactor()).isEqualTo(BigDecimal.valueOf(1_000));
        assertThat(MeasurementUnit.MILLIMETER.canonicalFactor()).isEqualTo(BigDecimal.valueOf(1));
        assertThat(MeasurementUnit.METER.canonicalFactor()).isEqualTo(BigDecimal.valueOf(1_000));
        assertThat(MeasurementUnit.SQUARE_MILLIMETER.canonicalFactor()).isEqualTo(BigDecimal.valueOf(1));
        assertThat(MeasurementUnit.SQUARE_METER.canonicalFactor()).isEqualTo(BigDecimal.valueOf(1_000_000));
    }

    @Test
    void eachDimensionHasExactlyOneCanonicalUnit() {
        assertThat(MeasurementDimension.COUNT.canonicalUnit()).isEqualTo(MeasurementUnit.PIECE);
        assertThat(MeasurementDimension.MASS.canonicalUnit()).isEqualTo(MeasurementUnit.GRAM);
        assertThat(MeasurementDimension.VOLUME.canonicalUnit()).isEqualTo(MeasurementUnit.MILLILITER);
        assertThat(MeasurementDimension.LENGTH.canonicalUnit()).isEqualTo(MeasurementUnit.MILLIMETER);
        assertThat(MeasurementDimension.AREA.canonicalUnit()).isEqualTo(MeasurementUnit.SQUARE_MILLIMETER);
        for (MeasurementDimension dimension : MeasurementDimension.values()) {
            int canonical = 0;
            for (MeasurementUnit unit : MeasurementUnit.values()) {
                if (unit.dimension() == dimension && unit.isCanonical()) {
                    canonical++;
                }
            }
            assertThat(canonical).isEqualTo(1);
        }
    }

    @Test
    void onlyCountsMustBeWhole() {
        assertThat(MeasurementDimension.COUNT.wholeUnitsOnly()).isTrue();
        assertThat(MeasurementDimension.MASS.wholeUnitsOnly()).isFalse();
        assertThat(MeasurementDimension.VOLUME.wholeUnitsOnly()).isFalse();
        assertThat(MeasurementDimension.LENGTH.wholeUnitsOnly()).isFalse();
        assertThat(MeasurementDimension.AREA.wholeUnitsOnly()).isFalse();
    }

    @Test
    void looksUnitsUpByCodeIgnoringCase() {
        for (MeasurementUnit unit : MeasurementUnit.values()) {
            assertThat(MeasurementUnit.fromCode(unit.code())).isEqualTo(unit);
        }
        assertThat(MeasurementUnit.fromCode("KG")).isEqualTo(MeasurementUnit.KILOGRAM);
        assertThat(MeasurementUnit.fromCode("mL")).isEqualTo(MeasurementUnit.MILLILITER);
        assertThat(MeasurementUnit.fromCode("L")).isEqualTo(MeasurementUnit.LITER);
        assertThat(MeasurementUnit.fromCode(" m2 ")).isEqualTo(MeasurementUnit.SQUARE_METER);
    }

    @Test
    void rejectsUnknownUnits() {
        for (String code : new String[] {null, "", " ", "lb", "oz", "carton", "kg2", "m²", "gram; DROP"}) {
            assertThat(rejection(() -> MeasurementUnit.fromCode(code))).isEqualTo(Reason.UNSUPPORTED_UNIT);
        }
    }

    @Test
    void unitLookupDoesNotDependOnTheDefaultLocale() {
        java.util.Locale original = java.util.Locale.getDefault();
        try {
            // In a Turkish locale "I".toLowerCase() is a dotless i; the lookup must not be affected.
            java.util.Locale.setDefault(java.util.Locale.forLanguageTag("tr-TR"));
            assertThat(MeasurementUnit.fromCode("MM")).isEqualTo(MeasurementUnit.MILLIMETER);
            assertThat(MeasurementUnit.fromCode("KG")).isEqualTo(MeasurementUnit.KILOGRAM);
            assertThat(MeasuredQuantity.parse("1.5", "L").toString()).isEqualTo("1.5 l");
        } finally {
            java.util.Locale.setDefault(original);
        }
    }

    @Test
    void errorsCarryStableCodesAndDoNotEchoInput() {
        try {
            MeasurementUnit.fromCode("<script>");
        } catch (MeasurementException e) {
            assertThat(e.code()).isEqualTo("unsupported_unit");
            assertThat(e.status().value()).isEqualTo(422);
            assertThat(e.getMessage().contains("script")).isFalse();
            return;
        }
        throw new AssertionError("expected rejection");
    }
}
