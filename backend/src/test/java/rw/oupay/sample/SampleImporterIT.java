package rw.oupay.sample;

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
import org.springframework.core.env.Environment;
import org.springframework.jdbc.core.simple.JdbcClient;
import rw.oupay.audit.AuditService;
import rw.oupay.auth.AuthService;
import rw.oupay.auth.PasswordService;
import rw.oupay.branch.BranchService;
import rw.oupay.catalog.CatalogService;
import rw.oupay.entry.EntryDeviceService;
import rw.oupay.inventory.InventoryService;
import rw.oupay.pos.PosService;
import rw.oupay.staff.InvitationService;
import rw.oupay.support.Fixtures;
import rw.oupay.support.IntegrationTest;
import rw.oupay.support.TestApi;
import rw.oupay.support.World;
import tools.jackson.databind.JsonNode;

/**
 * R9b: the sample-data importer adds the dataset to ONE existing merchant through the real services. Previews write nothing; a confirmation is
 * bound to the previewed plan; a second run changes nothing; what people created or edited afterwards is never touched; tenants stay apart; only the
 * merchant's authenticated owner can authorise it.
 */
class SampleImporterIT extends IntegrationTest {

    static final String PASSWORD = Fixtures.PASSWORD;

    @Autowired JdbcClient jdbcClient;
    @Autowired AuthService auth;
    @Autowired PasswordService passwords;
    @Autowired BranchService branchService;
    @Autowired InvitationService invitations;
    @Autowired CatalogService catalog;
    @Autowired InventoryService inventory;
    @Autowired EntryDeviceService devices;
    @Autowired PosService pos;
    @Autowired AuditService audit;
    @Autowired Environment environment;

    World w;

    @BeforeEach
    void world() {
        w = World.create(this);
    }

    // ---- helpers ------------------------------------------------------------------------------------------------

    private SampleImporter importer(UUID merchant, String ownerEmail, String password, String confirm, String manager, String cashiers) {
        return new SampleImporter(jdbcClient, auth, passwords, branchService, invitations, catalog, inventory, devices, pos, audit, environment,
                new SampleImportSettings(merchant.toString(), ownerEmail, password, confirm, manager, cashiers));
    }

    /** The importer as the shop's owner would run it, for the shop. */
    private SampleImporter shop(String confirm) {
        return importer(w.merchantId, w.ownerPerson.email(), PASSWORD, confirm, "", "");
    }

    private SampleImporter cafe(String confirm) {
        return importer(w.cafeMerchantId, w.cafePerson.email(), PASSWORD, confirm, "", "");
    }

    private SampleImporter.Result importAll(SampleImporter importer) {
        return importer.apply(importer.preview().fingerprint());
    }

    private static final List<String> TABLES = List.of("branches", "branch_assignments", "memberships", "users", "staff_invitations", "email_outbox", "catalog_items",
            "catalog_item_prices", "catalog_item_packages", "inventory_balances", "stock_movements", "payment_entry_devices", "pos_drafts", "pos_draft_lines",
            "audit_log", "auth_sessions", "bank_transactions", "payment_allocations", "collection_codes", "code_sales", "payment_requests", "invoices",
            "pos_sales", "stock_reservations", "payment_destinations");

    private Map<String, Integer> counts() {
        Map<String, Integer> result = new LinkedHashMap<>();
        for (String table : TABLES) {
            result.put(table, jdbc.queryForObject("select count(*) from " + table, Integer.class));
        }
        return result;
    }

    private Map<String, Integer> tenantCounts(UUID merchant) {
        Map<String, Integer> result = new LinkedHashMap<>();
        for (String table : List.of("branches", "catalog_items", "stock_movements", "inventory_balances", "payment_entry_devices", "pos_drafts", "audit_log", "memberships")) {
            result.put(table, jdbc.queryForObject("select count(*) from " + table + " where merchant_id = ?", Integer.class, merchant));
        }
        return result;
    }

