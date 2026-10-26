package rw.oupay.catalog;

import static org.assertj.core.api.Assertions.assertThat;

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
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import rw.oupay.support.IntegrationTest;
import rw.oupay.support.TestApi;
import rw.oupay.support.World;
import tools.jackson.databind.JsonNode;

/** R5b: the goods and services catalog through the real API: isolation, authorisation, units, prices, packages, concurrency. */
class CatalogIT extends IntegrationTest {

    World w;

    @BeforeEach
    void world() {
        w = World.create(this);
    }

    private String base() {
        return base(w.merchantId);
    }

    private static String base(UUID merchantId) {
        return "/api/v1/merchants/" + merchantId + "/catalog";
    }

    private static Map<String, Object> goods(String name, String code, String dimension, String saleUnit, long price) {
        Map<String, Object> body = new HashMap<>();
        body.put("itemType", "GOODS");
        body.put("name", name);
        if (code != null) {
            body.put("code", code);
        }
        body.put("measurementDimension", dimension);
        body.put("saleUnit", saleUnit);
        body.put("pricePerSaleUnitRwf", price);
        return body;
    }

    private static Map<String, Object> service(String name, String code, long price) {
        Map<String, Object> body = new HashMap<>();
        body.put("itemType", "SERVICE");
        body.put("name", name);
        if (code != null) {
            body.put("code", code);
        }
        body.put("pricePerSaleUnitRwf", price);
        return body;
    }

    private JsonNode created(TestApi api, Map<String, Object> body) {
        var response = api.post(base() + "/items", body);
        assertThat(response.status()).as(response.body()).isEqualTo(201);
        return response.json();
    }

    private JsonNode rice() {
        return created(w.owner, goods("Rice", "RICE-25", "MASS", "kg", 1_500));
    }

    /** An update body that repeats the item's current values, with the given overrides. */
    private static Map<String, Object> change(JsonNode item, Map<String, Object> overrides) {
        Map<String, Object> body = new HashMap<>();
        body.put("expectedVersion", item.path("version").asLong());
        body.put("name", item.path("name").asString());
        body.put("code", isAbsent(item.path("code")) ? null : item.path("code").asString());
        body.put("saleUnit", item.path("saleUnit").asString());
        body.put("pricePerSaleUnitRwf", item.path("pricePerSaleUnitRwf").asLong());
        body.putAll(overrides);
        return body;
    }

    private String itemUrl(JsonNode item) {
        return base() + "/items/" + item.path("id").asString();
    }

    private TestApi.Response update(TestApi api, JsonNode item, Map<String, Object> overrides) {
        return api.put(itemUrl(item), change(item, overrides));
    }

    private void setMode(UUID merchantId, String mode) {
        jdbc.update("insert into merchant_settings (merchant_id, operating_mode, updated_at, version) values (?, ?, now(), 0) "
                + "on conflict (merchant_id) do update set operating_mode = excluded.operating_mode", merchantId, mode);
    }

    private long auditCount(String kind) {
        return jdbc.queryForObject("select count(*) from audit_log where kind = ?", Long.class, kind);
    }

    // --- create, read, list, search, filter -------------------------------------------------------------

    @Test
    void createsGoodsAndServicesInTheSameCatalog() {
        JsonNode rice = rice();
        assertThat(rice.path("itemType").asString()).isEqualTo("GOODS");
        assertThat(rice.path("code").asString()).isEqualTo("RICE-25");
        assertThat(rice.path("measurementDimension").asString()).isEqualTo("MASS");
        assertThat(rice.path("stockUnit").asString()).isEqualTo("g");
        assertThat(rice.path("saleUnit").asString()).isEqualTo("kg");
        assertThat(rice.path("pricePerSaleUnitRwf").asLong()).isEqualTo(1_500);
        assertThat(rice.path("priceVersion").asInt()).isEqualTo(1);
        assertThat(rice.path("active").asBoolean()).isTrue();
        assertThat(rice.path("merchantId").asString()).isEqualTo(w.merchantId.toString());

        JsonNode haircut = created(w.manager, service("Haircut", null, 3_000));
        assertThat(haircut.path("itemType").asString()).isEqualTo("SERVICE");
        assertThat(haircut.path("measurementDimension").asString()).isEqualTo("COUNT");
        assertThat(isAbsent(haircut.path("stockUnit"))).isTrue();
        assertThat(haircut.path("saleUnit").asString()).isEqualTo("pc");
        assertThat(isAbsent(haircut.path("code"))).isTrue();

        var fetched = w.cashier.get(itemUrl(rice));
        assertThat(fetched.status()).isEqualTo(200);
        assertThat(fetched.json().path("name").asString()).isEqualTo("Rice");
        assertThat(rice.path("packages").size()).isEqualTo(0);
    }

    @Test
    void createsTheDocumentedExamplesWithTheirUnits() {
        assertThat(created(w.owner, goods("Cooking oil", null, "VOLUME", "l", 2_500)).path("stockUnit").asString()).isEqualTo("ml");
        assertThat(created(w.owner, goods("Cement", null, "COUNT", "pc", 14_000)).path("stockUnit").asString()).isEqualTo("pc");
        assertThat(created(w.owner, goods("Fabric", null, "LENGTH", "m", 4_000)).path("stockUnit").asString()).isEqualTo("mm");
        assertThat(created(w.owner, goods("Tiles", null, "AREA", "m2", 18_000)).path("stockUnit").asString()).isEqualTo("mm2");
        assertThat(created(w.owner, goods("Phone", null, "COUNT", "pc", 150_000)).path("saleUnit").asString()).isEqualTo("pc");
        assertThat(created(w.owner, goods("Sugar", null, "MASS", "g", 3)).path("saleUnit").asString()).isEqualTo("g");
        assertThat(created(w.owner, service("Car wash", "WASH", 5_000)).path("itemType").asString()).isEqualTo("SERVICE");
    }

