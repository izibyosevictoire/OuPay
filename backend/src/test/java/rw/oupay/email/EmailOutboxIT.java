package rw.oupay.email;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.reset;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;

import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.health.contributor.Health;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.transaction.IllegalTransactionStateException;
import org.springframework.transaction.support.TransactionTemplate;
import rw.oupay.support.IntegrationTest;

/** The outbox: atomic with the business change, retried with backoff, never lost, never sent twice, visible when failing. */
@org.springframework.test.context.TestPropertySource(properties = "oupay.email.sink-endpoint-enabled=false")
class EmailOutboxIT extends IntegrationTest {

    @MockitoBean
    EmailSender sender;

    @Autowired
    EmailOutboxService outbox;

    @Autowired
    TransactionTemplate tx;

    @Autowired
    EmailOutboxHealthIndicator health;

    private static final EmailContent CONTENT = new EmailContent("Subject", "Open https://app.example/reset-password/SECRET-LINK", "<p>html</p>");

    @BeforeEach
    void resetMock() {
        reset(sender);
    }

    private UUID queue(String to) {
        return tx.execute(s -> outbox.enqueue("TEST", to, null, CONTENT));
    }

    private String status(UUID id) {
        return jdbc.queryForObject("select status from email_outbox where id = ?", String.class, id);
    }

    private void makeDueNow(UUID id) {
        jdbc.update("update email_outbox set next_attempt_at = ? where id = ?", Timestamp.from(Instant.now().minusSeconds(1)), id);
    }

    @Test
    void enqueueingNeedsTheTransactionOfTheBusinessChange() {
        assertThatThrownBy(() -> outbox.enqueue("TEST", "a@b.rw", null, CONTENT)).isInstanceOf(IllegalTransactionStateException.class);
    }

    @Test
    void aRolledBackChangeLeavesNoMessageBehind() {
        assertThatThrownBy(() -> tx.executeWithoutResult(s -> {
            outbox.enqueue("TEST", "ghost@b.rw", null, CONTENT);
            throw new IllegalStateException("business change failed");
        })).isInstanceOf(IllegalStateException.class);
        assertThat(jdbc.queryForObject("select count(*) from email_outbox", Integer.class)).isZero();
    }

    @Test
    void aDeliveredMessageIsMarkedSentAndItsBodyErased() throws Exception {
        UUID id = queue("ok@b.rw");
        assertThat(dispatcher.dispatchDue()).isEqualTo(1);
        verify(sender, times(1)).send(any());
        assertThat(status(id)).isEqualTo("SENT");
        assertThat(jdbc.queryForObject("select body_text is null and body_html is null and sent_at is not null from email_outbox", Boolean.class)).isTrue();
        // Nothing is due any more.
        assertThat(dispatcher.dispatchDue()).isZero();
        verify(sender, times(1)).send(any());
    }

    @Test
    void aFailureIsRetriedWithBackoffAndThenDelivered() throws Exception {
        UUID id = queue("flaky@b.rw");
        doThrow(new EmailDeliveryException("SMTP down", null)).when(sender).send(any());
        assertThat(dispatcher.dispatchDue()).isZero();
        assertThat(status(id)).isEqualTo("PENDING");
        assertThat(jdbc.queryForObject("select attempts from email_outbox", Integer.class)).isEqualTo(1);
        assertThat(jdbc.queryForObject("select last_error from email_outbox", String.class)).contains("SMTP down");
        // Backed off: asking again right away does nothing.
        assertThat(jdbc.queryForObject("select next_attempt_at > now() from email_outbox", Boolean.class)).isTrue();
        assertThat(dispatcher.dispatchDue()).isZero();
        verify(sender, times(1)).send(any());
        // The body is kept while a retry is still possible.
        assertThat(jdbc.queryForObject("select body_text is not null from email_outbox", Boolean.class)).isTrue();

        reset(sender);
        makeDueNow(id);
        assertThat(dispatcher.dispatchDue()).isEqualTo(1);
        assertThat(status(id)).isEqualTo("SENT");
        assertThat(jdbc.queryForObject("select attempts from email_outbox", Integer.class)).isEqualTo(2);
    }

    @Test
    void afterTheLastAttemptTheMessageIsFailedVisibleAndItsBodyErased() throws Exception {
        UUID id = queue("dead@b.rw");
        jdbc.update("update email_outbox set max_attempts = 2");
        doThrow(new EmailDeliveryException("mailbox unavailable", null)).when(sender).send(any());
        dispatcher.dispatchDue();
        makeDueNow(id);
        dispatcher.dispatchDue();
        assertThat(status(id)).isEqualTo("FAILED");
        assertThat(jdbc.queryForObject("select body_text is null and body_html is null from email_outbox", Boolean.class)).isTrue();
        assertThat(jdbc.queryForObject("select last_error from email_outbox", String.class)).contains("mailbox unavailable");
        // A failed message is never retried automatically.
        makeDueNow(id);
        reset(sender);
        assertThat(dispatcher.dispatchDue()).isZero();

        // And operators can see it: health reports DEGRADED (not DOWN) with the counts.
        Health result = health.health();
        assertThat(result.getStatus().getCode()).isEqualTo("DEGRADED");
        assertThat(result.getDetails()).containsEntry("failed", 1L);
    }

