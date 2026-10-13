package rw.oupay;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import org.junit.jupiter.api.Test;
import rw.oupay.support.IntegrationTest;

/** The schema is owned by Flyway; Hibernate only validates it (ddl-auto=validate), so a drift fails startup. */
class MigrationIT extends IntegrationTest {

    @Test
    void everyMigrationAppliedSuccessfullyInOrder() {
        List<String> versions = jdbc.queryForList("select version from flyway_schema_history where success order by installed_rank", String.class);
        assertThat(versions).containsExactly("1", "2", "3", "4", "5");
    }

    @Test
    void everyBusinessTableCarriesItsOwnerAndMoneyIsNeverAFloat() {
        assertThat(jdbc.queryForList("select column_name from information_schema.columns where table_schema = 'public' "
                + "and data_type in ('double precision', 'real', 'numeric', 'money')", String.class)).isEmpty();
        List<String> moneyColumns = jdbc.queryForList("select column_name from information_schema.columns where table_schema = 'public' "
                + "and column_name like '%\\_rwf' order by 1", String.class);
        assertThat(moneyColumns).isNotEmpty();
        assertThat(jdbc.queryForList("select data_type from information_schema.columns where table_schema = 'public' and column_name like '%\\_rwf'", String.class))
                .containsOnly("bigint");
        for (String table : List.of("invoices", "bank_transactions", "payment_allocations", "payment_requests", "payment_profiles",
                "bank_connections", "payment_destinations", "branches", "memberships", "notifications")) {
            assertThat(jdbc.queryForObject("select count(*) from information_schema.columns where table_name = ? and column_name = 'merchant_id'",
                    Integer.class, table)).as(table + " has merchant_id").isEqualTo(1);
        }
    }

    @Test
    void theHotLookupsAreIndexed() {
        List<String> indexes = jdbc.queryForList("select indexname from pg_indexes where schemaname = 'public'", String.class);
        assertThat(indexes).contains("ux_bank_transactions_provider_tx", "ux_bank_events_provider_event", "ix_payment_allocations_invoice",
                "ix_bank_transactions_merchant_time", "ux_payment_profiles_token", "ux_payment_requests_reference", "ux_invoices_number",
                "ux_notifications_dedupe", "ix_audit_log_transaction", "ux_users_email_lower", "ux_auth_sessions_token");
    }
}
