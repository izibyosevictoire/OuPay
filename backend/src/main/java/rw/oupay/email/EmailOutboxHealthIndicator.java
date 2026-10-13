package rw.oupay.email;

import java.sql.Timestamp;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import org.springframework.boot.health.contributor.Health;
import org.springframework.boot.health.contributor.HealthIndicator;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

/**
 * Makes e-mail delivery failures visible to operators without taking the service out of rotation
 * (a mail outage must not stop invoicing). DEGRADED is mapped to HTTP 200; see application.yml.
 * It is deliberately NOT part of the readiness group.
 */
@Component("emailOutbox")
public class EmailOutboxHealthIndicator implements HealthIndicator {

    /** A message waiting longer than this is a delivery problem, even if it has not failed outright. */
    private static final Duration STUCK_AFTER = Duration.ofMinutes(15);

    private final JdbcClient jdbc;
    private final Clock clock;

    public EmailOutboxHealthIndicator(JdbcClient jdbc, Clock clock) {
        this.jdbc = jdbc;
        this.clock = clock;
    }

    @Override
    public Health health() {
        Instant stuckBefore = clock.instant().minus(STUCK_AFTER);
        long failed = jdbc.sql("select count(*) from email_outbox where status = 'FAILED'").query(Long.class).single();
        long pending = jdbc.sql("select count(*) from email_outbox where status in ('PENDING', 'SENDING')").query(Long.class).single();
        long stuck = jdbc.sql("select count(*) from email_outbox where status in ('PENDING', 'SENDING') and next_attempt_at < :t")
                .param("t", Timestamp.from(stuckBefore)).query(Long.class).single();
        Health.Builder builder = (failed > 0 || stuck > 0) ? Health.status("DEGRADED") : Health.up();
        return builder.withDetail("pending", pending).withDetail("stuck", stuck).withDetail("failed", failed).build();
    }
}