    @Test
    void listsWithPaginationNewestFirst() {
        List<String> names = new ArrayList<>();
        for (int i = 1; i <= 5; i++) {
            names.add(created(w.owner, goods("Item " + i, null, "COUNT", "pc", 100 * i)).path("name").asString());
        }
        var first = w.owner.get(base() + "/items?limit=2").json();
        assertThat(first.path("items").size()).isEqualTo(2);
        assertThat(first.path("items").get(0).path("name").asString()).isEqualTo("Item 5");
        assertThat(first.path("items").get(1).path("name").asString()).isEqualTo("Item 4");
        String cursor = first.path("nextCursor").asString();
        assertThat(cursor).isNotEmpty();

        var second = w.owner.get(base() + "/items?limit=2&cursor=" + cursor).json();
        assertThat(second.path("items").get(0).path("name").asString()).isEqualTo("Item 3");
        var third = w.owner.get(base() + "/items?limit=2&cursor=" + second.path("nextCursor").asString()).json();
        assertThat(third.path("items").size()).isEqualTo(1);
        assertThat(third.path("items").get(0).path("name").asString()).isEqualTo("Item 1");
        assertThat(isAbsent(third.path("nextCursor"))).isTrue();
        assertThat(w.owner.get(base() + "/items?cursor=not-a-cursor").status()).isEqualTo(400);
    }

    @Test
    void searchesByNameOrCodeAndFiltersByTypeAndStatus() {
        created(w.owner, goods("Basmati rice", "RICE-B", "MASS", "kg", 2_000));
        created(w.owner, goods("Cooking oil", "OIL-1", "VOLUME", "l", 2_500));
        created(w.owner, service("Rice milling", "MILL", 800));
        JsonNode inactive = created(w.owner, goods("Old stock", "OLD", "COUNT", "pc", 10));
        assertThat(w.owner.put(itemUrl(inactive) + "/status", Map.of("expectedVersion", inactive.path("version").asLong(), "active", false)).status())
                .isEqualTo(200);

        assertThat(names(w.owner.get(base() + "/items?q=rice"))).containsExactlyInAnyOrder("Basmati rice", "Rice milling");
        assertThat(names(w.owner.get(base() + "/items?q=RICE"))).containsExactlyInAnyOrder("Basmati rice", "Rice milling");
        assertThat(names(w.owner.get(base() + "/items?q=oil-1"))).containsExactly("Cooking oil");
        assertThat(names(w.owner.get(base() + "/items?q=nothing-like-this"))).isEmpty();
        assertThat(names(w.owner.get(base() + "/items?type=SERVICE"))).containsExactly("Rice milling");
        assertThat(names(w.owner.get(base() + "/items?type=GOODS"))).containsExactlyInAnyOrder("Basmati rice", "Cooking oil", "Old stock");
        assertThat(names(w.owner.get(base() + "/items?type=GOODS&q=rice"))).containsExactly("Basmati rice");
        assertThat(names(w.owner.get(base() + "/items?active=false"))).containsExactly("Old stock");
        assertThat(names(w.owner.get(base() + "/items?active=true"))).containsExactlyInAnyOrder("Basmati rice", "Cooking oil", "Rice milling");
        assertThat(w.owner.get(base() + "/items?type=WIDGET").status()).isEqualTo(400);
    }

    @Test
    void searchTreatsWildcardCharactersAsPlainText() {
        created(w.owner, goods("100% cotton", null, "LENGTH", "m", 3_000));
        created(w.owner, goods("Plain cotton", null, "LENGTH", "m", 2_000));
        created(w.owner, goods("Under_score", null, "COUNT", "pc", 10));
        assertThat(names(w.owner.get(base() + "/items?q=100%25"))).containsExactly("100% cotton");
        assertThat(names(w.owner.get(base() + "/items?q=%25"))).containsExactly("100% cotton");
        assertThat(names(w.owner.get(base() + "/items?q=_"))).containsExactly("Under_score");
        assertThat(w.owner.get(base() + "/items?q=" + "x".repeat(101)).status()).isEqualTo(422);
    }

    private static boolean isAbsent(JsonNode node) {
        return node.isMissingNode() || node.isNull();
    }

    private List<String> names(TestApi.Response response) {
        assertThat(response.status()).as(response.body()).isEqualTo(200);
        List<String> result = new ArrayList<>();
        for (JsonNode item : response.json().path("items")) {
            result.add(item.path("name").asString());
        }
        return result;
    }

    // --- goods versus services --------------------------------------------------------------------------

    @Test
    void servicesHaveNoMeasurementOrStockAndGoodsRequireBoth() {
        Map<String, Object> badService = service("Repair", null, 1_000);
        badService.put("measurementDimension", "MASS");
        badService.put("saleUnit", "kg");
        var rejected = w.owner.post(base() + "/items", badService);
        assertThat(rejected.status()).isEqualTo(422);
        assertThat(rejected.code()).isEqualTo("invalid_unit_configuration");

        assertThat(w.owner.post(base() + "/items", service("Repair", null, 1_000)).status()).isEqualTo(201);

        Map<String, Object> noUnits = goods("Flour", null, null, null, 900);
        assertThat(w.owner.post(base() + "/items", noUnits).code()).isEqualTo("invalid_unit_configuration");
        assertThat(w.owner.post(base() + "/items", goods("Flour", null, "MASS", null, 900)).code()).isEqualTo("invalid_unit_configuration");
        assertThat(w.owner.post(base() + "/items", goods("Flour", null, null, "kg", 900)).code()).isEqualTo("invalid_unit_configuration");
    }

    @Test
    void rejectsIncompatibleAndUnknownUnits() {
        assertThat(w.owner.post(base() + "/items", goods("Oil", null, "VOLUME", "kg", 100)).code()).isEqualTo("invalid_unit_configuration");
        assertThat(w.owner.post(base() + "/items", goods("Cloth", null, "LENGTH", "m2", 100)).code()).isEqualTo("invalid_unit_configuration");
        assertThat(w.owner.post(base() + "/items", goods("Rice", null, "MASS", "pc", 100)).code()).isEqualTo("invalid_unit_configuration");
        assertThat(w.owner.post(base() + "/items", goods("Rice", null, "MASS", "stone", 100)).code()).isEqualTo("unsupported_unit");
        assertThat(w.owner.post(base() + "/items", goods("Rice", null, "WEIGHT", "kg", 100)).code()).isEqualTo("invalid_unit_configuration");
        assertThat(w.owner.post(base() + "/items", goods("Rice", null, "MASS", "kg", 100)).status()).isEqualTo(201);
    }