    private long steps(SampleImporter.Preview preview, String kind, SampleImporter.Action action) {
        return preview.steps().stream().filter(s -> s.kind().equals(kind) && s.action() == action).count();
    }

    private String base(UUID merchant) {
        return "/api/v1/merchants/" + merchant;
    }

    private UUID branch(UUID merchant, String code) {
        return jdbc.queryForObject("select id from branches where merchant_id = ? and code = ?", UUID.class, merchant, code);
    }

    private UUID item(UUID merchant, String code) {
        return jdbc.queryForObject("select id from catalog_items where merchant_id = ? and code = ?", UUID.class, merchant, code);
    }

    // ---- preview ------------------------------------------------------------------------------------------------

    @Test
    void aPreviewListsTheWholeDatasetAndWritesNothingNotEvenASignIn() {
        Map<String, Integer> before = counts();
        SampleImporter.Preview preview = shop("").preview();
        assertThat(counts()).isEqualTo(before);
        assertThat(steps(preview, "branch", SampleImporter.Action.CREATE)).isEqualTo(3);
        assertThat(steps(preview, "catalog item", SampleImporter.Action.CREATE)).isEqualTo(12);
        assertThat(steps(preview, "package", SampleImporter.Action.CREATE)).isEqualTo(2);
        assertThat(steps(preview, "opening stock", SampleImporter.Action.CREATE)).isEqualTo(SampleDataPlan.STOCK.size());
        assertThat(steps(preview, "payment point", SampleImporter.Action.CREATE)).isEqualTo(3);
        // No staff addresses were supplied and the owner is not yet assigned to a sample branch: both are reported, not guessed.
        assertThat(steps(preview, "staff", SampleImporter.Action.SKIP)).isEqualTo(3);
        assertThat(steps(preview, "POS draft", SampleImporter.Action.SKIP)).isEqualTo(2);
        assertThat(preview.fingerprint()).matches("[0-9a-f]{16}");
        assertThat(preview.render()).contains("plan fingerprint: " + preview.fingerprint()).contains("Sample Shop");
        assertThat(preview.merchantId()).isEqualTo(w.merchantId);
    }

    // ---- what an import creates -----------------------------------------------------------------------------------

