package rw.oupay.common;

import java.sql.Timestamp;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Removes data that has no further value, so security-sensitive tables do not grow without bound:
 * dead sessions, spent or expired account links, delivered mail records and old HTTP idempotency records.
 * Financial and audit tables are NEVER touched (they are append-only by design), and neither are bank events or
 * the durable identifiers that guard against duplicate operations. Safe to run on several instances: each statement is
 * an idempotent DELETE, and the idempotency pruning locks its rows with SKIP LOCKED.
 */
@Component
public class Housekeeping {

    private static final Logger log = LoggerFactory.getLogger(Housekeeping.class);

    /**
     * How long a replayed HTTP response stays available. Fixed here, never a merchant setting. Longer than any client
     * retry window; the permanent duplicate guards live on the business rows, not on these records (docs/idempotency.md).
     */
    static final Duration IDEMPOTENCY_RETENTION = Duration.ofDays(30);
    /** Rows removed per statement, and statements per run: bounded work, short transactions, no long locks. */
    private static final int IDEMPOTENCY_BATCH_SIZE = 500;
    private static final int IDEMPOTENCY_MAX_BATCHES_PER_RUN = 20;

    private final JdbcClient jdbc;
    private final Clock clock;
    private final boolean enabled;

    public Housekeeping(JdbcClient jdbc, Clock clock, @Value("${oupay.housekeeping.enabled:true}") boolean enabled) {
        this.jdbc = jdbc;
        this.clock = clock;
        this.enabled = enabled;
    }

    @Scheduled(cron = "${oupay.housekeeping.cron:0 17 3 * * *}")
    void scheduled() {
        if (!enabled) {
            return;
        }
        try {
            runOnce();
        } catch (RuntimeException e) {
            log.error("housekeeping failed", e);
        }
    }

    /**
     * Returns the number of rows removed per table, in the order sessions, links, sent mail, failed mail,
     * idempotency records.
     */
    public int[] runOnce() {
        Timestamp sessionCutoff = Timestamp.from(clock.instant().minus(Duration.ofDays(7)));
        Timestamp linkCutoff = Timestamp.from(clock.instant().minus(Duration.ofDays(30)));
        Timestamp mailCutoff = Timestamp.from(clock.instant().minus(Duration.ofDays(30)));
        Timestamp failedMailCutoff = Timestamp.from(clock.instant().minus(Duration.ofDays(90)));
        int sessions = jdbc.sql("delete from auth_sessions where absolute_expires_at < :c or revoked_at < :c").param("c", sessionCutoff).update();
        int links = jdbc.sql("delete from account_tokens where expires_at < :c or used_at < :c").param("c", linkCutoff).update();
        int sent = jdbc.sql("delete from email_outbox where status = 'SENT' and sent_at < :c").param("c", mailCutoff).update();
        int failed = jdbc.sql("delete from email_outbox where status = 'FAILED' and updated_at < :c").param("c", failedMailCutoff).update();
        int idempotency = pruneIdempotencyKeys(clock.instant().minus(IDEMPOTENCY_RETENTION));
        log.info("housekeeping removed sessions={} accountLinks={} sentMail={} failedMail={} idempotencyKeys={}",
                sessions, links, sent, failed, idempotency);
        return new int[] {sessions, links, sent, failed, idempotency};
    }

    /**
     * Deletes idempotency records older than {@code cutoff}, oldest first, in bounded batches that each commit on their
     * own. Every committed record is complete (a deferred trigger guarantees it) and a record of an operation still in
     * flight is not visible to this statement, so only finished work is ever removed. The rows are locked with SKIP
     * LOCKED, so several instances pruning at once take different rows instead of waiting for each other.
     */
    int pruneIdempotencyKeys(Instant cutoff) {
        int total = 0;
        for (int batch = 0; batch < IDEMPOTENCY_MAX_BATCHES_PER_RUN; batch++) {
            int removed = jdbc.sql("delete from idempotency_keys k using ("
                            + "select merchant_id, scope, idem_key from idempotency_keys where created_at < :cutoff "
                            + "order by created_at limit :batch for update skip locked) expired "
                            + "where k.merchant_id = expired.merchant_id and k.scope = expired.scope and k.idem_key = expired.idem_key")
                    .param("cutoff", Timestamp.from(cutoff)).param("batch", IDEMPOTENCY_BATCH_SIZE).update();
            total += removed;
            if (removed < IDEMPOTENCY_BATCH_SIZE) {
                break;
            }
        }
        return total;
    }
}
