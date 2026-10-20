package rw.oupay.merchant;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.core.io.ClassPathResource;
import org.springframework.http.HttpMethod;
import rw.oupay.support.IntegrationTest;
import rw.oupay.support.TestApi;
import rw.oupay.support.World;

/** R1: the operating mode of a business: storage, backfill, authorisation, isolation, versioning and atomicity. */
class MerchantSettingsIT extends IntegrationTest {

    World w;

    @BeforeEach
    void world() {
        w = World.create(this);
    }

    private String settings(UUID merchantId) {
        return "/api/v1/merchants/" + merchantId + "/settings";
    }

    private Map<String, Object> change(String mode, long expectedVersion) {
        return Map.of("operatingMode", mode, "expectedVersion", expectedVersion);
    }

    private String storedMode(UUID merchantId) {
        return jdbc.queryForObject("select operating_mode from merchant_settings where merchant_id = ?", String.class, merchantId);
    }

    private Map<String, Object> registration(String legalName, String tin, String extraKey, Object extraValue) {
        var body = new HashMap<String, Object>(Map.of(
                "legalName", legalName, "businessType", "informal_vendor",
                "registration", Map.of("tin", tin),
                "location", Map.of("province", "Kigali City", "district", "Gasabo", "sector", "Remera", "physicalAddress", "KG 1"),
                "contact", Map.of("fullName", "A B", "email", "a@b.rw", "phoneNumber", "+250788123456")));
        if (extraKey != null) {
            body.put(extraKey, extraValue);
        }
        return body;
    }

    // ---- storage and backfill ------------------------------------------------------------------

    @Test
    void theMigrationBackfillsEveryExistingBusinessAsBusiness() throws IOException {
        // A business that predates the migration has no settings row. Run the migration's own backfill statement.
        jdbc.update("delete from merchant_settings where merchant_id = ?", w.merchantId);
        jdbc.update("delete from merchant_settings where merchant_id = ?", w.cafeMerchantId);
        String migration = new ClassPathResource("db/migration/V6__merchant_operating_mode.sql")
                .getContentAsString(StandardCharsets.UTF_8);
        Matcher backfill = Pattern.compile("(?s)INSERT INTO merchant_settings.*?;").matcher(migration);
        assertThat(backfill.find()).as("the migration contains a backfill statement").isTrue();

        jdbc.execute(backfill.group());

        assertThat(storedMode(w.merchantId)).isEqualTo("BUSINESS");
        assertThat(storedMode(w.cafeMerchantId)).isEqualTo("BUSINESS");
        // The backfill never touches the legal business type.
        assertThat(jdbc.queryForObject("select business_type from merchants where id = ?", String.class, w.merchantId))
                .isEqualTo("registered_company");
    }

    @Test
    void theDatabaseOnlyAcceptsTheSupportedModes() {
        assertThatThrownBy(() -> jdbc.update("update merchant_settings set operating_mode = 'HYBRID' where merchant_id = ?", w.merchantId))
                .hasMessageContaining("ck_merchant_settings_mode");
        assertThat(storedMode(w.merchantId)).isEqualTo("BUSINESS");
    }

    // ---- registration --------------------------------------------------------------------------

    @Test
    void aBusinessRegisteredWithoutAModeIsBusinessForBackwardCompatibility() {
        var created = w.owner.post("/api/v1/merchants", registration("Legacy Client Ltd", "111222333", null, null));
        assertThat(created.status()).isEqualTo(201);
        UUID id = UUID.fromString(created.json().path("id").asString());
        assertThat(created.json().path("operatingMode").asString()).isEqualTo("BUSINESS");
        assertThat(storedMode(id)).isEqualTo("BUSINESS");
        assertThat(jdbc.queryForObject("select version from merchant_settings where merchant_id = ?", Long.class, id)).isZero();
    }

