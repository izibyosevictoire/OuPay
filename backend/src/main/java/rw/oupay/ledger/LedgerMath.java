package rw.oupay.ledger;

/**
 * PURE LEDGER DERIVATIONS (no database, no framework): one place defines what "paid", "remaining"
 * and "unapplied" mean. Port of the frontend's {@code lib/ledger.ts}; this copy is authoritative.
 */
public final class LedgerMath {

    private LedgerMath() {}

    public enum PaymentStatus { UNPAID, PARTIALLY_PAID, PAID, OVERPAID }

    public enum ReconciliationStatus { NOT_APPLICABLE, UNMATCHED, COLLECTED, PARTIALLY_ALLOCATED, FULLY_ALLOCATED, REVERSED }

    /** Invoice payment information derived from the sum of its ACTIVE allocations. */
    public record InvoicePayment(long invoiceTotal, long allocatedAmount, long remainingBalance,
                                 long unappliedAmount, PaymentStatus paymentStatus) {}

    /**
     * remaining = total - allocated (never negative); status follows the remaining balance. A
     * reversed allocation simply stops counting, which restores the balance.
     */
    public static InvoicePayment summarize(long invoiceTotal, long activeAllocated) {
        long remaining = Math.max(invoiceTotal - activeAllocated, 0);
        long surplus = Math.max(activeAllocated - invoiceTotal, 0);
        PaymentStatus status;
        if (activeAllocated <= 0) {
            status = PaymentStatus.UNPAID;
        } else if (surplus > 0) {
            status = PaymentStatus.OVERPAID;
        } else if (remaining > 0) {
            status = PaymentStatus.PARTIALLY_PAID;
        } else {
            status = PaymentStatus.PAID;
        }
        return new InvoicePayment(invoiceTotal, activeAllocated, remaining, surplus, status);
    }

    /** Confirmed money not (or no longer) applied to any invoice. Zero for unconfirmed money. */
    public static long unapplied(BankTransactionStatus status, boolean incoming, long amount, long activeAllocated) {
        if (status != BankTransactionStatus.CONFIRMED || !incoming) {
            return 0;
        }
        return Math.max(amount - activeAllocated, 0);
    }

    public static ReconciliationStatus reconciliationStatus(BankTransactionStatus status, long amount,
                                                           long activeAllocated, boolean linkedToRequest) {
        if (status == BankTransactionStatus.REVERSED) {
            return ReconciliationStatus.REVERSED;
        }
        if (status != BankTransactionStatus.CONFIRMED) {
            return ReconciliationStatus.NOT_APPLICABLE;
        }
        if (activeAllocated <= 0) {
            return linkedToRequest ? ReconciliationStatus.COLLECTED : ReconciliationStatus.UNMATCHED;
        }
        return activeAllocated >= amount ? ReconciliationStatus.FULLY_ALLOCATED : ReconciliationStatus.PARTIALLY_ALLOCATED;
    }

    /** Transactions a person should look at: flagged ones, and confirmed money nobody has matched. */
    public static boolean requiresReview(BankTransactionStatus status, ReviewState reviewState, ReconciliationStatus reconciliation) {
        if (status != BankTransactionStatus.CONFIRMED) {
            return false;
        }
        if (reviewState == ReviewState.NEEDS_REVIEW) {
            return true;
        }
        if (reviewState == ReviewState.REVIEWED) {
            return false;
        }
        return reconciliation == ReconciliationStatus.UNMATCHED;
    }
}
