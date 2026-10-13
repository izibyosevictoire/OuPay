package rw.oupay.ledger;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import rw.oupay.ledger.LedgerMath.PaymentStatus;
import rw.oupay.ledger.LedgerMath.ReconciliationStatus;

/** Pure financial derivations: what "paid", "remaining" and "unapplied" mean. No database. */
class LedgerMathTest {

    @Test
    void anInvoiceIsUnpaidPartlyPaidOrPaidFromItsActiveAllocations() {
        assertThat(LedgerMath.summarize(50_000, 0).paymentStatus()).isEqualTo(PaymentStatus.UNPAID);
        var partial = LedgerMath.summarize(50_000, 20_000);
        assertThat(partial.paymentStatus()).isEqualTo(PaymentStatus.PARTIALLY_PAID);
        assertThat(partial.remainingBalance()).isEqualTo(30_000);
        var paid = LedgerMath.summarize(50_000, 50_000);
        assertThat(paid.paymentStatus()).isEqualTo(PaymentStatus.PAID);
        assertThat(paid.remainingBalance()).isZero();
    }

    @Test
    void reversingTheFirstPaymentRestoresTheBalance() {
        // 20,000 then 30,000 confirmed; the first is reversed, so only 30,000 counts.
        assertThat(LedgerMath.summarize(50_000, 20_000 + 30_000).paymentStatus()).isEqualTo(PaymentStatus.PAID);
        var afterReversal = LedgerMath.summarize(50_000, 30_000);
        assertThat(afterReversal.remainingBalance()).isEqualTo(20_000);
        assertThat(afterReversal.paymentStatus()).isEqualTo(PaymentStatus.PARTIALLY_PAID);
    }

    @Test
    void anOverpaymentIsVisibleAndNeverANegativeBalance() {
        var over = LedgerMath.summarize(10_000, 12_000);
        assertThat(over.paymentStatus()).isEqualTo(PaymentStatus.OVERPAID);
        assertThat(over.remainingBalance()).isZero();
        assertThat(over.unappliedAmount()).isEqualTo(2_000);
    }

    @Test
    void onlyConfirmedIncomingMoneyCanBeUnapplied() {
        assertThat(LedgerMath.unapplied(BankTransactionStatus.CONFIRMED, true, 10_000, 4_000)).isEqualTo(6_000);
        assertThat(LedgerMath.unapplied(BankTransactionStatus.CONFIRMED, true, 10_000, 10_000)).isZero();
        for (var status : new BankTransactionStatus[] {BankTransactionStatus.PENDING, BankTransactionStatus.FAILED, BankTransactionStatus.REVERSED}) {
            assertThat(LedgerMath.unapplied(status, true, 10_000, 0)).isZero();
        }
        assertThat(LedgerMath.unapplied(BankTransactionStatus.CONFIRMED, false, 10_000, 0)).isZero();
    }

    @Test
    void reconciliationStatusDistinguishesUnmatchedCollectedPartialAndFull() {
        assertThat(LedgerMath.reconciliationStatus(BankTransactionStatus.CONFIRMED, 100, 0, false)).isEqualTo(ReconciliationStatus.UNMATCHED);
        assertThat(LedgerMath.reconciliationStatus(BankTransactionStatus.CONFIRMED, 100, 0, true)).isEqualTo(ReconciliationStatus.COLLECTED);
        assertThat(LedgerMath.reconciliationStatus(BankTransactionStatus.CONFIRMED, 100, 40, false)).isEqualTo(ReconciliationStatus.PARTIALLY_ALLOCATED);
        assertThat(LedgerMath.reconciliationStatus(BankTransactionStatus.CONFIRMED, 100, 100, false)).isEqualTo(ReconciliationStatus.FULLY_ALLOCATED);
        assertThat(LedgerMath.reconciliationStatus(BankTransactionStatus.REVERSED, 100, 0, false)).isEqualTo(ReconciliationStatus.REVERSED);
        assertThat(LedgerMath.reconciliationStatus(BankTransactionStatus.PENDING, 100, 0, false)).isEqualTo(ReconciliationStatus.NOT_APPLICABLE);
    }

    @Test
    void reviewIsNeededForFlaggedOrUnmatchedConfirmedMoneyUntilSomeoneReviewsIt() {
        assertThat(LedgerMath.requiresReview(BankTransactionStatus.CONFIRMED, ReviewState.NEEDS_REVIEW, ReconciliationStatus.PARTIALLY_ALLOCATED)).isTrue();
        assertThat(LedgerMath.requiresReview(BankTransactionStatus.CONFIRMED, ReviewState.NONE, ReconciliationStatus.UNMATCHED)).isTrue();
        assertThat(LedgerMath.requiresReview(BankTransactionStatus.CONFIRMED, ReviewState.REVIEWED, ReconciliationStatus.UNMATCHED)).isFalse();
        assertThat(LedgerMath.requiresReview(BankTransactionStatus.CONFIRMED, ReviewState.NONE, ReconciliationStatus.COLLECTED)).isFalse();
        assertThat(LedgerMath.requiresReview(BankTransactionStatus.PENDING, ReviewState.NEEDS_REVIEW, ReconciliationStatus.NOT_APPLICABLE)).isFalse();
    }

    @Test
    void statusTransitionsAreExplicit() {
        assertThat(BankTransactionStatus.PENDING.allowedNext()).containsExactlyInAnyOrder(BankTransactionStatus.CONFIRMED, BankTransactionStatus.FAILED, BankTransactionStatus.REVERSED);
        assertThat(BankTransactionStatus.CONFIRMED.allowedNext()).containsExactly(BankTransactionStatus.REVERSED);
        assertThat(BankTransactionStatus.FAILED.allowedNext()).isEmpty();
        assertThat(BankTransactionStatus.REVERSED.allowedNext()).isEmpty();
        assertThat(BankTransactionStatus.CONFIRMED.canTransitionTo(BankTransactionStatus.PENDING)).isFalse();
    }
}
