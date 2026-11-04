package rw.oupay.demo;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.math.BigDecimal;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.TestPropertySource;
import rw.oupay.support.IntegrationTest;
import rw.oupay.support.TestApi;
import rw.oupay.support.World;
import tools.jackson.databind.JsonNode;

/**
 * R9: the persistent demonstration seed. It runs through the real services in a DESIGNATED demonstration database; a second run changes nothing;
 * what people add or edit afterwards is never reset; tenants stay apart; and normal authorization and audit rules apply to the seeded users.
 * (The passwords below exist only in this test; the product has none.)
 */
@ActiveProfiles("demo-seed")
@TestPropertySource(properties = {
        "oupay.demo-seed.enabled=true",
        "oupay.demo-seed.run-on-startup=false",
        "oupay.demo-seed.exit-after-run=false",
        "oupay.demo-seed.allowed-db-hosts=localhost,127.0.0.1",
        "oupay.demo-seed.owner-password=Demo-Test-Owner-Passw0rd-1",
        "oupay.demo-seed.manager-password=Demo-Test-Manager-Passw0rd-1",
        "oupay.demo-seed.cashier-password=Demo-Test-Cashier-Passw0rd-1"})
class DemoSeedIT extends IntegrationTest {

    static final String OWNER = "owner@demo.oupay.test";
    static final String MANAGER = "manager@demo.oupay.test";
    static final String CASHIER = "cashier@demo.oupay.test";
    static final String OWNER_PASSWORD = "Demo-Test-Owner-Passw0rd-1";
    static final String MANAGER_PASSWORD = "Demo-Test-Manager-Passw0rd-1";
    static final String CASHIER_PASSWORD = "Demo-Test-Cashier-Passw0rd-1";

    @DynamicPropertySource
    static void confirmation(DynamicPropertyRegistry registry) {
        registry.add("oupay.demo-seed.confirm-database", DemoSeedIT::databaseName);
    }

    /** The name of the disposable test database (from the URL, or the Testcontainers default). */
    static String databaseName() {
        String url = System.getenv("OUPAY_TEST_DB_URL");
        if (url == null || url.isBlank()) {
            return "test";
        }
        String path = url.substring(url.indexOf("//") + 2);
        String name = path.substring(path.indexOf('/') + 1);
        return name.contains("?") ? name.substring(0, name.indexOf('?')) : name;
    }

    @Autowired
    DemoSeeder seeder;

    @BeforeEach
    void designateTheDemonstrationDatabase() {
        // What an operator does by hand, once, on the disposable demonstration database. The seeder never does it.
        jdbc.update("insert into demo_environment (label) values ('integration test demonstration database')");
    }

    // ---- helpers ------------------------------------------------------------------------------------------------

    private static final List<String> SEEDED_TABLES = List.of("merchants", "users", "memberships", "branches", "branch_assignments", "catalog_items",
            "catalog_item_prices", "catalog_item_packages", "inventory_balances", "stock_movements", "payment_entry_devices",
            "payment_entry_device_assignments", "staff_invitations", "demo_seed_registry");

    private Map<String, Integer> counts(List<String> tables) {
        Map<String, Integer> result = new LinkedHashMap<>();
        for (String table : tables) {
            result.put(table, jdbc.queryForObject("select count(*) from " + table, Integer.class));
        }
        return result;
    }

    private int count(String table) {
        return jdbc.queryForObject("select count(*) from " + table, Integer.class);
    }

    private UUID merchantId() {
        return jdbc.queryForObject("select id from merchants where registration_number = ?", UUID.class, DemoSeeder.REGISTRATION_NUMBER);
    }

    private TestApi signIn(String email, String password) {
        TestApi api = new TestApi(mvc);
        var response = api.post("/api/v1/auth/login", Map.of("email", email, "password", password));
        assertThat(response.status()).as(response.body()).isEqualTo(200);
        return api;
    }

    private String base() {
        return "/api/v1/merchants/" + merchantId();
    }

    private UUID branch(String code) {
        return jdbc.queryForObject("select id from branches where merchant_id = ? and code = ?", UUID.class, merchantId(), code);
    }

    private UUID item(String code) {
        return jdbc.queryForObject("select id from catalog_items where merchant_id = ? and code = ?", UUID.class, merchantId(), code);
    }