    @Test
    void theSaleUnitCanChangeWithinTheDimensionButNotAcrossIt() {
        JsonNode rice = rice();
        var toGrams = update(w.owner, rice, Map.of("saleUnit", "g", "pricePerSaleUnitRwf", 2));
        assertThat(toGrams.status()).as(toGrams.body()).isEqualTo(200);
        assertThat(toGrams.json().path("saleUnit").asString()).isEqualTo("g");
        assertThat(toGrams.json().path("stockUnit").asString()).isEqualTo("g");
        assertThat(toGrams.json().path("priceVersion").asInt()).isEqualTo(2);

        var acrossDimensions = update(w.owner, toGrams.json(), Map.of("saleUnit", "l"));
        assertThat(acrossDimensions.status()).isEqualTo(422);
        assertThat(acrossDimensions.code()).isEqualTo("invalid_unit_configuration");

        JsonNode haircut = created(w.owner, service("Haircut", null, 3_000));
        assertThat(update(w.owner, haircut, Map.of("saleUnit", "kg")).code()).isEqualTo("invalid_unit_configuration");
        assertThat(update(w.owner, haircut, Map.of("saleUnit", "pc", "pricePerSaleUnitRwf", 3_500)).status()).isEqualTo(200);
    }

    @Test
    void theItemTypeAndMeasurementCannotBeChangedByAnUpdate() {
        JsonNode rice = rice();
        Map<String, Object> body = change(rice, Map.of());
        body.put("itemType", "SERVICE");
        body.put("measurementDimension", "VOLUME");
        var response = w.owner.put(itemUrl(rice), body);
        assertThat(response.status()).isIn(200, 400);
        var stored = w.owner.get(itemUrl(rice)).json();
        assertThat(stored.path("itemType").asString()).isEqualTo("GOODS");
        assertThat(stored.path("measurementDimension").asString()).isEqualTo("MASS");
        assertThat(stored.path("stockUnit").asString()).isEqualTo("g");
    }

    // --- validation -------------------------------------------------------------------------------------

    @Test
    void validatesNamesCodesAndPrices() {
        assertThat(w.owner.post(base() + "/items", goods(" ", null, "COUNT", "pc", 10)).status()).isEqualTo(422);
        assertThat(w.owner.post(base() + "/items", goods("x".repeat(121), null, "COUNT", "pc", 10)).status()).isEqualTo(422);
        assertThat(w.owner.post(base() + "/items", goods("Bad code", "has space", "COUNT", "pc", 10)).status()).isEqualTo(422);
        assertThat(w.owner.post(base() + "/items", goods("Negative", null, "COUNT", "pc", -1)).status()).isEqualTo(422);
        assertThat(w.owner.post(base() + "/items", goods("Huge", null, "COUNT", "pc", 1_000_000_001L)).status()).isEqualTo(422);
        assertThat(w.owner.post(base() + "/items", goods("Fraction", null, "COUNT", "pc", 0)).status()).isEqualTo(201);
        assertThat(w.owner.post(base() + "/items", goods("Top", null, "COUNT", "pc", 1_000_000_000L)).status()).isEqualTo(201);
        Map<String, Object> noPrice = goods("No price", null, "COUNT", "pc", 1);
        noPrice.remove("pricePerSaleUnitRwf");
        assertThat(w.owner.post(base() + "/items", noPrice).status()).isEqualTo(422);
    }

    private static String rawItem(String name, String price) {
        return "{\"itemType\":\"GOODS\",\"name\":\"" + name + "\",\"measurementDimension\":\"COUNT\",\"saleUnit\":\"pc\","
                + "\"pricePerSaleUnitRwf\":" + price + "}";
    }

    /** The JSON mapper coerces a float into a long by truncating; a price of 10.5 must be refused, never stored as 10. */
    @Test
    void fractionalPricesAreRejectedWithA400AndNeverTruncated() {
        for (String fraction : List.of("10.5", "0.5", "10.000001", "1500.99", "0.0000001", "\"10.5\"")) {
            var response = w.owner.post(base() + "/items", rawItem("Fractional", fraction));
            assertThat(response.status()).as(fraction + " -> " + response.body()).isEqualTo(400);
        }
        assertThat(jdbc.queryForObject("select count(*) from catalog_items", Long.class)).isZero();
        // A whole number written with a decimal point is still exactly that number.
        var whole = w.owner.post(base() + "/items", rawItem("Whole", "10.0"));
        assertThat(whole.status()).as(whole.body()).isEqualTo(201);
        assertThat(whole.json().path("pricePerSaleUnitRwf").asLong()).isEqualTo(10);
        var exponent = w.owner.post(base() + "/items", rawItem("Exponent", "1E+3"));
        assertThat(exponent.status()).as(exponent.body()).isEqualTo(201);
        assertThat(exponent.json().path("pricePerSaleUnitRwf").asLong()).isEqualTo(1_000);
        // Out-of-range values keep their validation answer.
        assertThat(w.owner.post(base() + "/items", rawItem("Negative", "-0.5")).status()).isIn(400, 422);
        assertThat(w.owner.post(base() + "/items", rawItem("Huge", "1E+999999999")).status()).isEqualTo(422);
    }

    @Test
    void aFractionalPriceOnUpdateChangesNothing() {
        JsonNode rice = rice();
        String json = "{\"expectedVersion\":" + rice.path("version").asLong() + ",\"name\":\"Rice\",\"code\":\"RICE-25\","
                + "\"saleUnit\":\"kg\",\"pricePerSaleUnitRwf\":1500.5}";
        assertThat(w.owner.put(itemUrl(rice), json).status()).isEqualTo(400);
        var stored = w.owner.get(itemUrl(rice)).json();
        assertThat(stored.path("pricePerSaleUnitRwf").asLong()).isEqualTo(1_500);
        assertThat(stored.path("version").asLong()).isEqualTo(rice.path("version").asLong());
        assertThat(w.owner.get(itemUrl(rice) + "/price-history").json().size()).isEqualTo(1);
        assertThat(auditCount("CATALOG_PRICE_CHANGED")).isZero();
    }

