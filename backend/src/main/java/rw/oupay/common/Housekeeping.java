package rw.oupay.common;

import java.sql.Timestamp;
import java.time.Clock;
import java.time.Duration;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Removes data that has no further value, so security-sensitive tables do not grow without bound:
 * dead sessions, spent or expired account links, and delivered mail records. Financial and audit tables
 * are NEVER touched (they are append-only by design). Safe to run on several instances: each statement is
 * an idempotent DELETE.
 */
@Component
public class Housekeeping {

    private static final Logger log = LoggerFactory.getLogger(Housekeeping.class);

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

    /** Returns the number of rows removed per table, in the order sessions, links, sent mail, failed mail. */
    public int[] runOnce() {
        Timestamp sessionCutoff = Timestamp.from(clock.instant().minus(Duration.ofDays(7)));
        Timestamp linkCutoff = Timestamp.from(clock.instant().minus(Duration.ofDays(30)));
        Timestamp mailCutoff = Timestamp.from(clock.instant().minus(Duration.ofDays(30)));
        Timestamp failedMailCutoff = Timestamp.from(clock.instant().minus(Duration.ofDays(90)));
        int sessions = jdbc.sql("delete from auth_sessions where absolute_expires_at < :c or revoked_at < :c").param("c", sessionCutoff).update();
        int links = jdbc.sql("delete from account_tokens where expires_at < :c or used_at < :c").param("c", linkCutoff).update();
        int sent = jdbc.sql("delete from email_outbox where status = 'SENT' and sent_at < :c").param("c", mailCutoff).update();
        int failed = jdbc.sql("delete from email_outbox where status = 'FAILED' and updated_at < :c").param("c", failedMailCutoff).update();
        log.info("housekeeping removed sessions={} accountLinks={} sentMail={} failedMail={}", sessions, links, sent, failed);
        return new int[] {sessions, links, sent, failed};
    }
}
