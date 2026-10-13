package rw.oupay.payment;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Instant;
import java.util.List;
import org.junit.jupiter.api.Test;
import rw.oupay.invoice.InvoiceStatus;
import rw.oupay.ledger.BankTransactionStatus;
import rw.oupay.payment.PaymentRequestState.InvoiceFacts;
import rw.oupay.payment.PaymentRequestState.LinkedTransaction;
import rw.oupay.payment.PaymentRequestState.Stage;
import rw.oupay.payment.PaymentRequestState.Status;

class PaymentRequestStateTest {

    static final Instant NOW = Instant.parse("2026-10-12T10:00:00Z");

    private static PaymentRequestState.Request open(long amount) {
        return new PaymentRequestState.Request(amount, NOW.plusSeconds(1_800), null, false, false);
    }

    private static LinkedTransaction tx(BankTransactionStatus status, long amount, boolean allocated) {
        return new LinkedTransaction(status, true, amount, allocated);
    }

    @Test
    void anUntouchedRequestIsCreatedThenAwaitingOnceOpenedOrClaimed() {
        assertThat(PaymentRequestState.derive(open(5_000), List.of(), null, NOW).status()).isEqualTo(Status.CREATED);
        var opened = new PaymentRequestState.Request(5_000, NOW.plusSeconds(60), null, true, false);
        assertThat(PaymentRequestState.derive(opened, List.of(), null, NOW).status()).isEqualTo(Status.AWAITING_PAYMENT);
        var claimed = new PaymentRequestState.Request(5_000, NOW.plusSeconds(60), null, false, true);
        var state = PaymentRequestState.derive(claimed, List.of(), null, NOW);
        // A claim never advances the bank-side stage.
        assertThat(state.stage()).isEqualTo(Stage.AWAITING_PAYMENT);
        assertThat(state.confirmedAmount()).isZero();
    }

    @Test
    void pendingFailedAndReversedMoneyNeverCountAsPaid() {
        for (var entry : List.of(
                java.util.Map.entry(BankTransactionStatus.PENDING, Stage.BANK_CONFIRMATION_PENDING),
                java.util.Map.entry(BankTransactionStatus.FAILED, Stage.FAILED),
                java.util.Map.entry(BankTransactionStatus.REVERSED, Stage.REVERSED))) {
            var state = PaymentRequestState.derive(open(5_000), List.of(tx(entry.getKey(), 5_000, false)), null, NOW);
            assertThat(state.stage()).isEqualTo(entry.getValue());
            assertThat(state.confirmedAmount()).isZero();
            assertThat(state.status()).isEqualTo(Status.AWAITING_PAYMENT);
        }
    }

    @Test
    void anOpenPaymentIsPartlySettledThenSettledButOnlyReconciledOnceApplied() {
        var partial = PaymentRequestState.derive(open(10_000), List.of(tx(BankTransactionStatus.CONFIRMED, 4_000, false)), null, NOW);
        assertThat(partial.status()).isEqualTo(Status.PARTIALLY_SETTLED);
        assertThat(partial.amountDue()).isEqualTo(6_000);
        var collected = PaymentRequestState.derive(open(10_000), List.of(tx(BankTransactionStatus.CONFIRMED, 10_000, false)), null, NOW);
        assertThat(collected.status()).isEqualTo(Status.SETTLED);
        assertThat(collected.stage()).isEqualTo(Stage.CONFIRMED_UNMATCHED);
        var applied = PaymentRequestState.derive(open(10_000), List.of(tx(BankTransactionStatus.CONFIRMED, 10_000, true)), null, NOW);
        assertThat(applied.stage()).isEqualTo(Stage.CONFIRMED_AND_RECONCILED);
    }

    @Test
    void anInvoiceRequestFollowsTheInvoiceBalance() {
        var invoice = new InvoiceFacts(InvoiceStatus.ISSUED, 50_000, 20_000);
        var partial = PaymentRequestState.derive(open(50_000), List.of(tx(BankTransactionStatus.CONFIRMED, 20_000, true)), invoice, NOW);
        assertThat(partial.status()).isEqualTo(Status.PARTIALLY_SETTLED);
        assertThat(partial.amountDue()).isEqualTo(30_000);
        var settled = PaymentRequestState.derive(open(50_000), List.of(tx(BankTransactionStatus.CONFIRMED, 50_000, true)),
                new InvoiceFacts(InvoiceStatus.ISSUED, 50_000, 50_000), NOW);
        assertThat(settled.stage()).isEqualTo(Stage.CONFIRMED_AND_RECONCILED);
        assertThat(settled.amountDue()).isZero();
    }

    @Test
    void closedInvoicesAndCancellationWinOverEverythingElse() {
        for (var status : new InvoiceStatus[] {InvoiceStatus.VOIDED, InvoiceStatus.CANCELLED}) {
            assertThat(PaymentRequestState.derive(open(5_000), List.of(), new InvoiceFacts(status, 5_000, 0), NOW).stage()).isEqualTo(Stage.CANCELLED);
        }
        var cancelled = new PaymentRequestState.Request(5_000, NOW.plusSeconds(60), NOW, false, false);
        assertThat(PaymentRequestState.derive(cancelled, List.of(), null, NOW).status()).isEqualTo(Status.CANCELLED);
    }

    @Test
    void expiryStopsCollectionButNeverUndoesConfirmedMoney() {
        var expired = new PaymentRequestState.Request(5_000, NOW.minusSeconds(1), null, false, false);
        assertThat(PaymentRequestState.derive(expired, List.of(), null, NOW).status()).isEqualTo(Status.EXPIRED);
        var paidThenExpired = PaymentRequestState.derive(expired, List.of(tx(BankTransactionStatus.CONFIRMED, 5_000, false)), null, NOW);
        assertThat(paidThenExpired.status()).isEqualTo(Status.SETTLED);
        assertThat(paidThenExpired.confirmedAmount()).isEqualTo(5_000);
    }
}