    @Test
    void trimsTextAndNormalisesTheCode() {
        JsonNode item = created(w.owner, goods("  Padded name  ", "abc-1", "COUNT", "pc", 10));
        assertThat(item.path("name").asString()).isEqualTo("Padded name");
        assertThat(item.path("code").asString()).isEqualTo("ABC-1");
        JsonNode blankCode = created(w.owner, goods("Blank code", "", "COUNT", "pc", 10));
        assertThat(isAbsent(blankCode.path("code"))).isTrue();
    }

    // --- duplicate codes --------------------------------------------------------------------------------

    @Test
    void codesAreUniquePerMerchantCaseInsensitivelyAndOptional() {
        created(w.owner, goods("First", "SKU-1", "COUNT", "pc", 10));
        var duplicate = w.owner.post(base() + "/items", goods("Second", "sku-1", "COUNT", "pc", 10));
        assertThat(duplicate.status()).isEqualTo(409);
        assertThat(duplicate.code()).isEqualTo("duplicate_code");
        // Items without a code never collide, and another business may use the same code.
        created(w.owner, goods("No code A", null, "COUNT", "pc", 10));
        created(w.owner, goods("No code B", null, "COUNT", "pc", 10));
        var cafe = w.cafeOwner.post(base(w.cafeMerchantId) + "/items", goods("Cafe item", "SKU-1", "COUNT", "pc", 10));
        assertThat(cafe.status()).as(cafe.body()).isEqualTo(201);
    }

    @Test
    void renamingToAnExistingCodeIsRejectedButKeepingYourOwnIsFine() {
        JsonNode first = created(w.owner, goods("First", "A1", "COUNT", "pc", 10));
        JsonNode second = created(w.owner, goods("Second", "B1", "COUNT", "pc", 10));
        assertThat(update(w.owner, second, Map.of("code", "a1")).code()).isEqualTo("duplicate_code");
        assertThat(update(w.owner, first, Map.of("code", "a1", "name", "First renamed")).status()).isEqualTo(200);
        assertThat(update(w.owner, second, Map.of("code", "C1")).status()).isEqualTo(200);
    }

    @Test
    void concurrentCreationWithTheSameCodeCreatesExactlyOneItem() throws Exception {
        List<Callable<TestApi.Response>> tasks = new ArrayList<>();
        for (int i = 0; i < 4; i++) {
            TestApi api = i % 2 == 0 ? w.owner : w.manager;
            int n = i;
            tasks.add(() -> api.post(base() + "/items", goods("Racer " + n, "RACE", "COUNT", "pc", 10)));
        }
        List<TestApi.Response> results = runTogether(tasks);
        assertThat(results.stream().filter(r -> r.status() == 201).count()).isEqualTo(1);
        assertThat(results.stream().filter(r -> r.status() == 409).count()).isEqualTo(3);
        assertThat(jdbc.queryForObject("select count(*) from catalog_items where merchant_id = ?", Long.class, w.merchantId)).isEqualTo(1);
        assertThat(jdbc.queryForObject("select count(*) from catalog_item_prices", Long.class)).isEqualTo(1);
    }

    // --- authorisation and isolation --------------------------------------------------------------------

    @Test
    void ownersAndManagersManageWhileCashiersOnlyRead() {
        JsonNode rice = rice();
        // Manager: full management.
        JsonNode oil = created(w.manager, goods("Oil", null, "VOLUME", "l", 2_500));
        assertThat(update(w.manager, oil, Map.of("pricePerSaleUnitRwf", 2_600)).status()).isEqualTo(200);

        // Cashier: read-only.
        assertThat(w.cashier.get(base() + "/items").status()).isEqualTo(200);
        assertThat(w.cashier.get(itemUrl(rice)).status()).isEqualTo(200);
        assertThat(w.cashier.get(base() + "/measurement-units").status()).isEqualTo(200);
        assertThat(w.cashier.get(itemUrl(rice) + "/price-history").status()).isEqualTo(200);
        assertThat(w.cashier.post(base() + "/items", goods("Nope", null, "COUNT", "pc", 1)).status()).isEqualTo(403);
        assertThat(update(w.cashier, rice, Map.of("pricePerSaleUnitRwf", 1)).status()).isEqualTo(403);
        assertThat(w.cashier.put(itemUrl(rice) + "/status", Map.of("expectedVersion", 0, "active", false)).status()).isEqualTo(403);
        assertThat(w.cashier.post(itemUrl(rice) + "/packages", Map.of("label", "Bag", "contentsAmount", "25", "contentsUnit", "kg")).status())
                .isEqualTo(403);
        assertThat(w.cashier.put(itemUrl(rice) + "/packages/" + UUID.randomUUID(), Map.of("expectedVersion", 0, "label", "Bag",
                "contentsAmount", "25", "contentsUnit", "kg", "active", true)).status()).isEqualTo(403);
        // Nothing changed behind the 403s.
        assertThat(w.owner.get(itemUrl(rice)).json().path("pricePerSaleUnitRwf").asLong()).isEqualTo(1_500);
    }

    @Test
    void anonymousCallersAreRejected() {
        assertThat(new TestApi(mvc).get(base() + "/items").status()).isEqualTo(401);
        assertThat(new TestApi(mvc).post(base() + "/items", goods("Nope", null, "COUNT", "pc", 1)).status()).isIn(401, 403);
    }