    @Test
    void anUnexpectedRuntimeErrorFromTheProviderIsHandledLikeAnyFailure() throws Exception {
        UUID id = queue("boom@b.rw");
        doThrow(new IllegalStateException("provider bug")).when(sender).send(any());
        dispatcher.dispatchDue();
        assertThat(status(id)).isEqualTo("PENDING");
        assertThat(jdbc.queryForObject("select last_error from email_outbox", String.class)).contains("provider bug");
    }

    @Test
    void aMessageClaimedByADispatcherThatDiedIsPickedUpAgainAfterItsLease() throws Exception {
        UUID id = queue("lease@b.rw");
        jdbc.update("update email_outbox set status = 'SENDING', attempts = 1, locked_until = ?", Timestamp.from(Instant.now().plusSeconds(120)));
        assertThat(dispatcher.dispatchDue()).isZero();           // still leased: someone is working on it
        jdbc.update("update email_outbox set locked_until = ?", Timestamp.from(Instant.now().minusSeconds(1)));
        assertThat(dispatcher.dispatchDue()).isEqualTo(1);       // lease expired: recovered
        assertThat(status(id)).isEqualTo("SENT");
        verify(sender, times(1)).send(any());
    }

    @Test
    void severalDispatchersNeverSendTheSameMessageTwice() throws Exception {
        for (int i = 0; i < 12; i++) {
            queue("m" + i + "@b.rw");
        }
        var seen = ConcurrentHashMap.<String>newKeySet();
        var duplicates = new java.util.concurrent.atomic.AtomicInteger();
        doAnswer(invocation -> {
            EmailMessage message = invocation.getArgument(0);
            if (!seen.add(message.to())) {
                duplicates.incrementAndGet();
            }
            Thread.sleep(20);
            return null;
        }).when(sender).send(any());
        var pool = Executors.newFixedThreadPool(4);
        try {
            List<Callable<Integer>> runs = new ArrayList<>();
            for (int i = 0; i < 4; i++) {
                runs.add(() -> dispatcher.dispatchDue());
            }
            int delivered = 0;
            for (var f : pool.invokeAll(runs)) {
                delivered += f.get();
            }
            assertThat(delivered).isEqualTo(12);
        } finally {
            pool.shutdownNow();
        }
        assertThat(duplicates.get()).isZero();
        verify(sender, times(12)).send(any());
        assertThat(jdbc.queryForObject("select count(*) from email_outbox where status = 'SENT'", Integer.class)).isEqualTo(12);
    }

    @Test
    void healthIsUpWhenNothingIsWrongAndReportsAStuckBacklog() {
        assertThat(health.health().getStatus().getCode()).isEqualTo("UP");
        UUID id = queue("stuck@b.rw");
        assertThat(health.health().getStatus().getCode()).isEqualTo("UP");
        jdbc.update("update email_outbox set next_attempt_at = ? where id = ?", Timestamp.from(Instant.now().minusSeconds(3600)), id);
        assertThat(health.health().getStatus().getCode()).isEqualTo("DEGRADED");
    }

    @Test
    void backoffGrowsExponentiallyAndIsCapped() {
        var cfg = new EmailProperties("sink", "x", false, new EmailProperties.Dispatcher(true, Duration.ofSeconds(5), 20, 8,
                Duration.ofSeconds(30), Duration.ofHours(1), Duration.ofMinutes(2)));
        var d = new EmailOutboxDispatcher(null, null, null, cfg, null, null);
        assertThat(d.backoff(1)).hasSeconds(30);
        assertThat(d.backoff(2)).hasSeconds(60);
        assertThat(d.backoff(3)).hasSeconds(120);
        assertThat(d.backoff(30)).isEqualTo(Duration.ofHours(1));
    }

    @Test
    void theTemplatesProduceEscapedHtmlAndPlainTextWithTheSameLink() {
        var templates = new EmailTemplates(new rw.oupay.common.AppProperties("https://app.oupay.rw/"));
        var content = templates.staffInvitation("<b>Eve</b>", "Olive \"The Boss\" <o@x>", "Shop & Sons", "cashier", "Hi <script>alert(1)</script>",
                "TOKEN123", Duration.ofDays(7));
        assertThat(content.subject()).contains("Shop & Sons");
        assertThat(content.text()).contains("https://app.oupay.rw/accept-invitation/TOKEN123").contains("7 days");
        assertThat(content.html()).contains("href=\"https://app.oupay.rw/accept-invitation/TOKEN123\"")
                .doesNotContain("<script>").doesNotContain("<b>Eve</b>").contains("&lt;b&gt;Eve&lt;/b&gt;").contains("Shop &amp; Sons");
        var reset = templates.passwordReset(null, "T", Duration.ofHours(1));
        assertThat(reset.text()).startsWith("Hello,").contains("https://app.oupay.rw/reset-password/T").contains("1 hour");
        assertThat(templates.passwordChanged("Eve").text()).doesNotContain("http");
    }
}