    // ---- what a seed creates ------------------------------------------------------------------------------------

    @Test
    void oneRunCreatesTheDemonstrationBusinessAsOrdinaryRecordsAndNothingFinancial() {
        SeedReport report = seeder.seed();
        assertThat(report.created("merchant")).isEqualTo(1);
        assertThat(report.created("branch")).isEqualTo(3);
        assertThat(report.created("staff")).isEqualTo(2);
        assertThat(report.created("catalog item")).isEqualTo(12);
        assertThat(report.created("opening stock")).isEqualTo(12);
        assertThat(report.created("payment point")).isEqualTo(3);

        UUID m = merchantId();
        assertThat(jdbc.queryForObject("select count(*) from branches where merchant_id = ?", Integer.class, m)).isEqualTo(3);
        assertThat(jdbc.queryForList("select role from memberships where merchant_id = ? and status = 'ACTIVE' order by role", String.class, m))
                .containsExactly("CASHIER", "MANAGER", "OWNER");
        assertThat(jdbc.queryForObject("select count(*) from catalog_items where merchant_id = ? and item_type = 'GOODS'", Integer.class, m)).isEqualTo(8);
        assertThat(jdbc.queryForObject("select count(*) from catalog_items where merchant_id = ? and item_type = 'SERVICE'", Integer.class, m)).isEqualTo(4);
        assertThat(jdbc.queryForList("select device_type from payment_entry_devices where merchant_id = ? order by device_type", String.class, m))
                .containsExactly("NFC_BRACELET", "NFC_TAG", "STATIC_QR");
        // Stock is ordinary, immutable opening movements; the third branch has none.
        assertThat(jdbc.queryForObject("select count(*) from stock_movements where merchant_id = ? and movement_type = 'OPENING'", Integer.class, m)).isEqualTo(12);
        assertThat(jdbc.queryForObject("select count(*) from stock_movements where branch_id = ?", Integer.class, branch("NYM3"))).isZero();
        assertThatThrownBy(() -> jdbc.update("update stock_movements set reason = 'edited'")).isNotNull();
        // No money, no approval, no tax decision, no draft: the seeder cannot create what the gates protect.
        for (String table : List.of("bank_transactions", "bank_events", "payment_allocations", "collection_codes", "collection_code_assignments", "code_sales",
                "payment_requests", "invoices", "pos_drafts", "pos_sales", "stock_reservations", "payment_destinations", "bank_connections")) {
            assertThat(count(table)).as(table).isZero();
        }
        assertThat(jdbc.queryForObject("select count(*) from catalog_items where merchant_id = ? and tax_category is not null", Integer.class, m)).isZero();
    }

    @Test
    void usersAreProvisionedThroughTheRealFlowsWithoutHardcodedSecretsOrForcedVerification() {
        seeder.seed();
        // Passwords are hashed from what the operator supplied; none is stored or equals the plaintext.
        for (String password : List.of(OWNER_PASSWORD, MANAGER_PASSWORD, CASHIER_PASSWORD)) {
            assertThat(jdbc.queryForObject("select count(*) from users where password_hash = ?", Integer.class, password)).isZero();
        }
        assertThat(jdbc.queryForObject("select count(*) from users where password_hash is null", Integer.class)).isZero();
        // The invited staff proved their mailbox through the invitation link; the owner's email is NOT marked verified by hand.
        assertThat(jdbc.queryForObject("select email_verified_at is not null from users where email = ?", Boolean.class, MANAGER)).isTrue();
        assertThat(jdbc.queryForObject("select email_verified_at is not null from users where email = ?", Boolean.class, CASHIER)).isTrue();
        assertThat(jdbc.queryForObject("select email_verified_at is not null from users where email = ?", Boolean.class, OWNER)).isFalse();
        // They can really sign in with the passwords the operator supplied, and only with those.
        signIn(OWNER, OWNER_PASSWORD);
        signIn(MANAGER, MANAGER_PASSWORD);
        signIn(CASHIER, CASHIER_PASSWORD);
        var wrong = new TestApi(mvc).post("/api/v1/auth/login", Map.of("email", MANAGER, "password", "not-the-password-1"));
        assertThat(wrong.status()).isEqualTo(401);
        // The seeded staff are really assigned to their branches (through the invitation, as in the application).
        assertThat(jdbc.queryForList("select b.code from branch_assignments a join memberships m on m.id = a.membership_id join users u on u.id = m.user_id "
                + "join branches b on b.id = a.branch_id where u.email = ? and a.status = 'ACTIVE' order by b.code", String.class, MANAGER)).containsExactly("KGL1", "RMR2");
    }

