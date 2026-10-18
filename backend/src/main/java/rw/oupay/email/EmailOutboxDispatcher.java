package rw.oupay.email;

import io.micrometer.core.instrument.MeterRegistry;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;
import rw.oupay.common.Masking;

/**
 * Delivers outbox messages. Safe to run on several instances at once: due rows are claimed with
 * {@code FOR UPDATE SKIP LOCKED} and leased, so two dispatchers never send the same message, and a
 * dispatcher that dies mid-send leaves a lease that expires so the message is picked up again.
 *
 * <p>Failures are retried with exponential backoff up to {@code max-attempts}, then the message is
 * marked FAILED (visible in the health endpoint, the metrics and the table). The body is erased as soon
 * as a message is SENT or FAILED, because it contains a one-time link.
 */
@Component
public class EmailOutboxDispatcher {

    private static final Logger log = LoggerFactory.getLogger(EmailOutboxDispatcher.class);

    private record Claimed(UUID id, String kind, String recipient, String subject, String text, String html,
                           int attempts, int maxAttempts) {}

    private final JdbcClient jdbc;
    private final TransactionTemplate transactions;
    private final EmailSender sender;
    private final EmailProperties properties;
    private final MeterRegistry meters;
    private final Clock clock;

    public EmailOutboxDispatcher(JdbcClient jdbc, TransactionTemplate transactions, EmailSender sender,
                                 EmailProperties properties, MeterRegistry meters, Clock clock) {
        this.jdbc = jdbc;
        this.transactions = transactions;
        this.sender = sender;
        this.properties = properties;
        this.meters = meters;
        this.clock = clock;
    }

    @Scheduled(fixedDelayString = "${oupay.email.dispatcher.poll-interval:5s}")
    void poll() {
        if (!properties.dispatcher().enabled()) {
            return;
        }
        try {
            dispatchDue();
        } catch (RuntimeException e) {
            log.error("email dispatcher run failed", e);
        }
    }

    /** Sends every message that is due. Returns how many were delivered. */
    public int dispatchDue() {
        List<Claimed> batch = transactions.execute(status -> claim());
        int delivered = 0;
        if (batch == null) {
            return 0;
        }
        for (Claimed message : batch) {
            if (deliver(message)) {
                delivered++;
            }
        }
        return delivered;
    }

    private List<Claimed> claim() {
        Instant now = clock.instant();
        EmailProperties.Dispatcher cfg = properties.dispatcher();
        return jdbc.sql("with due as (select id from email_outbox "
                        + "where (status = 'PENDING' and next_attempt_at <= :now) or (status = 'SENDING' and locked_until < :now) "
                        + "order by next_attempt_at, id limit :n for update skip locked) "
                        + "update email_outbox o set status = 'SENDING', attempts = o.attempts + 1, locked_until = :lease, updated_at = :now "
                        + "from due where o.id = due.id "
                        + "returning o.id, o.kind, o.recipient, o.subject, o.body_text, o.body_html, o.attempts, o.max_attempts")
                .param("now", Timestamp.from(now)).param("n", cfg.batchSize()).param("lease", Timestamp.from(now.plus(cfg.lease())))
                .query((rs, row) -> new Claimed(rs.getObject("id", UUID.class), rs.getString("kind"), rs.getString("recipient"),
                        rs.getString("subject"), rs.getString("body_text"), rs.getString("body_html"),
                        rs.getInt("attempts"), rs.getInt("max_attempts")))
                .list();
    }

    private boolean deliver(Claimed m) {
        try {
            sender.send(new EmailMessage(m.id(), m.recipient(), properties.from(), m.subject(), m.text(), m.html()));
        } catch (EmailDeliveryException | RuntimeException e) {
            recordFailure(m, e);
            return false;
        }
        Timestamp now = Timestamp.from(clock.instant());
        jdbc.sql("update email_outbox set status = 'SENT', sent_at = :now, updated_at = :now, locked_until = null, last_error = null, "
                        + "body_text = null, body_html = null where id = :id")
                .param("now", now).param("id", m.id()).update();
        meters.counter("oupay.email.outbox", "result", "sent", "kind", m.kind()).increment();
        log.info("email sent kind={} to={} attempt={}", m.kind(), Masking.email(m.recipient()), m.attempts());
        return true;
    }

    private void recordFailure(Claimed m, Exception e) {
        Instant now = clock.instant();
        String error = e.getClass().getSimpleName() + ": " + (e.getMessage() == null ? "" : e.getMessage());
        error = error.length() > 300 ? error.substring(0, 300) : error;
        if (m.attempts() >= m.maxAttempts()) {
            jdbc.sql("update email_outbox set status = 'FAILED', updated_at = :now, locked_until = null, last_error = :err, "
                            + "body_text = null, body_html = null where id = :id")
                    .param("now", Timestamp.from(now)).param("err", error).param("id", m.id()).update();
            meters.counter("oupay.email.outbox", "result", "failed", "kind", m.kind()).increment();
            log.error("email delivery gave up kind={} to={} attempts={} error={}", m.kind(), Masking.email(m.recipient()),
                    m.attempts(), e.getClass().getSimpleName());
            return;
        }
        Instant next = now.plus(backoff(m.attempts()));
        jdbc.sql("update email_outbox set status = 'PENDING', updated_at = :now, locked_until = null, last_error = :err, "
                        + "next_attempt_at = :next where id = :id")
                .param("now", Timestamp.from(now)).param("err", error).param("next", Timestamp.from(next)).param("id", m.id()).update();
        meters.counter("oupay.email.outbox", "result", "retry", "kind", m.kind()).increment();
        log.warn("email delivery failed, will retry kind={} to={} attempt={} error={}", m.kind(), Masking.email(m.recipient()),
                m.attempts(), e.getClass().getSimpleName());
    }

    Duration backoff(int attempts) {
        EmailProperties.Dispatcher cfg = properties.dispatcher();
        long factor = 1L << Math.min(Math.max(attempts - 1, 0), 20);
        Duration candidate = cfg.baseBackoff().multipliedBy(factor);
        return candidate.compareTo(cfg.maxBackoff()) > 0 ? cfg.maxBackoff() : candidate;
    }
}