    @Test
    void anotherBusinessCannotSeeOrChangeTheCatalog() {
        JsonNode rice = rice();
        // A stranger is told the business does not exist, never that it does.
        assertThat(w.cafeOwner.get(base() + "/items").status()).isEqualTo(404);
        assertThat(w.cafeOwner.get(itemUrl(rice)).status()).isEqualTo(404);
        assertThat(w.cafeOwner.post(base() + "/items", goods("Intruder", null, "COUNT", "pc", 1)).status()).isEqualTo(404);
        assertThat(update(w.cafeOwner, rice, Map.of("pricePerSaleUnitRwf", 1)).status()).isEqualTo(404);

        // Their own catalog is separate; the shop's item id is not reachable through it.
        assertThat(created(w.cafeOwner, goods("Coffee", null, "MASS", "kg", 9_000), w.cafeMerchantId).path("merchantId").asString())
                .isEqualTo(w.cafeMerchantId.toString());
        assertThat(w.cafeOwner.get(base(w.cafeMerchantId) + "/items").json().path("items").size()).isEqualTo(1);
        assertThat(w.cafeOwner.get(base(w.cafeMerchantId) + "/items/" + rice.path("id").asString()).status()).isEqualTo(404);
        assertThat(w.cafeOwner.put(base(w.cafeMerchantId) + "/items/" + rice.path("id").asString(), change(rice, Map.of())).status())
                .isEqualTo(404);
        assertThat(w.cafeOwner.post(base(w.cafeMerchantId) + "/items/" + rice.path("id").asString() + "/packages",
                Map.of("label", "Bag", "contentsAmount", "25", "contentsUnit", "kg")).status()).isEqualTo(404);
        assertThat(w.owner.get(itemUrl(rice) + "/price-history").json().size()).isEqualTo(1);
    }

    private JsonNode created(TestApi api, Map<String, Object> body, UUID merchantId) {
        var response = api.post(base(merchantId) + "/items", body);
        assertThat(response.status()).as(response.body()).isEqualTo(201);
        return response.json();
    }

    @Test
    void aMerchantIdInTheBodyIsNeverUsed() {
        Map<String, Object> body = goods("Smuggled", null, "COUNT", "pc", 10);
        body.put("merchantId", w.cafeMerchantId.toString());
        var response = w.owner.post(base() + "/items", body);
        assertThat(response.status()).isIn(201, 400, 422);
        assertThat(jdbc.queryForObject("select count(*) from catalog_items where merchant_id = ?", Long.class, w.cafeMerchantId)).isZero();
        if (response.status() == 201) {
            assertThat(response.json().path("merchantId").asString()).isEqualTo(w.merchantId.toString());
        }
    }

    @Test
    void theCatalogExistsOnlyForBusinessModeMerchants() {
        JsonNode rice = rice();
        setMode(w.merchantId, "SIMPLIFIED");
        for (var response : List.of(w.owner.get(base() + "/items"), w.owner.get(itemUrl(rice)), w.owner.get(base() + "/measurement-units"),
                w.owner.post(base() + "/items", goods("Nope", null, "COUNT", "pc", 1)), update(w.owner, rice, Map.of("pricePerSaleUnitRwf", 1)),
                w.cashier.get(base() + "/items"))) {
            assertThat(response.status()).as(response.body()).isEqualTo(409);
            assertThat(response.code()).isEqualTo("catalog_unavailable");
        }
        setMode(w.merchantId, "BUSINESS");
        assertThat(w.owner.get(itemUrl(rice)).status()).isEqualTo(200);
        assertThat(w.owner.get(itemUrl(rice)).json().path("pricePerSaleUnitRwf").asLong()).isEqualTo(1_500);
    }

    // --- optimistic locking and concurrency -------------------------------------------------------------

    @Test
    void aStaleVersionIsAConflictAndChangesNothing() {
        JsonNode rice = rice();
        var first = update(w.owner, rice, Map.of("pricePerSaleUnitRwf", 1_600));
        assertThat(first.status()).isEqualTo(200);
        assertThat(first.json().path("version").asLong()).isGreaterThan(rice.path("version").asLong());

        var stale = update(w.manager, rice, Map.of("pricePerSaleUnitRwf", 1_700));
        assertThat(stale.status()).isEqualTo(409);
        assertThat(stale.code()).isEqualTo("version_conflict");
        assertThat(w.owner.get(itemUrl(rice)).json().path("pricePerSaleUnitRwf").asLong()).isEqualTo(1_600);
        assertThat(w.owner.get(itemUrl(rice) + "/price-history").json().size()).isEqualTo(2);

        var staleStatus = w.owner.put(itemUrl(rice) + "/status", Map.of("expectedVersion", rice.path("version").asLong(), "active", false));
        assertThat(staleStatus.code()).isEqualTo("version_conflict");
        assertThat(w.owner.get(itemUrl(rice)).json().path("active").asBoolean()).isTrue();
    }

    @Test
    void concurrentUpdatesFromTheSameVersionHaveExactlyOneWinner() throws Exception {
        JsonNode rice = rice();
        List<Callable<TestApi.Response>> tasks = new ArrayList<>();
        for (int i = 0; i < 6; i++) {
            TestApi api = i % 2 == 0 ? w.owner : w.manager;
            long price = 2_000 + i;
            tasks.add(() -> update(api, rice, Map.of("pricePerSaleUnitRwf", price)));
        }
        List<TestApi.Response> results = runTogether(tasks);
        assertThat(results.stream().filter(r -> r.status() == 200).count()).isEqualTo(1);
        assertThat(results.stream().filter(r -> r.status() == 409 && "version_conflict".equals(r.code())).count()).isEqualTo(5);
        var history = w.owner.get(itemUrl(rice) + "/price-history").json();
        assertThat(history.size()).isEqualTo(2);
        var stored = w.owner.get(itemUrl(rice)).json();
        assertThat(stored.path("priceVersion").asInt()).isEqualTo(2);
        assertThat(stored.path("pricePerSaleUnitRwf").asLong()).isEqualTo(history.get(0).path("pricePerSaleUnitRwf").asLong());
    }

    @Test
    void concurrentPackageCreationWithTheSameNameCreatesOne() throws Exception {
        JsonNode rice = rice();
        List<Callable<TestApi.Response>> tasks = new ArrayList<>();
        for (int i = 0; i < 4; i++) {
            TestApi api = i % 2 == 0 ? w.owner : w.manager;
            tasks.add(() -> api.post(itemUrl(rice) + "/packages", Map.of("label", "Bag", "contentsAmount", "25", "contentsUnit", "kg")));
        }
        List<TestApi.Response> results = runTogether(tasks);
        assertThat(results.stream().filter(r -> r.status() == 201).count()).isEqualTo(1);
        assertThat(results.stream().filter(r -> r.status() == 409).count()).isEqualTo(3);
        assertThat(w.owner.get(itemUrl(rice)).json().path("packages").size()).isEqualTo(1);
    }