    @Test
    void anImportCreatesTheDatasetAsOrdinaryRecordsAuditedAsTheOwnerAndNothingFinancial() {
        Map<String, Integer> before = counts();
        SampleImporter.Result result = importAll(shop(""));
        assertThat(result.created()).isEqualTo(3 + 12 + 2 + SampleDataPlan.STOCK.size() + 3);
        Map<String, Integer> after = counts();

        assertThat(jdbc.queryForObject("select count(*) from branches where merchant_id = ? and code like 'DEMO%'", Integer.class, w.merchantId)).isEqualTo(3);
        assertThat(jdbc.queryForList("select name from branches where merchant_id = ? and code like 'DEMO%' order by name", String.class, w.merchantId))
                .containsExactly("DEMO - Kigali Main", "DEMO - Kimironko", "DEMO - Remera");
        assertThat(jdbc.queryForObject("select count(*) from catalog_items where merchant_id = ? and code like 'DEMO-%' and item_type = 'GOODS'", Integer.class, w.merchantId)).isEqualTo(10);
        assertThat(jdbc.queryForObject("select count(*) from catalog_items where merchant_id = ? and code like 'DEMO-%' and item_type = 'SERVICE'", Integer.class, w.merchantId)).isEqualTo(2);
        assertThat(jdbc.queryForList("select device_type from payment_entry_devices where merchant_id = ? order by device_type", String.class, w.merchantId))
                .containsExactly("NFC_TAG", "STATIC_QR", "STATIC_QR");
        // Stock is ordinary, immutable opening movements carrying the batch identifier, one per planned line.
        assertThat(jdbc.queryForObject("select count(*) from stock_movements where merchant_id = ? and movement_type = 'OPENING' and reference = ?", Integer.class,
                w.merchantId, SampleDataPlan.BATCH)).isEqualTo(SampleDataPlan.STOCK.size());
        assertThatThrownBy(() -> jdbc.update("update stock_movements set reason = 'edited'")).isNotNull();
        // No tax decision.
        assertThat(jdbc.queryForObject("select count(*) from catalog_items where merchant_id = ? and tax_category is not null", Integer.class, w.merchantId)).isZero();
        // Nothing financial, no approval and no draft (the owner is not assigned to a sample branch): exactly as before.
        for (String table : List.of("bank_transactions", "payment_allocations", "collection_codes", "code_sales", "payment_requests", "invoices", "pos_sales",
                "stock_reservations", "payment_destinations", "pos_drafts", "staff_invitations", "email_outbox")) {
            assertThat(after.get(table)).as(table).isEqualTo(before.get(table));
        }
        // Audit: every creation is recorded with the OWNER as the actor, and the run itself as one operator line carrying the batch.
        UUID owner = w.ownerPerson.userId();
        assertThat(jdbc.queryForList("select distinct actor_user_id from audit_log where merchant_id = ? and kind in ('BRANCH_CREATED', 'ENTRY_DEVICE_REGISTERED', "
                + "'INVENTORY_STOCK_OPENED')", UUID.class, w.merchantId)).containsExactly(owner);
        assertThat(jdbc.queryForObject("select count(*) from audit_log where merchant_id = ? and kind = 'INVENTORY_STOCK_OPENED'", Integer.class, w.merchantId))
                .isEqualTo(SampleDataPlan.STOCK.size());
        assertThat(jdbc.queryForList("select message from audit_log where kind = 'SAMPLE_IMPORT_RUN'", String.class)).singleElement().asString()
                .contains(SampleDataPlan.BATCH);
        // The importer's own sign-in session was ended; it is the only session it made.
        assertThat(jdbc.queryForObject("select count(*) from auth_sessions where user_agent = 'oupay-sample-importer' and revoked_at is null", Integer.class)).isZero();
        assertThat(jdbc.queryForObject("select count(*) from auth_sessions where user_agent = 'oupay-sample-importer'", Integer.class)).isEqualTo(1);
    }

    // ---- repeat runs ------------------------------------------------------------------------------------------------

    @Test
    void aSecondRunCreatesNothingChangesNothingAndNeedsNoSignIn() {
        importAll(shop(""));
        Map<String, Integer> once = counts();
        List<Map<String, Object>> items = jdbc.queryForList("select code, name, version, current_price_version, price_per_sale_unit_rwf, active from catalog_items order by code");
        List<Map<String, Object>> balances = jdbc.queryForList("select item_id, branch_id, quantity_on_hand, version from inventory_balances order by item_id, branch_id");

        SampleImporter again = shop("");
        SampleImporter.Preview preview = again.preview();
        assertThat(preview.writesAnything()).isFalse();
        SampleImporter.Result second = again.apply(preview.fingerprint());
        assertThat(second.created()).isZero();
        assertThat(counts()).isEqualTo(once);
        assertThat(jdbc.queryForList("select code, name, version, current_price_version, price_per_sale_unit_rwf, active from catalog_items order by code")).isEqualTo(items);
        assertThat(jdbc.queryForList("select item_id, branch_id, quantity_on_hand, version from inventory_balances order by item_id, branch_id")).isEqualTo(balances);
        assertThat(jdbc.queryForObject("select count(*) from audit_log where kind = 'SAMPLE_IMPORT_RUN'", Integer.class)).isEqualTo(1);
    }

    // ---- user data is preserved -----------------------------------------------------------------------------------

