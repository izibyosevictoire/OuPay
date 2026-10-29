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
        assertThat(versions).containsExactly("1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15", "16", "17", "18");
    }

    @Test
    void everyBusinessTableCarriesItsOwnerAndMoneyIsNeverAFloat() {
        // No floating point or money type anywhere. The ONLY exact-decimal columns are quantities (R5b packages, R5c stock), all NUMERIC(20,6).
        assertThat(jdbc.queryForList("select column_name from information_schema.columns where table_schema = 'public' "
                + "and data_type in ('double precision', 'real', 'money')", String.class)).isEmpty();
        assertThat(jdbc.queryForList("select table_name || '.' || column_name from information_schema.columns where table_schema = 'public' "
                + "and data_type = 'numeric'", String.class)).containsExactlyInAnyOrder("catalog_item_packages.quantity_per_package", "inventory_balances.quantity_on_hand", "pos_draft_lines.canonical_quantity", "pos_sale_lines.canonical_quantity", "stock_reservation_lines.quantity", "pos_fulfilment_lines.quantity",
                        "stock_movements.quantity_delta", "stock_movements.balance_after");
        List<String> moneyColumns = jdbc.queryForList("select column_name from information_schema.columns where table_schema = 'public' "
                + "and column_name like '%\\_rwf' order by 1", String.class);
        assertThat(moneyColumns).isNotEmpty();
        assertThat(jdbc.queryForList("select data_type from information_schema.columns where table_schema = 'public' and column_name like '%\\_rwf'", String.class))
                .containsOnly("bigint");
        for (String table : List.of("invoices", "bank_transactions", "payment_allocations", "payment_requests", "payment_profiles",
                "bank_connections", "payment_destinations", "branches", "memberships", "notifications", "merchant_settings", "idempotency_keys", "catalog_items", "catalog_item_prices", "catalog_item_packages", "inventory_balances", "stock_movements", "collection_codes", "collection_code_assignments")) {
            assertThat(jdbc.queryForObject("select count(*) from information_schema.columns where table_name = ? and column_name = 'merchant_id'",
                    Integer.class, table)).as(table + " has merchant_id").isEqualTo(1);
        }
    }

    @Test
    void theHotLookupsAreIndexed() {
        List<String> indexes = jdbc.queryForList("select indexname from pg_indexes where schemaname = 'public'", String.class);
        assertThat(indexes).contains("ux_bank_transactions_provider_tx", "ux_bank_events_provider_event", "ix_payment_allocations_invoice",
                "ix_bank_transactions_merchant_time", "ux_payment_profiles_token", "ux_payment_requests_reference", "ux_invoices_number",
                "ux_notifications_dedupe", "ix_audit_log_transaction", "ux_users_email_lower", "ux_auth_sessions_token",
                "ix_idempotency_keys_created", "ux_invoices_client_request");
    }

    @Test
    void theProvenanceMigrationOnlyAddsAndNeverRewritesOrRemovesExistingData() throws java.io.IOException {
        String sql = new org.springframework.core.io.ClassPathResource("db/migration/V8__invoice_provenance.sql")
                .getContentAsString(java.nio.charset.StandardCharsets.UTF_8);
        // No row is rewritten, deleted or backfilled, and nothing existing is dropped or renamed.
        assertThat(sql).doesNotContainPattern("(?i)\\bupdate\\s+(invoices|payment_requests)\\b")
                .doesNotContainPattern("(?i)\\bdelete\\s+from\\b")
                .doesNotContainPattern("(?i)\\bdrop\\s+(table|column|constraint|index|trigger|function)\\b")
                .doesNotContainPattern("(?i)\\brename\\b")
                .doesNotContainPattern("(?i)\\bset\\s+not\\s+null\\b");
        // Every new column is nullable, so the previous application version keeps working against the new schema.
        assertThat(jdbc.queryForList("select is_nullable from information_schema.columns where table_schema = 'public' and "
                + "((table_name = 'invoices' and column_name in ('sale_channel', 'client_request_id', 'client_request_sha256')) or "
                + "(table_name = 'payment_requests' and column_name in ('source', 'branch_id', 'created_by_user_id')))", String.class))
                .hasSize(6).containsOnly("YES");
    }
}
