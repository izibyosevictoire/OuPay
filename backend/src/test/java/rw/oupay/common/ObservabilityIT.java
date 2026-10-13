package rw.oupay.common;

import static org.assertj.core.api.Assertions.assertThat;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpMethod;
import rw.oupay.support.IntegrationTest;
import rw.oupay.support.TestApi;
import rw.oupay.support.World;

/** Structured logging, correlation ids in the log context, financial event logs, and housekeeping. */
class ObservabilityIT extends IntegrationTest {

    @Autowired
    Housekeeping housekeeping;

    private final ListAppender<ILoggingEvent> appender = new ListAppender<>();
    private Logger root;

    @BeforeEach
    void capture() {
        root = (Logger) LoggerFactory.getLogger("rw.oupay");
        appender.start();
        root.addAppender(appender);
    }

    @AfterEach
    void release() {
        root.detachAppender(appender);
    }

    private List<ILoggingEvent> events(String logger) {
        return appender.list.stream().filter(e -> e.getLoggerName().equals(logger)).toList();
    }

    @Test
    void theAccessLogCarriesTheCorrelationIdAndTheRoutePatternNeverTheTokenInTheUrl() {
        String secretToken = "SECRETTOKEN" + "x".repeat(32);
        TestApi.anonymous(mvc, HttpMethod.GET, "/api/v1/public/invitations/" + secretToken, null, Map.of("X-Request-Id", "trace-abc-123456"));
        var access = events("rw.oupay.access");
        assertThat(access).isNotEmpty();
        var line = access.get(access.size() - 1);
        assertThat(line.getMDCPropertyMap()).containsEntry("correlationId", "trace-abc-123456");
        assertThat(line.getFormattedMessage()).contains("method=GET").contains("route=/api/v1/public/invitations/{token}").contains("status=400")
                .contains("durationMs=").doesNotContain(secretToken);
        // No log line of the request mentions the token.
        assertThat(appender.list.stream().map(ILoggingEvent::getFormattedMessage).toList()).noneMatch(m -> m.contains(secretToken));
    }

    @Test
    void theSignedInUserIsInTheLogContextButTheCorrelationIdDoesNotLeakBetweenRequests() {
        World w = World.create(this);
        appender.list.clear();
        w.owner.get("/api/v1/merchants");
        var first = events("rw.oupay.access").stream().filter(e -> e.getFormattedMessage().contains("route=/api/v1/merchants ")).findFirst().orElseThrow();
        assertThat(first.getMDCPropertyMap()).containsKey("correlationId");
        assertThat(first.getMDCPropertyMap().get("userId")).isEqualTo(w.ownerPerson.userId().toString());
        var anonymousCall = TestApi.anonymous(mvc, HttpMethod.GET, "/api/v1/auth/session", null, Map.of());
        var second = events("rw.oupay.access").get(events("rw.oupay.access").size() - 1);
        assertThat(second.getMDCPropertyMap().get("correlationId")).isEqualTo(anonymousCall.raw().getHeader("X-Request-Id"));
        assertThat(second.getMDCPropertyMap()).doesNotContainKey("userId");
    }

    @Test
    void financialEventsAreLoggedWithIdsAndAmountsButNoPersonalData() {
        World w = World.create(this);
        var invoice = w.issuedInvoice(10_000);
        appender.list.clear();
        w.bank.pay("POSTED", 4_000, jdbc.queryForObject("select invoice_number from invoices where id = ?", String.class, invoice));
        var lines = events("rw.oupay.financial").stream().map(ILoggingEvent::getFormattedMessage).toList();
        assertThat(lines).anyMatch(l -> l.contains("type=bank_event") && l.contains("outcome=APPLIED"))
                .anyMatch(l -> l.contains("type=allocated") && l.contains("amountRwf=4000") && l.contains("origin=AUTO_REFERENCE"));
        assertThat(String.join("\n", lines)).doesNotContain("Test Payer").doesNotContain(w.bank.accountId);
        assertThat(String.join("\n", appender.list.stream().map(ILoggingEvent::getFormattedMessage).toList())).doesNotContain("Test Payer");
    }

    @Test
    void housekeepingRemovesDeadSecurityDataAndNeverFinancialOrAuditRecords() {
        World w = World.create(this);
        Timestamp ancient = Timestamp.from(Instant.now().minusSeconds(100L * 86_400));
        jdbc.update("update auth_sessions set absolute_expires_at = ?, revoked_at = ? where user_id = ?", ancient, ancient, w.cafePerson.userId());
        jdbc.update("insert into account_tokens (id, user_id, purpose, token_hash, email, created_at, expires_at, used_at) "
                + "values (gen_random_uuid(), ?, 'PASSWORD_RESET', decode(repeat('ab', 32), 'hex'), 'x@y.rw', ?, ?, ?)", w.cafePerson.userId(), ancient, ancient, ancient);
        jdbc.update("insert into email_outbox (id, kind, recipient, subject, status, attempts, max_attempts, next_attempt_at, created_at, updated_at, sent_at) "
                + "values (gen_random_uuid(), 'T', 'a@b.rw', 's', 'SENT', 1, 8, ?, ?, ?, ?)", ancient, ancient, ancient, ancient);
        jdbc.update("insert into email_outbox (id, kind, recipient, subject, status, attempts, max_attempts, next_attempt_at, created_at, updated_at) "
                + "values (gen_random_uuid(), 'T', 'c@d.rw', 's', 'PENDING', 0, 8, now(), now(), now())");
        int liveSessions = jdbc.queryForObject("select count(*) from auth_sessions where user_id <> ?", Integer.class, w.cafePerson.userId());
        int audit = jdbc.queryForObject("select count(*) from audit_log", Integer.class);

        int[] removed = housekeeping.runOnce();
        assertThat(removed[0]).isEqualTo(1);
        assertThat(removed[1]).isEqualTo(1);
        assertThat(removed[2]).isEqualTo(1);
        assertThat(jdbc.queryForObject("select count(*) from auth_sessions where user_id <> ?", Integer.class, w.cafePerson.userId())).isEqualTo(liveSessions);
        assertThat(jdbc.queryForObject("select count(*) from email_outbox", Integer.class)).isEqualTo(1);   // the pending one survives
        assertThat(jdbc.queryForObject("select count(*) from audit_log", Integer.class)).isEqualTo(audit);
        assertThat(housekeeping.runOnce()).containsExactly(0, 0, 0, 0);
    }
}