    @Test
    void whatPeopleCreatedOrEditedAfterwardsIsNeverResetOrDuplicated() {
        importAll(shop(""));
        TestApi owner = w.owner;
        UUID rice = item(w.merchantId, "DEMO-RICE");
        UUID kigali = branch(w.merchantId, "DEMOKGL");
        JsonNode before = owner.get(base(w.merchantId) + "/catalog/items/" + rice).json();
        assertThat(owner.put(base(w.merchantId) + "/catalog/items/" + rice, Map.of("expectedVersion", before.path("version").asLong(), "name", "Rice (premium)",
                "description", "Edited by a person", "code", "DEMO-RICE", "saleUnit", "kg", "pricePerSaleUnitRwf", 1_350, "priceChangeReason", "Supplier increase")).status())
                .isEqualTo(200);
        assertThat(owner.post(base(w.merchantId) + "/inventory/receive", Map.of("clientOperationId", UUID.randomUUID().toString(), "branchId", kigali.toString(),
                "itemId", rice.toString(), "amount", "50", "unit", "kg", "reference", "DN-77")).status()).isEqualTo(201);
        UUID soda = item(w.merchantId, "DEMO-SODA");
        long sodaVersion = owner.get(base(w.merchantId) + "/catalog/items/" + soda).json().path("version").asLong();
        assertThat(owner.put(base(w.merchantId) + "/catalog/items/" + soda + "/status", Map.of("expectedVersion", sodaVersion, "active", false)).status()).isEqualTo(200);
        var device = owner.get(base(w.merchantId) + "/entry-devices").json().get(0);
        assertThat(owner.post(base(w.merchantId) + "/entry-devices/" + device.path("id").asString() + "/revoke",
                Map.of("expectedVersion", device.path("version").asLong(), "reason", "Tag lost")).status()).isEqualTo(200);
        assertThat(owner.put(base(w.merchantId) + "/branches/" + branch(w.merchantId, "DEMORMR") + "/status", Map.of("status", "INACTIVE")).status()).isEqualTo(200);
        assertThat(owner.post(base(w.merchantId) + "/branches", Map.of("name", "Huye Market", "code", "HUY4", "status", "ACTIVE",
                "location", Map.of("province", "Southern", "district", "Huye", "sector", "Ngoma", "physicalAddress", "Market Rd"))).status()).isEqualTo(201);
        Map<String, Integer> beforeRerun = counts();

        SampleImporter again = shop("");
        SampleImporter.Preview preview = again.preview();
        assertThat(preview.writesAnything()).isFalse();
        assertThat(again.apply(preview.fingerprint()).created()).isZero();

        assertThat(counts()).isEqualTo(beforeRerun);
        assertThat(jdbc.queryForObject("select name from catalog_items where id = ?", String.class, rice)).isEqualTo("Rice (premium)");
        assertThat(jdbc.queryForObject("select price_per_sale_unit_rwf from catalog_items where id = ?", BigDecimal.class, rice)).isEqualByComparingTo("1350");
        assertThat(jdbc.queryForObject("select count(*) from catalog_item_prices where item_id = ?", Integer.class, rice)).isEqualTo(2);
        assertThat(jdbc.queryForObject("select quantity_on_hand from inventory_balances where item_id = ? and branch_id = ?", BigDecimal.class, rice, kigali))
                .isEqualByComparingTo("200000");
        assertThat(jdbc.queryForObject("select active from catalog_items where id = ?", Boolean.class, soda)).isFalse();
        assertThat(jdbc.queryForObject("select count(*) from payment_entry_devices where merchant_id = ? and status = 'REVOKED'", Integer.class, w.merchantId)).isEqualTo(1);
        assertThat(jdbc.queryForObject("select status from branches where id = ?", String.class, branch(w.merchantId, "DEMORMR"))).isEqualTo("INACTIVE");
        assertThat(jdbc.queryForObject("select count(*) from branches where merchant_id = ? and code = 'HUY4'", Integer.class, w.merchantId)).isEqualTo(1);
    }