    // ---- idempotent and non-destructive -------------------------------------------------------------------------

    @Test
    void aSecondRunCreatesNothingAndChangesNothing() {
        seeder.seed();
        Map<String, Integer> once = counts(SEEDED_TABLES);
        Map<String, Object> fingerprint = fingerprint();
        SeedReport second = seeder.seed();
        assertThat(second.created()).isZero();
        assertThat(counts(SEEDED_TABLES)).isEqualTo(once);
        assertThat(fingerprint()).isEqualTo(fingerprint);
        // The audit trail records the creation run once and does not add a line for a run that changed nothing.
        assertThat(jdbc.queryForObject("select count(*) from audit_log where kind = 'DEMO_SEED_RUN'", Integer.class)).isEqualTo(1);
    }

    /** Names, prices and versions of the seeded records: if the second run touched any record, this changes. */
    private Map<String, Object> fingerprint() {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("items", jdbc.queryForList("select code, name, version, current_price_version, price_per_sale_unit_rwf from catalog_items order by code"));
        result.put("branches", jdbc.queryForList("select code, name, status, updated_at from branches order by code"));
        result.put("balances", jdbc.queryForList("select item_id, branch_id, quantity_on_hand, version from inventory_balances order by item_id, branch_id"));
        result.put("devices", jdbc.queryForList("select display_name, status, version, public_token from payment_entry_devices order by display_name"));
        return result;
    }

    @Test
    void aUserCreatedFourthBranchAndNewStaffSurviveAnotherSeed() {
        seeder.seed();
        TestApi owner = signIn(OWNER, OWNER_PASSWORD);
        var created = owner.post(base() + "/branches", Map.of("name", "Huye Market", "code", "HUY4", "status", "ACTIVE",
                "location", Map.of("province", "Southern", "district", "Huye", "sector", "Ngoma", "physicalAddress", "Market Rd")));
        assertThat(created.status()).as(created.body()).isEqualTo(201);
        seeder.seed();
        assertThat(jdbc.queryForObject("select count(*) from branches where merchant_id = ?", Integer.class, merchantId())).isEqualTo(4);
        assertThat(jdbc.queryForObject("select name from branches where code = 'HUY4'", String.class)).isEqualTo("Huye Market");
        assertThat(owner.get(base() + "/branches").json().size()).isEqualTo(4);
        // More staff can be invited the normal way.
        var invited = owner.post(base() + "/invitations", Map.of("email", "second.cashier@demo.oupay.test", "role", "CASHIER", "branchIds", List.of(branch("RMR2").toString())));
        assertThat(invited.status()).as(invited.body()).isEqualTo(201);
    }

    @Test
    void aManuallyChangedPriceAndAdditionalStockAreNeverReset() {
        seeder.seed();
        TestApi owner = signIn(OWNER, OWNER_PASSWORD);
        UUID rice = item("DEMO-RICE");
        JsonNode before = owner.get(base() + "/catalog/items/" + rice).json();
        var updated = owner.put(base() + "/catalog/items/" + rice, Map.of("expectedVersion", before.path("version").asLong(), "name", "Rice (premium)",
                "description", "Edited by a person", "code", "DEMO-RICE", "saleUnit", "kg", "pricePerSaleUnitRwf", 1_350, "priceChangeReason", "Supplier increase"));
        assertThat(updated.status()).as(updated.body()).isEqualTo(200);
        // Stock is received and adjusted through the normal inventory service.
        var received = owner.post(base() + "/inventory/receive", Map.of("clientOperationId", UUID.randomUUID().toString(), "branchId", branch("KGL1").toString(),
                "itemId", rice.toString(), "amount", "50", "unit", "kg", "reference", "DN-DEMO-77"));
        assertThat(received.status()).as(received.body()).isEqualTo(201);
        BigDecimal onHand = jdbc.queryForObject("select quantity_on_hand from inventory_balances where item_id = ? and branch_id = ?", BigDecimal.class, rice, branch("KGL1"));
        assertThat(onHand).isEqualByComparingTo("170000");
        int movements = count("stock_movements");

        SeedReport again = seeder.seed();
        assertThat(again.created()).isZero();
        // The price, name and price history are exactly what the person made them; the seed did not put the original back.
        assertThat(jdbc.queryForObject("select price_per_sale_unit_rwf from catalog_items where id = ?", BigDecimal.class, rice)).isEqualByComparingTo("1350");
        assertThat(jdbc.queryForObject("select name from catalog_items where id = ?", String.class, rice)).isEqualTo("Rice (premium)");
        assertThat(jdbc.queryForObject("select count(*) from catalog_item_prices where item_id = ?", Integer.class, rice)).isEqualTo(2);
        // The extra stock is intact and no second opening was written.
        assertThat(jdbc.queryForObject("select quantity_on_hand from inventory_balances where item_id = ? and branch_id = ?", BigDecimal.class, rice, branch("KGL1")))
                .isEqualByComparingTo("170000");
        assertThat(count("stock_movements")).isEqualTo(movements);
    }