    @Test
    void aBusinessRegisteredAsSimplifiedKeepsThatMode() {
        var created = w.owner.post("/api/v1/merchants", registration("Mama Jane Fruits", "444555666", "operatingMode", "SIMPLIFIED"));
        assertThat(created.status()).isEqualTo(201);
        UUID id = UUID.fromString(created.json().path("id").asString());
        assertThat(created.json().path("operatingMode").asString()).isEqualTo("SIMPLIFIED");
        assertThat(storedMode(id)).isEqualTo("SIMPLIFIED");
        assertThat(w.owner.get("/api/v1/merchants/" + id).json().path("operatingMode").asString()).isEqualTo("SIMPLIFIED");
        var modes = new ArrayList<String>();
        w.owner.get("/api/v1/merchants").json()
                .forEach(m -> modes.add(m.path("legalName").asString() + ":" + m.path("operatingMode").asString()));
        assertThat(modes).containsExactlyInAnyOrder("Sample Shop Ltd:BUSINESS", "Mama Jane Fruits:SIMPLIFIED");
        // The legal form is a separate fact and is untouched.
        assertThat(jdbc.queryForObject("select business_type from merchants where id = ?", String.class, id)).isEqualTo("informal_vendor");
    }

    @Test
    void anUnknownModeIsRejectedAndNothingIsCreated() {
        var response = w.owner.post("/api/v1/merchants", registration("Odd Mode Ltd", "777888999", "operatingMode", "HYBRID"));
        assertThat(response.status()).isBetween(400, 499);
        assertThat(jdbc.queryForObject("select count(*) from merchants where legal_name = 'Odd Mode Ltd'", Integer.class)).isZero();
    }

    @Test
    void registrationAndItsSettingsSucceedOrFailTogether() {
        jdbc.execute("create function fail_settings_insert() returns trigger as $$ begin raise exception 'settings refused'; end $$ language plpgsql");
        jdbc.execute("create trigger trg_fail_settings_insert before insert on merchant_settings "
                + "for each row execute function fail_settings_insert()");
        try {
            var response = w.cafeOwner.post("/api/v1/merchants", registration("Atomic Ltd", "123123123", "operatingMode", "SIMPLIFIED"));
            assertThat(response.status()).isGreaterThanOrEqualTo(400);
        } finally {
            jdbc.execute("drop trigger trg_fail_settings_insert on merchant_settings");
            jdbc.execute("drop function fail_settings_insert()");
        }
        assertThat(jdbc.queryForObject("select count(*) from merchants where legal_name = 'Atomic Ltd'", Integer.class)).isZero();
        assertThat(jdbc.queryForObject("select count(*) from memberships m join merchants x on x.id = m.merchant_id where x.legal_name = 'Atomic Ltd'",
                Integer.class)).isZero();
    }

    // ---- reading and authorisation -------------------------------------------------------------

    @Test
    void everyMemberMayReadTheModeButOnlyTheOwnerMayChangeIt() {
        for (TestApi member : List.of(w.owner, w.manager, w.cashier)) {
            var read = member.get(settings(w.merchantId));
            assertThat(read.status()).isEqualTo(200);
            assertThat(read.json().path("operatingMode").asString()).isEqualTo("BUSINESS");
            assertThat(read.json().path("version").asLong()).isZero();
        }
        assertThat(w.cashier.put(settings(w.merchantId), change("SIMPLIFIED", 0)).status()).isEqualTo(403);
        assertThat(w.manager.put(settings(w.merchantId), change("SIMPLIFIED", 0)).status()).isEqualTo(403);
        assertThat(storedMode(w.merchantId)).isEqualTo("BUSINESS");
    }

    @Test
    void theOwnerChangesTheModeWithoutTouchingHistory() {
        UUID invoiceId = w.issuedInvoice(5_000);
        var before = w.owner.get("/api/v1/merchants/" + w.merchantId + "/invoices/" + invoiceId).json();

        var changed = w.owner.put(settings(w.merchantId), change("SIMPLIFIED", 0));
        assertThat(changed.status()).isEqualTo(200);
        assertThat(changed.json().path("operatingMode").asString()).isEqualTo("SIMPLIFIED");
        assertThat(changed.json().path("version").asLong()).isEqualTo(1);
        assertThat(storedMode(w.merchantId)).isEqualTo("SIMPLIFIED");
        assertThat(w.owner.get("/api/v1/merchants/" + w.merchantId).json().path("operatingMode").asString()).isEqualTo("SIMPLIFIED");
        assertThat(jdbc.queryForObject("select count(*) from audit_log where kind = 'MERCHANT_OPERATING_MODE_CHANGED' and merchant_id = ?",
                Integer.class, w.merchantId)).isEqualTo(1);

        // Existing invoices, memberships and sessions are unaffected.
        var after = w.owner.get("/api/v1/merchants/" + w.merchantId + "/invoices/" + invoiceId).json();
        assertThat(after).isEqualTo(before);
        assertThat(after.path("status").asString()).isEqualTo("ISSUED");
        assertThat(jdbc.queryForObject("select count(*) from memberships where merchant_id = ? and status = 'ACTIVE'", Integer.class, w.merchantId))
                .isEqualTo(4);
        assertThat(w.cashier.get("/api/v1/merchants/" + w.merchantId + "/invoices").status()).isEqualTo(200);
        // Switching back is just as harmless.
        assertThat(w.owner.put(settings(w.merchantId), change("BUSINESS", 1)).status()).isEqualTo(200);
    }