    @Test
    void existingStockHistoryOrAUserOwnedRecordWithTheSameKeyIsLeftAlone() {
        // A person already made a branch with a sample code and gave a sample good some stock history before any import.
        assertThat(w.owner.post(base(w.merchantId) + "/branches", Map.of("name", "My own Kigali shop", "code", "DEMOKGL", "status", "ACTIVE",
                "location", Map.of("province", "Kigali City", "district", "Gasabo", "sector", "Remera", "physicalAddress", "KG 1 Ave"))).status()).isEqualTo(201);
        SampleImporter.Preview preview = shop("").preview();
        assertThat(steps(preview, "branch", SampleImporter.Action.KEEP)).isEqualTo(1);
        importAll(shop(""));
        assertThat(jdbc.queryForObject("select name from branches where merchant_id = ? and code = 'DEMOKGL'", String.class, w.merchantId)).isEqualTo("My own Kigali shop");
        // Their stock at that branch: the importer added it only where there was no history, never by overwriting anything.
        assertThat(jdbc.queryForObject("select count(*) from stock_movements where branch_id = ? and reference = ?", Integer.class, branch(w.merchantId, "DEMOKGL"),
                SampleDataPlan.BATCH)).isEqualTo(10);
    }

    // ---- confirmation ----------------------------------------------------------------------------------------------

    @Test
    void aMissingWrongOrStaleConfirmationWritesNothing() {
        Map<String, Integer> before = counts();
        for (String confirm : new String[] {"", "   ", "0000000000000000", "not-a-fingerprint"}) {
            assertThatThrownBy(() -> shop(confirm).apply(confirm)).isInstanceOf(SampleImportRefusedException.class).hasMessageContaining("confirmation does not match");
        }
        assertThatThrownBy(() -> shop("").apply(null)).isInstanceOf(SampleImportRefusedException.class);
        assertThat(counts()).isEqualTo(before);

        // A fingerprint from a real preview goes stale as soon as the data it was made from changes.
        String fingerprint = shop("").preview().fingerprint();
        assertThat(w.owner.post(base(w.merchantId) + "/branches", Map.of("name", "A person was quicker", "code", "DEMOKMR", "status", "ACTIVE",
                "location", Map.of("province", "Kigali City", "district", "Gasabo", "sector", "Kimironko", "physicalAddress", "KG 2 Ave"))).status()).isEqualTo(201);
        Map<String, Integer> changed = counts();
        assertThatThrownBy(() -> shop("").apply(fingerprint)).isInstanceOf(SampleImportRefusedException.class).hasMessageContaining("confirmation does not match");
        assertThat(counts()).isEqualTo(changed);
    }

    @Test
    void aConfirmationForOneMerchantCanNeverApplyToAnother() {
        String shopFingerprint = shop("").preview().fingerprint();
        String cafeFingerprint = cafe("").preview().fingerprint();
        assertThat(shopFingerprint).isNotEqualTo(cafeFingerprint);
        Map<String, Integer> before = counts();
        assertThatThrownBy(() -> cafe("").apply(shopFingerprint)).isInstanceOf(SampleImportRefusedException.class);
        assertThat(counts()).isEqualTo(before);
    }

    // ---- authentication and authorization ----------------------------------------------------------------------------

    @Test
    void onlyTheMerchantsAuthenticatedOwnerCanAuthoriseAnImport() {
        Map<String, Integer> before = counts();
        int failedBefore = jdbc.queryForObject("select coalesce(sum(failed_login_attempts), 0) from users", Integer.class);
        // Wrong password, unknown owner, a manager of the shop, a cashier of the shop, and the owner of a DIFFERENT business: all refused alike.
        for (SampleImporter importer : List.of(
                importer(w.merchantId, w.ownerPerson.email(), "Wrong-password-1", "", "", ""),
                importer(w.merchantId, "nobody@nowhere.rw", PASSWORD, "", "", ""),
                importer(w.merchantId, w.managerPerson.email(), PASSWORD, "", "", ""),
                importer(w.merchantId, w.cashierPerson.email(), PASSWORD, "", "", ""),
                importer(w.merchantId, w.cafePerson.email(), PASSWORD, "", "", ""),
                importer(w.cafeMerchantId, w.ownerPerson.email(), PASSWORD, "", "", ""))) {
            assertThatThrownBy(importer::preview).isInstanceOf(SampleImportRefusedException.class)
                    .hasMessageMatching(".*(owner credentials were not accepted|not an active OWNER).*");
            assertThatThrownBy(() -> importer.apply("0000000000000000")).isInstanceOf(SampleImportRefusedException.class);
        }
        // The two messages never say whether an address exists, and nothing was written, signed in or locked out.
        assertThatThrownBy(importer(w.merchantId, "nobody@nowhere.rw", PASSWORD, "", "", "")::preview).hasMessageContaining("credentials were not accepted");
        assertThatThrownBy(importer(w.merchantId, w.ownerPerson.email(), "Wrong-password-1", "", "", "")::preview).hasMessageContaining("credentials were not accepted");
        assertThat(counts()).isEqualTo(before);
        assertThat(jdbc.queryForObject("select coalesce(sum(failed_login_attempts), 0) from users", Integer.class)).isEqualTo(failedBefore);
    }

