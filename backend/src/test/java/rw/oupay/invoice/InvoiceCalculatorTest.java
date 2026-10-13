package rw.oupay.invoice;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.math.BigDecimal;
import java.util.List;
import java.util.Random;
import org.junit.jupiter.api.Test;
import rw.oupay.invoice.InvoiceCalculator.LineInput;
import rw.oupay.invoice.InvoiceCalculator.TaxCategory;
import rw.oupay.invoice.InvoiceCalculator.TaxMode;

class InvoiceCalculatorTest {

    private static LineInput line(long milli, long price, long discount, TaxCategory category, int rate) {
        return new LineInput("item", milli, price, discount, category, rate);
    }

    @Test
    void roundsHalfUpExactlyOncePerLine() {
        assertThat(InvoiceCalculator.mulDivRound(1, 1, 2)).isEqualTo(1);     // 0.5 -> 1
        assertThat(InvoiceCalculator.mulDivRound(1, 1, 3)).isZero();         // 0.33 -> 0
        assertThat(InvoiceCalculator.mulDivRound(2, 1, 3)).isEqualTo(1);     // 0.67 -> 1
        assertThat(InvoiceCalculator.mulDivRound(5, 1, 10)).isEqualTo(1);
        assertThat(InvoiceCalculator.mulDivRound(Long.MAX_VALUE / 2, 2, 2)).isEqualTo(Long.MAX_VALUE / 2);
    }

    @Test
    void exclusivePricingAddsTaxOnTop() {
        // 10 x 12,500 = 125,000 + 18% = 22,500
        var line = InvoiceCalculator.line(line(10_000, 12_500, 0, TaxCategory.STANDARD, 1800), TaxMode.EXCLUSIVE);
        assertThat(line.gross()).isEqualTo(125_000);
        assertThat(line.taxAmount()).isEqualTo(22_500);
        assertThat(line.netAmount()).isEqualTo(125_000);
        assertThat(line.lineTotal()).isEqualTo(147_500);
    }

    @Test
    void inclusivePricingExtractsTheTaxAlreadyInside() {
        var line = InvoiceCalculator.line(line(12_000, 6_000, 0, TaxCategory.STANDARD, 1800), TaxMode.INCLUSIVE);
        assertThat(line.lineTotal()).isEqualTo(72_000);
        assertThat(line.taxAmount()).isEqualTo(10_983);
        assertThat(line.netAmount()).isEqualTo(72_000 - 10_983);
    }

    @Test
    void discountsAreClampedAndTaxIsOnTheDiscountedAmount() {
        var line = InvoiceCalculator.line(line(1_000, 1_000, 5_000, TaxCategory.STANDARD, 1800), TaxMode.EXCLUSIVE);
        assertThat(line.discount()).isEqualTo(1_000);          // never below zero
        assertThat(line.lineTotal()).isZero();
        var partial = InvoiceCalculator.line(line(3_000, 22_000, 3_000, TaxCategory.STANDARD, 1800), TaxMode.EXCLUSIVE);
        assertThat(partial.taxAmount()).isEqualTo(11_340);     // 18% of 63,000
    }

    @Test
    void nonTaxableCategoriesAlwaysUseAZeroRate() {
        for (TaxCategory category : List.of(TaxCategory.NOT_APPLICABLE, TaxCategory.EXEMPT, TaxCategory.ZERO_RATED)) {
            var line = InvoiceCalculator.line(line(1_000, 10_000, 0, category, 1800), TaxMode.EXCLUSIVE);
            assertThat(line.taxAmount()).isZero();
        }
    }

    @Test
    void quantitiesKeepThreeDecimalsExactly() {
        assertThat(InvoiceCalculator.toMilli(new BigDecimal("1.005"))).isEqualTo(1005);
        assertThat(InvoiceCalculator.toMilli(new BigDecimal("2"))).isEqualTo(2000);
        assertThat(InvoiceCalculator.decimals(new BigDecimal("1.2500"))).isEqualTo(2);
        assertThat(InvoiceCalculator.decimals(new BigDecimal("1.2345"))).isEqualTo(4);
        assertThat(InvoiceCalculator.line(line(1_500, 1_001, 0, TaxCategory.NOT_APPLICABLE, 0), TaxMode.EXCLUSIVE).gross()).isEqualTo(1_502);
    }

    @Test
    void totalsAreAPlainSumOfAlreadyRoundedLinesAndSatisfyTheIdentity() {
        Random random = new Random(42);
        for (int run = 0; run < 2_000; run++) {
            int count = 1 + random.nextInt(8);
            var inputs = new java.util.ArrayList<LineInput>();
            for (int i = 0; i < count; i++) {
                long price = random.nextInt(2_000_000);
                long milli = 1 + random.nextInt(50_000);
                long discount = random.nextBoolean() ? random.nextInt(100_000) : 0;
                TaxCategory category = TaxCategory.values()[random.nextInt(4)];
                inputs.add(line(milli, price, discount, category, random.nextInt(2_500)));
            }
            for (TaxMode mode : TaxMode.values()) {
                var result = InvoiceCalculator.calculate(inputs, mode);
                assertThat(InvoiceCalculator.isConsistent(result, mode)).as("run %d %s", run, mode).isTrue();
                assertThat(result.lines().stream().mapToLong(InvoiceCalculator.Line::lineTotal).sum()).isEqualTo(result.grandTotal());
                assertThat(result.lines()).allSatisfy(l -> {
                    assertThat(l.netAmount() + l.taxAmount()).isEqualTo(l.lineTotal());
                    assertThat(l.netAmount()).isGreaterThanOrEqualTo(0);
                    assertThat(l.taxAmount()).isGreaterThanOrEqualTo(0);
                });
            }
        }
    }

    @Test
    void overflowFailsLoudlyInsteadOfWrappingAround() {
        var huge = List.of(line(1_000_000_000L, Long.MAX_VALUE / 1_000, 0, TaxCategory.NOT_APPLICABLE, 0),
                line(1_000_000_000L, Long.MAX_VALUE / 1_000, 0, TaxCategory.NOT_APPLICABLE, 0));
        assertThatThrownBy(() -> InvoiceCalculator.calculate(huge, TaxMode.EXCLUSIVE)).isInstanceOf(ArithmeticException.class);
    }
}