    @Test
    void settingTheModeItAlreadyHasChangesNothing() {
        var same = w.owner.put(settings(w.merchantId), change("BUSINESS", 0));
        assertThat(same.status()).isEqualTo(200);
        assertThat(same.json().path("version").asLong()).isZero();
        assertThat(jdbc.queryForObject("select count(*) from audit_log where kind = 'MERCHANT_OPERATING_MODE_CHANGED'", Integer.class)).isZero();
    }

    @Test
    void aSuspendedBusinessCannotBeReconfigured() {
        jdbc.update("update merchants set status = 'suspended' where id = ?", w.merchantId);
        var response = w.owner.put(settings(w.merchantId), change("SIMPLIFIED", 0));
        assertThat(response.status()).isEqualTo(409);
        assertThat(response.code()).isEqualTo("profile_locked");
        assertThat(storedMode(w.merchantId)).isEqualTo("BUSINESS");
    }

    @Test
    void invalidRequestsAreRejected() {
        assertThat(w.owner.put(settings(w.merchantId), Map.of("operatingMode", "SIMPLIFIED")).status()).isBetween(400, 499);
        assertThat(w.owner.put(settings(w.merchantId), Map.of("expectedVersion", 0)).status()).isBetween(400, 499);
        assertThat(w.owner.put(settings(w.merchantId), change("HYBRID", 0)).status()).isBetween(400, 499);
        assertThat(storedMode(w.merchantId)).isEqualTo("BUSINESS");
    }

    // ---- isolation -----------------------------------------------------------------------------

    @Test
    void nobodyCanReadOrChangeAnotherBusinessesSettings() {
        var read = w.cafeOwner.get(settings(w.merchantId));
        assertThat(read.status()).isEqualTo(404);
        // Identical to a business that does not exist: nothing is revealed.
        assertThat(read.body()).isEqualTo(w.cafeOwner.get(settings(UUID.randomUUID())).body());
        assertThat(w.cafeOwner.put(settings(w.merchantId), change("SIMPLIFIED", 0)).status()).isEqualTo(404);
        assertThat(w.owner.put(settings(w.cafeMerchantId), change("SIMPLIFIED", 0)).status()).isEqualTo(404);
        assertThat(storedMode(w.merchantId)).isEqualTo("BUSINESS");
        assertThat(storedMode(w.cafeMerchantId)).isEqualTo("BUSINESS");
    }

    @Test
    void anonymousCallersAreRefused() {
        var anonymous = TestApi.anonymous(mvc, HttpMethod.GET, settings(w.merchantId), null, Map.of());
        assertThat(anonymous.status()).isEqualTo(401);
    }

    // ---- versioning ----------------------------------------------------------------------------

    @Test
    void aStaleVersionIsRejected() {
        assertThat(w.owner.put(settings(w.merchantId), change("SIMPLIFIED", 0)).status()).isEqualTo(200);
        var stale = w.owner.put(settings(w.merchantId), change("BUSINESS", 0));
        assertThat(stale.status()).isEqualTo(409);
        assertThat(stale.code()).isEqualTo("version_conflict");
        assertThat(storedMode(w.merchantId)).isEqualTo("SIMPLIFIED");
    }

    @Test
    void twoSimultaneousChangesFromTheSameVersionCannotBothSucceed() throws Exception {
        assertThat(w.owner.put(settings(w.merchantId), change("SIMPLIFIED", 0)).status()).isEqualTo(200);
        // Two separate sign-ins, as two browser tabs or devices would be.
        TestApi first = fixtures.signIn(mvc, w.ownerPerson);
        TestApi second = fixtures.signIn(mvc, w.ownerPerson);

        List<Integer> statuses = concurrently(List.of(
                () -> first.put(settings(w.merchantId), change("BUSINESS", 1)).status(),
                () -> second.put(settings(w.merchantId), change("BUSINESS", 1)).status()));

        assertThat(statuses).containsExactlyInAnyOrder(200, 409);
        assertThat(storedMode(w.merchantId)).isEqualTo("BUSINESS");
        assertThat(jdbc.queryForObject("select version from merchant_settings where merchant_id = ?", Long.class, w.merchantId)).isEqualTo(2);
    }