    @Test
    void anUnknownSuspendedOrUnnamedMerchantIsRefused() {
        assertThatThrownBy(() -> importer(UUID.randomUUID(), w.ownerPerson.email(), PASSWORD, "", "", "").preview()).isInstanceOf(SampleImportRefusedException.class);
        assertThatThrownBy(() -> new SampleImporter(jdbcClient, auth, passwords, branchService, invitations, catalog, inventory, devices, pos, audit, environment,
                new SampleImportSettings("", w.ownerPerson.email(), PASSWORD, "", "", "")).preview()).hasMessageContaining("merchant-id is required");
        jdbc.update("update merchants set status = 'suspended' where id = ?", w.merchantId);
        assertThatThrownBy(() -> shop("").preview()).hasMessageContaining("suspended");
        assertThat(jdbc.queryForObject("select count(*) from branches where code like 'DEMO%'", Integer.class)).isZero();
    }

    // ---- tenant isolation ------------------------------------------------------------------------------------------

    @Test
    void importingIntoOneMerchantTouchesNoRecordOfAnyOther() {
        Map<String, Integer> cafeBefore = tenantCounts(w.cafeMerchantId);
        List<Map<String, Object>> cafeUsers = jdbc.queryForList("select id, email, password_hash, status from users where email = ?", w.cafePerson.email());
        importAll(shop(""));
        assertThat(tenantCounts(w.cafeMerchantId)).isEqualTo(cafeBefore);
        assertThat(jdbc.queryForObject("select count(*) from branches where merchant_id = ? and code like 'DEMO%'", Integer.class, w.cafeMerchantId)).isZero();
        assertThat(jdbc.queryForList("select id, email, password_hash, status from users where email = ?", w.cafePerson.email())).isEqualTo(cafeUsers);
        // Every record the import created, and every audit line it wrote, belongs to the shop.
        assertThat(jdbc.queryForObject("select count(*) from audit_log where kind = 'SAMPLE_IMPORT_RUN' and merchant_id <> ?", Integer.class, w.merchantId)).isZero();
        assertThat(jdbc.queryForObject("select count(*) from stock_movements where reference = ? and merchant_id <> ?", Integer.class, SampleDataPlan.BATCH, w.merchantId)).isZero();
    }

    @Test
    void theSameDatasetCanBeAddedToTwoMerchantsAndEachKeepsItsOwnCopy() {
        Map<String, Integer> shopBefore = tenantCounts(w.merchantId);
        importAll(cafe(""));
        assertThat(tenantCounts(w.merchantId)).isEqualTo(shopBefore);
        importAll(shop(""));
        for (UUID m : List.of(w.merchantId, w.cafeMerchantId)) {
            assertThat(jdbc.queryForObject("select count(*) from branches where merchant_id = ? and code like 'DEMO%'", Integer.class, m)).isEqualTo(3);
            assertThat(jdbc.queryForObject("select count(*) from payment_entry_devices where merchant_id = ?", Integer.class, m)).isEqualTo(3);
            assertThat(jdbc.queryForObject("select count(*) from stock_movements where merchant_id = ? and reference = ?", Integer.class, m, SampleDataPlan.BATCH))
                    .isEqualTo(SampleDataPlan.STOCK.size());
        }
        // The two copies share nothing: the payment points have different public tokens and the items different identifiers.
        assertThat(jdbc.queryForObject("select count(distinct public_token) from payment_entry_devices", Integer.class)).isEqualTo(6);
        assertThat(jdbc.queryForObject("select count(distinct id) from catalog_items where code like 'DEMO-%'", Integer.class)).isEqualTo(24);
    }