    @Test
    void aDeactivatedItemARevokedPaymentPointAndASuspendedMemberStayAsPeopleLeftThem() {
        seeder.seed();
        TestApi owner = signIn(OWNER, OWNER_PASSWORD);
        UUID soda = item("DEMO-SODA");
        long version = owner.get(base() + "/catalog/items/" + soda).json().path("version").asLong();
        assertThat(owner.put(base() + "/catalog/items/" + soda + "/status", Map.of("expectedVersion", version, "active", false)).status()).isEqualTo(200);
        var device = owner.get(base() + "/entry-devices").json().get(0);
        assertThat(owner.post(base() + "/entry-devices/" + device.path("id").asString() + "/revoke",
                Map.of("expectedVersion", device.path("version").asLong(), "reason", "Tag lost in a test")).status()).isEqualTo(200);
        seeder.seed();
        assertThat(jdbc.queryForObject("select active from catalog_items where id = ?", Boolean.class, soda)).isFalse();
        assertThat(jdbc.queryForObject("select count(*) from payment_entry_devices where status = 'REVOKED'", Integer.class)).isEqualTo(1);
        assertThat(count("payment_entry_devices")).isEqualTo(3);
    }

    // ---- authorization and audit ----------------------------------------------------------------------------------

    @Test
    void theSeededUsersKeepTheirRoleLimitsAndEveryCreationIsAuditedWithItsActor() {
        seeder.seed();
        TestApi cashier = signIn(CASHIER, CASHIER_PASSWORD);
        TestApi manager = signIn(MANAGER, MANAGER_PASSWORD);
        // A cashier can neither change the catalog nor register a payment point; a manager only at the branches they work at.
        assertThat(cashier.post(base() + "/catalog/items", Map.of("itemType", "SERVICE", "name", "Not allowed", "code", "X-1", "pricePerSaleUnitRwf", 100)).status()).isEqualTo(403);
        Map<String, Object> device = new java.util.HashMap<>();
        device.put("clientRequestId", UUID.randomUUID().toString());
        device.put("deviceType", "STATIC_QR");
        device.put("displayName", "Nyamirambo counter");
        device.put("branchId", branch("NYM3").toString());
        assertThat(cashier.post(base() + "/entry-devices", device).status()).isEqualTo(403);
        assertThat(manager.post(base() + "/entry-devices", device).status()).isEqualTo(403);
        device.put("clientRequestId", UUID.randomUUID().toString());
        device.put("branchId", branch("RMR2").toString());
        device.put("displayName", "Remera second counter");
        assertThat(manager.post(base() + "/entry-devices", device).status()).isEqualTo(201);
        // Audit: the creations are recorded with the owner as the actor, and the run itself as an operator action.
        UUID owner = jdbc.queryForObject("select id from users where email = ?", UUID.class, OWNER);
        assertThat(jdbc.queryForList("select distinct actor_user_id from audit_log where merchant_id = ? and kind = 'ENTRY_DEVICE_REGISTERED' and message like '%counter%' "
                + "and actor_user_id = ?", UUID.class, merchantId(), owner)).containsExactly(owner);
        assertThat(jdbc.queryForList("select distinct kind from audit_log where merchant_id = ?", String.class, merchantId()))
                .contains("STAFF_INVITED", "STAFF_INVITATION_ACCEPTED", "ENTRY_DEVICE_REGISTERED", "DEMO_SEED_RUN");
        assertThat(jdbc.queryForObject("select count(*) from audit_log where merchant_id = ? and kind = 'INVENTORY_STOCK_OPENED' and actor_user_id = ?", Integer.class, merchantId(), owner))
                .isEqualTo(12);
    }