    private <T> List<T> runTogether(List<Callable<T>> tasks) throws Exception {
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

    // --- price history ----------------------------------------------------------------------------------

    @Test
    void everyPriceOrUnitChangeAppendsAnImmutableVersion() {
        JsonNode rice = rice();
        var v2 = update(w.owner, rice, Map.of("pricePerSaleUnitRwf", 1_800, "priceChangeReason", "Harvest cost")).json();
        assertThat(v2.path("priceVersion").asInt()).isEqualTo(2);
        // Renaming alone does not create a price version.
        var renamed = update(w.owner, v2, Map.of("name", "Rice (local)")).json();
        assertThat(renamed.path("priceVersion").asInt()).isEqualTo(2);
        // Changing the unit does, even at the same number.
        var v3 = update(w.owner, renamed, Map.of("saleUnit", "g", "pricePerSaleUnitRwf", 1_800)).json();
        assertThat(v3.path("priceVersion").asInt()).isEqualTo(3);

        var history = w.owner.get(itemUrl(rice) + "/price-history").json();
        assertThat(history.size()).isEqualTo(3);
        assertThat(history.get(0).path("version").asInt()).isEqualTo(3);
        assertThat(history.get(0).path("saleUnit").asString()).isEqualTo("g");
        assertThat(history.get(1).path("version").asInt()).isEqualTo(2);
        assertThat(history.get(1).path("pricePerSaleUnitRwf").asLong()).isEqualTo(1_800);
        assertThat(history.get(1).path("saleUnit").asString()).isEqualTo("kg");
        assertThat(history.get(1).path("reason").asString()).isEqualTo("Harvest cost");
        assertThat(history.get(2).path("version").asInt()).isEqualTo(1);
        assertThat(history.get(2).path("pricePerSaleUnitRwf").asLong()).isEqualTo(1_500);
        assertThat(history.get(2).path("saleUnit").asString()).isEqualTo("kg");
        assertThat(isAbsent(history.get(2).path("reason"))).isTrue();
    }

    @Test
    void anUnchangedUpdateIsANoOp() {
        JsonNode rice = rice();
        var same = update(w.owner, rice, Map.of());
        assertThat(same.status()).isEqualTo(200);
        assertThat(same.json().path("version").asLong()).isEqualTo(rice.path("version").asLong());
        assertThat(same.json().path("priceVersion").asInt()).isEqualTo(1);
        assertThat(w.owner.get(itemUrl(rice) + "/price-history").json().size()).isEqualTo(1);
        assertThat(auditCount("CATALOG_ITEM_UPDATED")).isZero();
        assertThat(auditCount("CATALOG_PRICE_CHANGED")).isZero();
    }

    @Test
    void priceChangesNeverTouchExistingInvoicesOrPayments() {
        JsonNode rice = rice();
        UUID invoiceId = w.issuedInvoice(5_000);
        String invoiceUrl = "/api/v1/merchants/" + w.merchantId + "/invoices/" + invoiceId;
        String before = w.owner.get(invoiceUrl).body();
        long invoicesBefore = jdbc.queryForObject("select count(*) from invoices", Long.class);
        long itemsBefore = jdbc.queryForObject("select count(*) from invoice_items", Long.class);

        assertThat(update(w.owner, rice, Map.of("pricePerSaleUnitRwf", 9_999)).status()).isEqualTo(200);
        assertThat(w.owner.put(itemUrl(rice) + "/status", Map.of("expectedVersion", 1, "active", false)).status()).isEqualTo(200);

        assertThat(w.owner.get(invoiceUrl).body()).isEqualTo(before);
        assertThat(jdbc.queryForObject("select count(*) from invoices", Long.class)).isEqualTo(invoicesBefore);
        assertThat(jdbc.queryForObject("select count(*) from invoice_items", Long.class)).isEqualTo(itemsBefore);
        // No invoice, payment or ledger table references the catalog.
        assertThat(jdbc.queryForList("select tc.table_name from information_schema.table_constraints tc "
                + "join information_schema.constraint_column_usage ccu on ccu.constraint_name = tc.constraint_name "
                + "where tc.constraint_type = 'FOREIGN KEY' and ccu.table_name like 'catalog\\_%' and tc.table_name not like 'catalog\\_%'",
                String.class)).isEmpty();
    }

    // --- activation -------------------------------------------------------------------------------------

    @Test
    void itemsAreDeactivatedAndReactivatedNeverDeleted() {
        JsonNode rice = rice();
        var off = w.owner.put(itemUrl(rice) + "/status", Map.of("expectedVersion", rice.path("version").asLong(), "active", false));
        assertThat(off.status()).as(off.body()).isEqualTo(200);
        assertThat(off.json().path("active").asBoolean()).isFalse();
        assertThat(w.owner.get(itemUrl(rice)).json().path("active").asBoolean()).isFalse();
        assertThat(names(w.owner.get(base() + "/items"))).containsExactly("Rice");

        // Repeating the same state is a no-op that does not bump the version.
        var again = w.owner.put(itemUrl(rice) + "/status", Map.of("expectedVersion", off.json().path("version").asLong(), "active", false));
        assertThat(again.json().path("version").asLong()).isEqualTo(off.json().path("version").asLong());

        var on = w.manager.put(itemUrl(rice) + "/status", Map.of("expectedVersion", off.json().path("version").asLong(), "active", true));
        assertThat(on.json().path("active").asBoolean()).isTrue();
        assertThat(auditCount("CATALOG_ITEM_DEACTIVATED")).isEqualTo(1);
        assertThat(auditCount("CATALOG_ITEM_ACTIVATED")).isEqualTo(1);

        // There is no delete.
        assertThat(w.owner.delete(itemUrl(rice)).status()).isIn(404, 405);
        assertThat(w.owner.get(itemUrl(rice)).status()).isEqualTo(200);
    }

    @Test
    void anInactiveItemCanStillBeEditedAndKeepsItsHistory() {
        JsonNode rice = rice();
        var off = w.owner.put(itemUrl(rice) + "/status", Map.of("expectedVersion", rice.path("version").asLong(), "active", false)).json();
        var repriced = update(w.owner, off, Map.of("pricePerSaleUnitRwf", 1_700));
        assertThat(repriced.status()).isEqualTo(200);
        assertThat(repriced.json().path("active").asBoolean()).isFalse();
        assertThat(w.owner.get(itemUrl(rice) + "/price-history").json().size()).isEqualTo(2);
    }

    // --- packages ---------------------------------------------------------------------------------------

    private TestApi.Response addPackage(JsonNode item, String label, String amount, String unit) {
        return w.owner.post(itemUrl(item) + "/packages", Map.of("label", label, "contentsAmount", amount, "contentsUnit", unit));
    }

    @Test
    void definesExactProductSpecificPackages() {
        JsonNode rice = rice();
        var bag = addPackage(rice, "Bag", "25", "kg");
        assertThat(bag.status()).as(bag.body()).isEqualTo(201);
        assertThat(bag.json().path("quantityPerPackage").asString()).isEqualTo("25000");
        assertThat(bag.json().path("canonicalUnit").asString()).isEqualTo("g");
        assertThat(bag.json().path("quantityInSaleUnit").asString()).isEqualTo("25");

        JsonNode oil = created(w.owner, goods("Cooking oil", null, "VOLUME", "l", 2_500));
        var bottle = addPackage(oil, "Bottle", "750", "ml");
        assertThat(bottle.json().path("quantityPerPackage").asString()).isEqualTo("750");
        assertThat(bottle.json().path("quantityInSaleUnit").asString()).isEqualTo("0.75");

        JsonNode soda = created(w.owner, goods("Soda", null, "COUNT", "pc", 500));
        var carton = addPackage(soda, "Carton", "24", "pc");
        assertThat(carton.json().path("quantityPerPackage").asString()).isEqualTo("24");
        assertThat(carton.json().path("quantityInSaleUnit").asString()).isEqualTo("24");

        // "Carton" is not a global unit: another product has its own carton.
        JsonNode water = created(w.owner, goods("Water", null, "COUNT", "pc", 300));
        assertThat(addPackage(water, "Carton", "12", "pc").json().path("quantityPerPackage").asString()).isEqualTo("12");

        var listed = w.owner.get(itemUrl(rice)).json().path("packages");
        assertThat(listed.size()).isEqualTo(1);
        assertThat(listed.get(0).path("label").asString()).isEqualTo("Bag");
        assertThat(names(w.owner.get(base() + "/items"))).hasSize(4);
        JsonNode inList = w.owner.get(base() + "/items?q=cooking").json().path("items").get(0);
        assertThat(inList.path("packages").get(0).path("quantityInSaleUnit").asString()).isEqualTo("0.75");
    }

    @Test
    void packageQuantitiesFollowTheSaleUnitWhenItChanges() {
        JsonNode rice = rice();
        addPackage(rice, "Bag", "25", "kg");
        var inGrams = update(w.owner, rice, Map.of("saleUnit", "g", "pricePerSaleUnitRwf", 2)).json();
        assertThat(inGrams.path("packages").get(0).path("quantityPerPackage").asString()).isEqualTo("25000");
        assertThat(inGrams.path("packages").get(0).path("quantityInSaleUnit").asString()).isEqualTo("25000");
    }

    @Test
    void packagesAreExactAndNeverRounded() {
        JsonNode rice = rice();
        // 0.0000001 kg is 0.0001 g: exact in storage.
        var tiny = addPackage(rice, "Sample", "0.0000001", "kg");
        assertThat(tiny.status()).as(tiny.body()).isEqualTo(201);
        assertThat(tiny.json().path("quantityPerPackage").asString()).isEqualTo("0.0001");
        assertThat(tiny.json().path("quantityInSaleUnit").asString()).isEqualTo("0.0000001");
        // 0.0000000001 kg is 0.0000001 g: not representable at six decimals.
        assertThat(addPackage(rice, "Dust", "0.0000000001", "kg").code()).isEqualTo("precision_exceeded");
        assertThat(addPackage(rice, "Planet", "100000000000", "kg").code()).isEqualTo("quantity_out_of_range");
        assertThat(addPackage(rice, "Text", "twenty", "kg").code()).isEqualTo("invalid_quantity");
        assertThat(addPackage(rice, "Exponent", "1e3", "kg").code()).isEqualTo("invalid_quantity");
    }

    @Test
    void rejectsInvalidPackages() {
        JsonNode soda = created(w.owner, goods("Soda", null, "COUNT", "pc", 500));
        assertThat(addPackage(soda, "Half", "1.5", "pc").code()).isEqualTo("invalid_count");
        assertThat(addPackage(soda, "Zero", "0", "pc").code()).isEqualTo("invalid_package_conversion");
        assertThat(addPackage(soda, "Negative", "-24", "pc").code()).isEqualTo("invalid_package_conversion");
        assertThat(addPackage(soda, "Weighed", "2", "kg").code()).isEqualTo("dimension_mismatch");
        assertThat(addPackage(soda, "Strange", "2", "stone").code()).isEqualTo("unsupported_unit");
        assertThat(addPackage(soda, "Fine", "24", "pc").status()).isEqualTo(201);
        assertThat(addPackage(soda, "fine", "12", "pc").code()).isEqualTo("duplicate_label");
        assertThat(w.owner.post(itemUrl(soda) + "/packages", Map.of("label", " ", "contentsAmount", "1", "contentsUnit", "pc")).status())
                .isEqualTo(422);
        assertThat(w.owner.post(base() + "/items/" + UUID.randomUUID() + "/packages",
                Map.of("label", "Ghost", "contentsAmount", "1", "contentsUnit", "pc")).status()).isEqualTo(404);
    }

    @Test
    void servicesCannotHavePackages() {
        JsonNode haircut = created(w.owner, service("Haircut", null, 3_000));
        var response = addPackage(haircut, "Bundle", "5", "pc");
        assertThat(response.status()).isEqualTo(422);
        assertThat(response.code()).isEqualTo("invalid_unit_configuration");
    }

    @Test
    void limitsThePackagesPerItem() {
        JsonNode soda = created(w.owner, goods("Soda", null, "COUNT", "pc", 500));
        for (int i = 1; i <= CatalogService.MAX_PACKAGES_PER_ITEM; i++) {
            assertThat(addPackage(soda, "Pack " + i, String.valueOf(i), "pc").status()).isEqualTo(201);
        }
        assertThat(addPackage(soda, "One too many", "99", "pc").status()).isEqualTo(422);
    }

    @Test
    void updatesAndDeactivatesAPackageWithItsOwnVersion() {
        JsonNode rice = rice();
        JsonNode bag = addPackage(rice, "Bag", "25", "kg").json();
        String url = itemUrl(rice) + "/packages/" + bag.path("id").asString();

        var resized = w.owner.put(url, Map.of("expectedVersion", bag.path("version").asLong(), "label", "Big bag", "contentsAmount", "50",
                "contentsUnit", "kg", "active", true));
        assertThat(resized.status()).as(resized.body()).isEqualTo(200);
        assertThat(resized.json().path("quantityPerPackage").asString()).isEqualTo("50000");
        assertThat(resized.json().path("label").asString()).isEqualTo("Big bag");

        var stale = w.owner.put(url, Map.of("expectedVersion", bag.path("version").asLong(), "label", "Stale", "contentsAmount", "1",
                "contentsUnit", "kg", "active", true));
        assertThat(stale.code()).isEqualTo("version_conflict");

        var off = w.owner.put(url, Map.of("expectedVersion", resized.json().path("version").asLong(), "label", "Big bag",
                "contentsAmount", "50", "contentsUnit", "kg", "active", false));
        assertThat(off.json().path("active").asBoolean()).isFalse();
        assertThat(w.owner.get(itemUrl(rice)).json().path("packages").get(0).path("active").asBoolean()).isFalse();

        // An unchanged update does not bump the version.
        var same = w.owner.put(url, Map.of("expectedVersion", off.json().path("version").asLong(), "label", "Big bag",
                "contentsAmount", "50", "contentsUnit", "kg", "active", false));
        assertThat(same.json().path("version").asLong()).isEqualTo(off.json().path("version").asLong());

        assertThat(w.owner.put(itemUrl(rice) + "/packages/" + UUID.randomUUID(), Map.of("expectedVersion", 0, "label", "X",
                "contentsAmount", "1", "contentsUnit", "kg", "active", true)).status()).isEqualTo(404);
        // Another item's package id is not reachable through this item.
        JsonNode oil = created(w.owner, goods("Oil", null, "VOLUME", "l", 100));
        assertThat(w.owner.put(itemUrl(oil) + "/packages/" + bag.path("id").asString(), Map.of("expectedVersion", 0, "label", "X",
                "contentsAmount", "1", "contentsUnit", "l", "active", true)).status()).isEqualTo(404);
    }

    // --- units metadata and audit -----------------------------------------------------------------------

    @Test
    void servesTheSupportedUnitsFromTheServer() {
        var units = w.cashier.get(base() + "/measurement-units").json();
        assertThat(units.size()).isEqualTo(5);
        JsonNode mass = null;
        for (JsonNode option : units) {
            if ("MASS".equals(option.path("dimension").asString())) {
                mass = option;
            }
        }
        assertThat(mass).isNotNull();
        assertThat(mass.path("canonicalUnit").asString()).isEqualTo("g");
        assertThat(mass.path("wholeUnitsOnly").asBoolean()).isFalse();
        assertThat(mass.path("units").size()).isEqualTo(2);
        assertThat(mass.path("units").get(1).path("code").asString()).isEqualTo("kg");
        assertThat(units.get(0).path("dimension").asString()).isEqualTo("COUNT");
        assertThat(units.get(0).path("wholeUnitsOnly").asBoolean()).isTrue();
    }

    @Test
    void auditsCreationUpdatesPriceChangesActivationAndPackages() {
        JsonNode rice = rice();
        JsonNode renamed = update(w.owner, rice, Map.of("name", "Rice (local)")).json();
        JsonNode repriced = update(w.owner, renamed, Map.of("pricePerSaleUnitRwf", 1_700)).json();
        w.owner.put(itemUrl(rice) + "/status", Map.of("expectedVersion", repriced.path("version").asLong(), "active", false));
        addPackage(rice, "Bag", "25", "kg");

        assertThat(auditCount("CATALOG_ITEM_CREATED")).isEqualTo(1);
        assertThat(auditCount("CATALOG_ITEM_UPDATED")).isEqualTo(1);
        assertThat(auditCount("CATALOG_PRICE_CHANGED")).isEqualTo(1);
        assertThat(auditCount("CATALOG_ITEM_DEACTIVATED")).isEqualTo(1);
        assertThat(auditCount("CATALOG_PACKAGE_CREATED")).isEqualTo(1);
        String priceMessage = jdbc.queryForObject("select message from audit_log where kind = 'CATALOG_PRICE_CHANGED'", String.class);
        assertThat(priceMessage).contains("1500 RWF per kg").contains("1700 RWF per kg").contains("price version 2");
        assertThat(jdbc.queryForObject("select merchant_id from audit_log where kind = 'CATALOG_ITEM_CREATED'", UUID.class)).isEqualTo(w.merchantId);
        assertThat(jdbc.queryForObject("select actor_user_id from audit_log where kind = 'CATALOG_ITEM_CREATED'", UUID.class))
                .isEqualTo(w.ownerPerson.userId());
        // A rejected change leaves no audit entry.
        long entries = jdbc.queryForObject("select count(*) from audit_log", Long.class);
        update(w.cashier, rice, Map.of("pricePerSaleUnitRwf", 1));
        update(w.owner, rice, Map.of("pricePerSaleUnitRwf", 1));
        assertThat(jdbc.queryForObject("select count(*) from audit_log", Long.class)).isEqualTo(entries);
    }
}
