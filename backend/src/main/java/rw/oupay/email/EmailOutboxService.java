package rw.oupay.email;

import java.sql.Timestamp;
import java.time.Clock;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/**
 * The transactional outbox. {@link #enqueue} MUST run inside the transaction of the business change
 * that causes the message (it refuses to run without one): either both are committed or neither is, so
 * the application never loses a message for a committed change and never mails about a rolled-back one.
 * Delivery happens later, in {@link EmailOutboxDispatcher}.
 */
@Service
public class EmailOutboxService {

    private final JdbcClient jdbc;
    private final EmailProperties properties;
    private final Clock clock;

    public EmailOutboxService(JdbcClient jdbc, EmailProperties properties, Clock clock) {
        this.jdbc = jdbc;
        this.properties = properties;
        this.clock = clock;
    }

    @Transactional(propagation = Propagation.MANDATORY)
    public UUID enqueue(String kind, String recipient, UUID recipientUserId, EmailContent content) {
        UUID id = UUID.randomUUID();
        var now = Timestamp.from(clock.instant());
        jdbc.sql("insert into email_outbox (id, kind, recipient, recipient_user_id, subject, body_text, body_html, status, attempts, "
                        + "max_attempts, next_attempt_at, created_at, updated_at) "
                        + "values (:id, :kind, :to, :user, :subject, :text, :html, 'PENDING', 0, :max, :now, :now, :now)")
                .param("id", id).param("kind", kind).param("to", recipient).param("user", recipientUserId)
                .param("subject", content.subject()).param("text", content.text()).param("html", content.html())
                .param("max", properties.dispatcher().maxAttempts()).param("now", now)
                .update();
        return id;
    }
}