    // ---- tenants stay apart -------------------------------------------------------------------------------------

    @Test
    void seedingTouchesNoRecordOfAnyOtherBusiness() {
        World w = World.create(this);
        List<String> tenantTables = List.of("branches", "memberships", "invoices", "catalog_items", "inventory_balances", "stock_movements", "payment_entry_devices",
                "audit_log", "bank_transactions", "payment_destinations");
        Map<String, Map<String, Integer>> before = tenantCounts(List.of(w.merchantId, w.cafeMerchantId), tenantTables);
        List<Map<String, Object>> usersBefore = jdbc.queryForList("select id, email, full_name, password_hash, status from users order by email");
        seeder.seed();
        seeder.seed();
        assertThat(tenantCounts(List.of(w.merchantId, w.cafeMerchantId), tenantTables)).isEqualTo(before);
        assertThat(jdbc.queryForList("select id, email, full_name, password_hash, status from users where email not like '%@demo.oupay.test' order by email")).isEqualTo(usersBefore);
        // Everything the seeder made belongs to the demonstration business only.
        assertThat(jdbc.queryForObject("select count(*) from demo_seed_registry where merchant_id <> ?", Integer.class, merchantId())).isZero();
    }

    @Test
    void aBusinessThatMerelyHoldsTheReservedRegistrationNumberIsNeverAdopted() {
        World w = World.create(this);
        jdbc.update("update merchants set registration_number = ? where id = ?", DemoSeeder.REGISTRATION_NUMBER, w.merchantId);
        Map<String, Integer> before = tenantCounts(List.of(w.merchantId), List.of("branches", "catalog_items", "memberships", "stock_movements")).get(w.merchantId.toString());
        assertThatThrownBy(() -> seeder.seed()).hasMessageContaining("not owned by the demonstration owner");
        assertThat(tenantCounts(List.of(w.merchantId), List.of("branches", "catalog_items", "memberships", "stock_movements")).get(w.merchantId.toString())).isEqualTo(before);
        assertThat(count("demo_seed_registry")).isZero();
    }

    private Map<String, Map<String, Integer>> tenantCounts(List<UUID> merchants, List<String> tables) {
        Map<String, Map<String, Integer>> result = new LinkedHashMap<>();
        for (UUID m : merchants) {
            Map<String, Integer> counts = new LinkedHashMap<>();
            for (String table : tables) {
                counts.put(table, jdbc.queryForObject("select count(*) from " + table + " where merchant_id = ?", Integer.class, m));
            }
            result.put(m.toString(), counts);
        }
        return result;
    }

    // ---- refusals ----------------------------------------------------------------------------------------------

    @Test
    void aDatabaseThatWasNotDesignatedByHandIsRefusedBeforeAnythingIsWritten() {
        jdbc.update("delete from demo_environment");
        Map<String, Integer> before = counts(SEEDED_TABLES);
        assertThatThrownBy(() -> seeder.seed()).hasMessageContaining("not designated as a demonstration environment");
        assertThat(counts(SEEDED_TABLES)).isEqualTo(before);
        assertThat(count("users")).isZero();
    }

    @Test
    void aWrongOwnerPasswordStopsTheRunAndNothingIsCreatedOrReset() {
        seeder.seed();
        Map<String, Integer> once = counts(SEEDED_TABLES);
        String hash = jdbc.queryForObject("select password_hash from users where email = ?", String.class, OWNER);
        // The seeder authenticates for real: with the owner present, an unknown password is a failed login, never a reset.
        jdbc.update("update users set password_hash = (select password_hash from users where email = ?) where email = ?", MANAGER, OWNER);
        assertThatThrownBy(() -> seeder.seed()).isNotNull();
        assertThat(counts(SEEDED_TABLES)).isEqualTo(once);
        assertThat(jdbc.queryForObject("select password_hash from users where email = ?", String.class, OWNER)).isNotEqualTo(hash);
    }
}
