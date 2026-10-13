package rw.oupay.ledger;

import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

/**
 * Financial observability: counters for every bank event outcome and every ledger movement, plus a
 * structured log line per event ({@code financial_event type=... }). Nothing here ever records a payer
 * name, a payment reference, an account or a payload: ids, amounts and outcomes only.
 *
 * <p>Emission is deferred until the surrounding transaction COMMITS, so a rolled-back change is never
 * counted as money moved.
 */
@Component
public class FinancialMetrics {

    private static final Logger log = LoggerFactory.getLogger("rw.oupay.financial");

    private final MeterRegistry meters;

    public FinancialMetrics(MeterRegistry meters, JdbcClient jdbc) {
        this.meters = meters;
        Gauge.builder("oupay.ledger.transactions.needing_review", jdbc, j -> count(j, "select count(*) from bank_transactions where review_state = 'NEEDS_REVIEW'"))
                .description("Bank transactions flagged for a person to review")
                .register(meters);
    }

    private static double count(JdbcClient jdbc, String sql) {
        try {
            return jdbc.sql(sql).query(Long.class).single();
        } catch (RuntimeException e) {
            return Double.NaN;
        }
    }

    public void bankEvent(String provider, String outcome, UUID merchantId, UUID transactionId) {
        afterCommit(() -> {
            meters.counter("oupay.bank.events", "provider", provider, "outcome", outcome).increment();
            log.info("financial_event type=bank_event provider={} outcome={} merchant={} transaction={}", provider, outcome, merchantId, transactionId);
        });
    }

    public void replayMismatch(String provider, UUID merchantId) {
        afterCommit(() -> {
            meters.counter("oupay.bank.events.payload_mismatch", "provider", provider).increment();
            log.warn("financial_event type=replay_payload_mismatch provider={} merchant={}", provider, merchantId);
        });
    }

    public void allocated(String origin, long amountRwf, UUID merchantId, UUID transactionId, UUID invoiceId) {
        afterCommit(() -> {
            meters.counter("oupay.ledger.allocations", "origin", origin).increment();
            meters.counter("oupay.ledger.allocated.rwf", "origin", origin).increment(amountRwf);
            log.info("financial_event type=allocated origin={} amountRwf={} merchant={} transaction={} invoice={}", origin, amountRwf,
                    merchantId, transactionId, invoiceId);
        });
    }

    public void reversed(String kind, long amountRwf, UUID merchantId, UUID transactionId, UUID invoiceId) {
        afterCommit(() -> {
            meters.counter("oupay.ledger.reversals", "kind", kind).increment();
            meters.counter("oupay.ledger.reversed.rwf", "kind", kind).increment(amountRwf);
            log.info("financial_event type=reversed kind={} amountRwf={} merchant={} transaction={} invoice={}", kind, amountRwf,
                    merchantId, transactionId, invoiceId);
        });
    }

    public void flaggedForReview(UUID merchantId, UUID transactionId) {
        afterCommit(() -> {
            meters.counter("oupay.ledger.review_flags").increment();
            log.warn("financial_event type=flagged_for_review merchant={} transaction={}", merchantId, transactionId);
        });
    }

    private static void afterCommit(Runnable action) {
        if (TransactionSynchronizationManager.isSynchronizationActive()) {
            TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                @Override
                public void afterCommit() {
                    action.run();
                }
            });
        } else {
            action.run();
        }
    }
}