    @Test
    void twoSimultaneousFirstChangesOnABusinessWithoutARowCreateOneRowAndOneWinner() throws Exception {
        jdbc.update("delete from merchant_settings where merchant_id = ?", w.merchantId);
        TestApi first = fixtures.signIn(mvc, w.ownerPerson);
        TestApi second = fixtures.signIn(mvc, w.ownerPerson);

        List<Integer> statuses = concurrently(List.of(
                () -> first.put(settings(w.merchantId), change("SIMPLIFIED", 0)).status(),
                () -> second.put(settings(w.merchantId), change("SIMPLIFIED", 0)).status()));

        // Never a server error from a duplicate key: one change wins, the other is told to reload.
        assertThat(statuses).containsExactlyInAnyOrder(200, 409);
        assertThat(jdbc.queryForObject("select count(*) from merchant_settings where merchant_id = ?", Integer.class, w.merchantId)).isEqualTo(1);
        assertThat(storedMode(w.merchantId)).isEqualTo("SIMPLIFIED");
        assertThat(jdbc.queryForObject("select version from merchant_settings where merchant_id = ?", Long.class, w.merchantId)).isEqualTo(1);
    }

    // ---- compatibility with the previous application version -----------------------------------

    @Test
    void aBusinessWithoutASettingsRowIsReadAsBusinessAndGetsOneOnFirstChange() {
        // What an older application version leaves behind when it registers a business during a rolling deploy.
        jdbc.update("delete from merchant_settings where merchant_id = ?", w.merchantId);

        var read = w.cashier.get(settings(w.merchantId));
        assertThat(read.status()).isEqualTo(200);
        assertThat(read.json().path("operatingMode").asString()).isEqualTo("BUSINESS");
        assertThat(read.json().path("version").asLong()).isZero();
        assertThat(w.owner.get("/api/v1/merchants/" + w.merchantId).json().path("operatingMode").asString()).isEqualTo("BUSINESS");
        assertThat(w.owner.get("/api/v1/merchants").json().get(0).path("operatingMode").asString()).isEqualTo("BUSINESS");

        assertThat(w.owner.put(settings(w.merchantId), change("SIMPLIFIED", 0)).status()).isEqualTo(200);
        assertThat(storedMode(w.merchantId)).isEqualTo("SIMPLIFIED");
    }

    @Test
    void existingMerchantEndpointsKeepTheirShape() {
        var merchant = w.owner.get("/api/v1/merchants/" + w.merchantId).json();
        for (String field : List.of("id", "ownerUserId", "legalName", "businessType", "status", "registration", "location", "contact",
                "bankingConfiguration", "createdAt", "updatedAt")) {
            assertThat(merchant.has(field)).as(field).isTrue();
        }
        assertThat(merchant.path("businessType").asString()).isEqualTo("registered_company");
        var update = Map.of("tradingName", "Shop", "physicalAddress", "KG 99",
                "contact", Map.of("fullName", "New Contact", "email", "new@shop.rw", "phoneNumber", "+250788999999"));
        var updated = w.owner.put("/api/v1/merchants/" + w.merchantId, update);
        assertThat(updated.status()).isEqualTo(200);
        assertThat(updated.json().path("operatingMode").asString()).isEqualTo("BUSINESS");
    }

    /** Runs all tasks at (nearly) the same instant and returns their results. */
    private <T> List<T> concurrently(List<Callable<T>> tasks) throws Exception {
        ExecutorService pool = Executors.newFixedThreadPool(tasks.size());
        try {
            CountDownLatch ready = new CountDownLatch(tasks.size());
            CountDownLatch go = new CountDownLatch(1);
            List<Future<T>> futures = new ArrayList<>();
            for (Callable<T> task : tasks) {
                futures.add(pool.submit(() -> {
                    ready.countDown();
                    go.await();
                    return task.call();
                }));
            }
            ready.await();
            go.countDown();
            List<T> results = new ArrayList<>();
            for (Future<T> future : futures) {
                results.add(future.get(30, TimeUnit.SECONDS));
            }
            return results;
        } finally {
            pool.shutdownNow();
        }
    }
}