    // ---- staff: the real invitation flow, no invented login ----------------------------------------------------------

    @Test
    void staffAreInvitedThroughTheRealFlowAndCannotSignInUntilTheyAcceptTheirOwnInvitation() {
        SampleImporter importer = importer(w.merchantId, w.ownerPerson.email(), PASSWORD, "", "manager.sample@example.rw", "cashier.one@example.rw, cashier.two@example.rw");
        SampleImporter.Preview preview = importer.preview();
        assertThat(steps(preview, "staff", SampleImporter.Action.CREATE)).isEqualTo(3);
        // The preview never prints a whole address and says plainly that a real email will be sent.
        assertThat(preview.render()).doesNotContain("manager.sample@example.rw").doesNotContain("cashier.one@example.rw").contains("REAL invitation email");
        importer.apply(preview.fingerprint());

        assertThat(jdbc.queryForObject("select count(*) from staff_invitations where merchant_id = ? and status = 'PENDING'", Integer.class, w.merchantId)).isEqualTo(3);
        assertThat(outbox("manager.sample@example.rw", "STAFF_INVITATION")).isEqualTo(1);
        // The invited people exist only as placeholders: no password, pending, and no branch yet (assigned when THEY accept).
        assertThat(jdbc.queryForObject("select count(*) from users where email like '%.sample@example.rw' or email like 'cashier.%@example.rw'", Integer.class)).isEqualTo(3);
        assertThat(jdbc.queryForList("select distinct status from users where email = 'manager.sample@example.rw'", String.class)).containsExactly("PENDING");
        var refused = new TestApi(mvc).post("/api/v1/auth/login", Map.of("email", "manager.sample@example.rw", "password", "Any-password-123"));
        assertThat(refused.status()).isEqualTo(401);
        assertThat(jdbc.queryForObject("select count(*) from branch_assignments a join memberships m on m.id = a.membership_id join users u on u.id = m.user_id "
                + "where u.email = 'manager.sample@example.rw'", Integer.class)).isZero();
        assertThat(jdbc.queryForObject("select count(*) from staff_invitation_branches b join staff_invitations i on i.id = b.invitation_id where i.email = 'manager.sample@example.rw'",
                Integer.class)).isEqualTo(2);

        // The manager completes the supported flow themselves: the link, their own name and their own password.
        String token = tokenFrom("manager.sample@example.rw", "/accept-invitation/");
        var accepted = new TestApi(mvc).post("/api/v1/auth/register", Map.of("fullName", "Sample Manager", "email", "manager.sample@example.rw",
                "password", "Own-chosen-pass-77", "invitationToken", token));
        assertThat(accepted.status()).as(accepted.body()).isEqualTo(200);
        assertThat(jdbc.queryForList("select b.code from branch_assignments a join memberships m on m.id = a.membership_id join users u on u.id = m.user_id "
                + "join branches b on b.id = a.branch_id where u.email = 'manager.sample@example.rw' and a.status = 'ACTIVE' order by b.code", String.class))
                .containsExactly("DEMOKGL", "DEMORMR");

        // A repeat run does not invite them again.
        SampleImporter again = importer(w.merchantId, w.ownerPerson.email(), PASSWORD, "", "manager.sample@example.rw", "cashier.one@example.rw, cashier.two@example.rw");
        assertThat(again.preview().writesAnything()).isFalse();
        assertThat(steps(again.preview(), "staff", SampleImporter.Action.KEEP)).isEqualTo(3);
        assertThat(outbox("manager.sample@example.rw", "STAFF_INVITATION")).isEqualTo(1);
    }

