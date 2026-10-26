package rw.oupay.support;

import java.util.List;
import org.junit.jupiter.api.BeforeEach;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.context.annotation.Import;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.testcontainers.postgresql.PostgreSQLContainer;

/**
 * Base class for database integration tests. They always run against a REAL PostgreSQL, because
 * the financial guarantees (constraints, triggers, row locks) are PostgreSQL behaviour.
 *
 * <p>Database selection:
 * <ul>
 *   <li>If {@code OUPAY_TEST_DB_URL} is set (see scripts/start-test-postgres.sh) that database is used.
 *       Its public schema is migrated by Flyway and cleaned between tests.</li>
 *   <li>Otherwise a PostgreSQL Testcontainer is started (requires Docker).</li>
 * </ul>
 */
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
@Import(Fixtures.class)
public abstract class IntegrationTest {

    private static PostgreSQLContainer container;

    @DynamicPropertySource
    static void database(DynamicPropertyRegistry registry) {
        String url = System.getenv("OUPAY_TEST_DB_URL");
        if (url != null && !url.isBlank()) {
            registry.add("spring.datasource.url", () -> url);
            registry.add("spring.datasource.username", () -> env("OUPAY_TEST_DB_USER", "oupay_test"));
            registry.add("spring.datasource.password", () -> env("OUPAY_TEST_DB_PASSWORD", "oupay_test"));
            return;
        }
        synchronized (IntegrationTest.class) {
            if (container == null) {
                container = new PostgreSQLContainer("postgres:17-alpine");
                container.start();
            }
        }
        registry.add("spring.datasource.url", container::getJdbcUrl);
        registry.add("spring.datasource.username", container::getUsername);
        registry.add("spring.datasource.password", container::getPassword);
    }

    private static String env(String name, String fallback) {
        String value = System.getenv(name);
        return value == null || value.isBlank() ? fallback : value;
    }

    @Autowired
    protected MockMvc mvc;

    @Autowired
    protected JdbcTemplate jdbc;

    @Autowired
    protected Fixtures fixtures;

    @Autowired(required = false)
    protected rw.oupay.email.DevMailSink mailSink;

    @Autowired
    protected rw.oupay.email.EmailOutboxDispatcher dispatcher;

    /**
     * Delivers the queued e-mail through the (development) sink and returns the one-time token in the link of the
     * newest message to {@code recipient} whose link starts with {@code pathPrefix} (for example "/reset-password/").
     */
    protected String tokenFrom(String recipient, String pathPrefix) {
        dispatcher.dispatchDue();
        var messages = mailSink.messages();
        for (int i = messages.size() - 1; i >= 0; i--) {
            var message = messages.get(i);
            if (message.to().equalsIgnoreCase(recipient)) {
                var matcher = java.util.regex.Pattern.compile(java.util.regex.Pattern.quote(pathPrefix) + "([A-Za-z0-9_-]+)").matcher(message.text());
                if (matcher.find()) {
                    return matcher.group(1);
                }
            }
        }
        throw new AssertionError("no message to " + recipient + " with a link " + pathPrefix);
    }

    protected long outbox(String recipient, String kind) {
        return jdbc.queryForObject("select count(*) from email_outbox where recipient = ? and kind = ?", Long.class, recipient, kind);
    }

    /**
     * Every test starts from empty business data (the schema and migrations stay). Published reference data that a migration seeds
     * (the immutable KYC requirement sets) is not business data and is kept.
     */
    @BeforeEach
    void cleanDatabase() {
        if (mailSink != null) {
            mailSink.clear();
        }
        List<String> tables = jdbc.queryForList(
                "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('flyway_schema_history', 'kyc_requirement_sets')",
                String.class);
        jdbc.execute("TRUNCATE TABLE " + String.join(", ", tables) + " RESTART IDENTITY CASCADE");
        // A requirement set a test published is removed again (with the immutability guard off for this statement only), so one test's
        // published version can never leak into the next; the seeded version stays untouched.
        jdbc.execute("ALTER TABLE kyc_requirement_sets DISABLE TRIGGER trg_kyc_requirement_sets_immutable");
        try {
            jdbc.update("DELETE FROM kyc_requirement_sets WHERE version > 1");
        } finally {
            jdbc.execute("ALTER TABLE kyc_requirement_sets ENABLE TRIGGER trg_kyc_requirement_sets_immutable");
        }
    }
}
