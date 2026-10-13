package rw.oupay.payment;

import java.time.Instant;
import java.util.List;
import rw.oupay.invoice.InvoiceStatus;
import rw.oupay.ledger.BankTransactionStatus;
import rw.oupay.ledger.LedgerMath;

/**
 * A payment request's status is DERIVED from the ledger on every read, never stored, so it can
 * never disagree with bank transactions or invoice balances. Pure and unit-testable.
 *
 * <p>Expiry only means "no longer collecting". It never implies bank money was returned: money
 * that was confirmed stays confirmed and is still counted, even after expiry.
 */
public final class PaymentRequestState {

    private PaymentRequestState() {}

    public enum Status { CREATED, AWAITING_PAYMENT, PARTIALLY_SETTLED, SETTLED, EXPIRED, CANCELLED }

    /** The four things a customer must never confuse are kept apart; these are the bank-side stages. */
    public enum Stage {
        AWAITING_PAYMENT, BANK_CONFIRMATION_PENDING, CONFIRMED_AND_RECONCILED, CONFIRMED_UNMATCHED, PARTIALLY_SETTLED,
        FAILED, EXPIRED, REVERSED, CANCELLED
    }

    public record LinkedTransaction(BankTransactionStatus status, boolean incoming, long amountRwf, boolean hasActiveAllocation) {}

    public record InvoiceFacts(InvoiceStatus status, long grandTotal, long allocated) {}

    public record Request(long requestedAmountRwf, Instant expiresAt, Instant cancelledAt, boolean opened, boolean claimed) {}

    public record State(Status status, Stage stage, long confirmedAmount, long amountDue) {}

    public static State derive(Request request, List<LinkedTransaction> linked, InvoiceFacts invoice, Instant now) {
        List<LinkedTransaction> confirmed = linked.stream()
                .filter(t -> t.status() == BankTransactionStatus.CONFIRMED && t.incoming()).toList();
        long confirmedAmount = confirmed.stream().mapToLong(LinkedTransaction::amountRwf).sum();
        Long invoiceRemaining = invoice == null ? null : LedgerMath.summarize(invoice.grandTotal(), invoice.allocated()).remainingBalance();
        long amountDue = invoiceRemaining != null ? invoiceRemaining : Math.max(request.requestedAmountRwf() - confirmedAmount, 0);

        boolean invoiceClosed = invoice != null && (invoice.status() == InvoiceStatus.VOIDED || invoice.status() == InvoiceStatus.CANCELLED);
        if (request.cancelledAt() != null || invoiceClosed) {
            return new State(Status.CANCELLED, Stage.CANCELLED, confirmedAmount, amountDue);
        }
        if (confirmedAmount > 0) {
            boolean settled = invoice != null ? invoiceRemaining == 0 : confirmedAmount >= request.requestedAmountRwf();
            if (!settled) {
                return new State(Status.PARTIALLY_SETTLED, Stage.PARTIALLY_SETTLED, confirmedAmount, amountDue);
            }
            // Settled. For an invoice it is reconciled by definition; an open payment is only "reconciled"
            // once its money has been applied, otherwise it is an unmatched collection.
            boolean applied = invoice != null || confirmed.stream().allMatch(LinkedTransaction::hasActiveAllocation);
            return new State(Status.SETTLED, applied ? Stage.CONFIRMED_AND_RECONCILED : Stage.CONFIRMED_UNMATCHED, confirmedAmount, amountDue);
        }
        if (linked.stream().anyMatch(t -> t.status() == BankTransactionStatus.REVERSED)) {
            return new State(Status.AWAITING_PAYMENT, Stage.REVERSED, confirmedAmount, amountDue);
        }
        if (linked.stream().anyMatch(t -> t.status() == BankTransactionStatus.PENDING)) {
            return new State(Status.AWAITING_PAYMENT, Stage.BANK_CONFIRMATION_PENDING, confirmedAmount, amountDue);
        }
        if (linked.stream().anyMatch(t -> t.status() == BankTransactionStatus.FAILED)) {
            return new State(Status.AWAITING_PAYMENT, Stage.FAILED, confirmedAmount, amountDue);
        }
        if (!request.expiresAt().isAfter(now)) {
            return new State(Status.EXPIRED, Stage.EXPIRED, confirmedAmount, amountDue);
        }
        return new State(request.opened() || request.claimed() ? Status.AWAITING_PAYMENT : Status.CREATED, Stage.AWAITING_PAYMENT,
                confirmedAmount, amountDue);
    }
}
