package rw.oupay.invoice;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.math.RoundingMode;
import java.util.ArrayList;
import java.util.List;

/**
 * INVOICE ARITHMETIC: integers only, with one explicit rounding rule. A port of the frontend's
 * {@code invoiceCalculations.ts}, but this is the AUTHORITATIVE copy: the server recomputes every
 * amount and never trusts totals from a client.
 *
 * <p>Units: amounts are whole RWF (exponent 0). Quantity is held in thousandths so up to three
 * decimal places multiply exactly. Tax rates are basis points (1800 = 18%). Products and quotients
 * use BigInteger, so there is no float error and no overflow.
 *
 * <p>Rounding: every division rounds HALF UP on a non-negative value, ONCE PER LINE. Invoice totals
 * are plain sums of already-rounded line values, so what is printed always adds up exactly.
 * <pre>
 *   gross = round(unitPrice x quantity)
 *   base  = gross - discount
 *   EXCLUSIVE: tax = round(base x rate / 10000), net = base,       total = base + tax
 *   INCLUSIVE: tax = round(base x rate / (10000 + rate)), net = base - tax, total = base
 * </pre>
 */
public final class InvoiceCalculator {

    public static final int BASIS_POINTS = 10_000;
    public static final int QUANTITY_SCALE = 1000;
    public static final int MAX_QUANTITY_DECIMALS = 3;

    private InvoiceCalculator() {}

    public enum TaxMode { EXCLUSIVE, INCLUSIVE }

    public enum TaxCategory { NOT_APPLICABLE, EXEMPT, ZERO_RATED, STANDARD }

    /** What a user enters for a line. */
    public record LineInput(String description, long quantityMilli, long unitPrice, long discount,
                            TaxCategory taxCategory, int taxRateBp) {}

    public record Line(String description, long quantityMilli, long unitPrice, long gross, long discount,
                       TaxCategory taxCategory, int taxRateBp, long netAmount, long taxAmount, long lineTotal) {}

    public record Result(List<Line> lines, long subtotal, long discountTotal, long taxTotal, long grandTotal) {}

    /** round-half-up(a x b / c) for non-negative integers, exactly. */
    public static long mulDivRound(long a, long b, long c) {
        BigInteger numerator = BigInteger.valueOf(a).multiply(BigInteger.valueOf(b));
        BigInteger denominator = BigInteger.valueOf(c);
        return numerator.multiply(BigInteger.TWO).add(denominator).divide(denominator.multiply(BigInteger.TWO)).longValueExact();
    }

    /** Converts a decimal quantity to thousandths; more than three decimal places is rejected by the caller. */
    public static long toMilli(BigDecimal quantity) {
        return quantity.setScale(MAX_QUANTITY_DECIMALS, RoundingMode.HALF_UP).movePointRight(MAX_QUANTITY_DECIMALS).longValueExact();
    }

    public static int decimals(BigDecimal quantity) {
        return Math.max(quantity.stripTrailingZeros().scale(), 0);
    }

    /** The rate that actually applies: non-taxable categories are always 0, whatever rateBp says. */
    public static int effectiveRateBp(TaxCategory category, int rateBp) {
        return category == TaxCategory.STANDARD ? rateBp : 0;
    }

    public static Line line(LineInput input, TaxMode mode) {
        long gross = mulDivRound(input.unitPrice(), input.quantityMilli(), QUANTITY_SCALE);
        // A discount can never push a line below zero.
        long discount = Math.min(input.discount(), gross);
        long base = gross - discount;
        int rate = effectiveRateBp(input.taxCategory(), input.taxRateBp());
        if (mode == TaxMode.INCLUSIVE) {
            long tax = mulDivRound(base, rate, (long) BASIS_POINTS + rate);
            return new Line(input.description(), input.quantityMilli(), input.unitPrice(), gross, discount,
                    input.taxCategory(), input.taxRateBp(), base - tax, tax, base);
        }
        long tax = mulDivRound(base, rate, BASIS_POINTS);
        return new Line(input.description(), input.quantityMilli(), input.unitPrice(), gross, discount,
                input.taxCategory(), input.taxRateBp(), base, tax, base + tax);
    }

    public static Result calculate(List<LineInput> inputs, TaxMode mode) {
        List<Line> lines = new ArrayList<>(inputs.size());
        long subtotal = 0;
        long discountTotal = 0;
        long taxTotal = 0;
        long grandTotal = 0;
        for (LineInput input : inputs) {
            Line line = line(input, mode);
            lines.add(line);
            subtotal = Math.addExact(subtotal, line.gross());
            discountTotal = Math.addExact(discountTotal, line.discount());
            taxTotal = Math.addExact(taxTotal, line.taxAmount());
            grandTotal = Math.addExact(grandTotal, line.lineTotal());
        }
        return new Result(lines, subtotal, discountTotal, taxTotal, grandTotal);
    }

    /** True when the totals satisfy the documented identity for their tax mode. */
    public static boolean isConsistent(Result result, TaxMode mode) {
        long expected = mode == TaxMode.EXCLUSIVE
                ? result.subtotal() - result.discountTotal() + result.taxTotal()
                : result.subtotal() - result.discountTotal();
        return result.grandTotal() == expected;
    }
}
