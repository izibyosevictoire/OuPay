package rw.oupay.pos;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * The small in-process worker that posts paid POS sales to the stock ledger. It runs on the existing scheduler (no external infrastructure) and
 * only ever calls {@link PosFulfilmentService#processDue}, which is safe to run from any number of instances at once: the database locks and
 * unique keys, not this class, are what prevent a double deduction. It runs AFTER payment allocations have committed and never inside the
 * bank-event transaction. Tests switch it off and call the service themselves, so every outcome is deterministic.
 */
@Component
public class PosFulfilmentWorker {

    private static final Logger log = LoggerFactory.getLogger(PosFulfilmentWorker.class);

    private final PosFulfilmentService fulfilments;
    private final boolean enabled;
    private final int batchSize;

    public PosFulfilmentWorker(PosFulfilmentService fulfilments, @Value("${oupay.pos.fulfilment.enabled:true}") boolean enabled,
                               @Value("${oupay.pos.fulfilment.batch-size:25}") int batchSize) {
        this.fulfilments = fulfilments;
        this.enabled = enabled;
        this.batchSize = Math.max(1, batchSize);
    }

    @Scheduled(fixedDelayString = "${oupay.pos.fulfilment.poll-interval:15s}")
    void poll() {
        if (!enabled) {
            return;
        }
        try {
            PosFulfilmentService.Summary summary = fulfilments.processDue(batchSize);
            if (summary.posted() + summary.exceptions() + summary.reversals() + summary.failed() > 0) {
                log.info("POS fulfilment: {} posted, {} exceptions, {} reversals recorded, {} failed", summary.posted(), summary.exceptions(), summary.reversals(),
                        summary.failed());
            }
        } catch (RuntimeException e) {
            log.error("POS fulfilment run failed", e);
        }
    }
}