    @Test
    void theOwnersOwnAddressIsNeverInvitedAsStaff() {
        SampleImporter.Preview preview = importer(w.merchantId, w.ownerPerson.email(), PASSWORD, "", w.ownerPerson.email(), "").preview();
        assertThat(steps(preview, "staff", SampleImporter.Action.CREATE)).isZero();
    }

    // ---- POS drafts: only where the existing rules allow them ----------------------------------------------------------

    @Test
    void draftsAreMadeOnlyOnceTheOwnerIsAssignedToASampleBranchAndNeverChangeAnyone() {
        importAll(shop(""));
        // The owner assigns themself to a sample branch in the application; the importer never does that for them.
        UUID kigali = branch(w.merchantId, "DEMOKGL");
        List<String> current = jdbc.queryForList("select branch_id::text from branch_assignments where membership_id = ? and status = 'ACTIVE'", String.class, w.ownerMembershipId);
        java.util.ArrayList<String> assigned = new java.util.ArrayList<>(current);
        assigned.add(kigali.toString());
        assertThat(w.owner.put(base(w.merchantId) + "/memberships/" + w.ownerMembershipId + "/branch-assignments", Map.of("branchIds", assigned)).status()).isEqualTo(200);
        Map<String, Integer> before = counts();

        SampleImporter importer = shop("");
        SampleImporter.Preview preview = importer.preview();
        assertThat(steps(preview, "POS draft", SampleImporter.Action.CREATE)).isEqualTo(2);
        importer.apply(preview.fingerprint());

        Map<String, Integer> after = counts();
        assertThat(after.get("pos_drafts")).isEqualTo(before.get("pos_drafts") + 2);
        // A draft is a cart, never a sale: no invoice, no payment request, no reservation, no stock movement, no assignment change.
        for (String table : List.of("invoices", "payment_requests", "pos_sales", "stock_reservations", "stock_movements", "branch_assignments", "bank_transactions")) {
            assertThat(after.get(table)).as(table).isEqualTo(before.get(table));
        }
        assertThat(jdbc.queryForList("select distinct status from pos_drafts where merchant_id = ?", String.class, w.merchantId)).containsExactly("DRAFT");
        assertThat(jdbc.queryForList("select distinct created_by_user_id from pos_drafts where merchant_id = ?", UUID.class, w.merchantId)).containsExactly(w.ownerPerson.userId());
        // Again: nothing more, even after the owner discards one (it stays on record, final).
        UUID draft = jdbc.queryForObject("select id from pos_drafts where merchant_id = ? limit 1", UUID.class, w.merchantId);
        long version = jdbc.queryForObject("select version from pos_drafts where id = ?", Long.class, draft);
        assertThat(w.owner.delete(base(w.merchantId) + "/pos/drafts/" + draft + "?expectedVersion=" + version).status()).isEqualTo(200);
        SampleImporter third = shop("");
        assertThat(third.preview().writesAnything()).isFalse();
        assertThat(third.apply(third.preview().fingerprint()).created()).isZero();
        assertThat(counts().get("pos_drafts")).isEqualTo(after.get("pos_drafts"));
    }

    @Test
    void draftsAreSkippedForABusinessInSimplifiedMode() {
        jdbc.update("update merchant_settings set operating_mode = 'SIMPLIFIED' where merchant_id = ?", w.merchantId);
        SampleImporter.Preview preview = shop("").preview();
        assertThat(steps(preview, "POS draft", SampleImporter.Action.SKIP)).isEqualTo(2);
        assertThat(preview.steps().stream().filter(s -> s.kind().equals("POS draft")).map(SampleImporter.Step::reason).toList()).allSatisfy(r -> assertThat(r).contains("business mode"));
    }
}
