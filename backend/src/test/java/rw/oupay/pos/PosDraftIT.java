package rw.oupay.pos;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

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
import org.springframework.http.HttpMethod;
import rw.oupay.support.IntegrationTest;
import rw.oupay.support.TestApi;
import rw.oupay.support.World;
import tools.jackson.databind.JsonNode;

/**
 * R7a: the business POS foundation through the real API. A cart of goods and services is priced from the catalog's CURRENT price version
 * (never from the client), in exact quantities, and saved as a draft: a checkout INTENT. It is not a sale: no invoice, no payment request, no stock movement.
 */
class PosDraftIT extends IntegrationTest {

    World w;
    JsonNode rice;
    JsonNode soda;
    JsonNode repair;
    UUID crate;

    @BeforeEach
    void world() {
        w = World.create(this);
        rice = item(goods("Rice", "RICE-25", "MASS", "kg", 1_500));
        soda = item(goods("Soda", "SODA", "COUNT", "pc", 400));
        repair = item(service("Phone repair", "FIX", 5_000));
        crate = UUID.fromString(packageOf(soda, "Crate", "24", "pc").path("id").asString());
        stock(rice, "10", "kg");
        stock(soda, "100", "pc");
    }

    // ---- fixtures --------------------------------------------------------------------------------------------------

    private String catalog() {
        return "/api/v1/merchants/" + w.merchantId + "/catalog";
    }

    private String pos() {
        return "/api/v1/merchants/" + w.merchantId + "/pos";
    }

    private static Map<String, Object> goods(String name, String code, String dimension, String saleUnit, long price) {
        Map<String, Object> body = new HashMap<>();
        body.put("itemType", "GOODS");
        body.put("name", name);
        body.put("code", code);
        body.put("measurementDimension", dimension);
        body.put("saleUnit", saleUnit);
        body.put("pricePerSaleUnitRwf", price);
        return body;
    }

    private static Map<String, Object> service(String name, String code, long price) {
        Map<String, Object> body = new HashMap<>();
        body.put("itemType", "SERVICE");
        body.put("name", name);
        body.put("code", code);
        body.put("pricePerSaleUnitRwf", price);
        return body;
    }

    private JsonNode item(Map<String, Object> body) {
        var response = w.owner.post(catalog() + "/items", body);
        assertThat(response.status()).as(response.body()).isEqualTo(201);
        return response.json();
    }

    private JsonNode packageOf(JsonNode item, String label, String amount, String unit) {
        var response = w.owner.post(catalog() + "/items/" + item.path("id").asString() + "/packages", Map.of("label", label, "contentsAmount", amount, "contentsUnit", unit));
        assertThat(response.status()).as(response.body()).isEqualTo(201);
        return response.json();
    }

    private void stock(JsonNode item, String amount, String unit) {
        var response = w.owner.post("/api/v1/merchants/" + w.merchantId + "/inventory/opening", Map.of("clientOperationId", UUID.randomUUID().toString(),
                "branchId", w.branchId.toString(), "itemId", item.path("id").asString(), "amount", amount, "unit", unit));
        assertThat(response.status()).as(response.body()).isEqualTo(201);
    }

    private Map<String, Object> line(JsonNode item, String quantity, String unit) {
        Map<String, Object> line = new HashMap<>();
        line.put("itemId", item.path("id").asString());
        line.put("quantity", quantity);
        line.put("unit", unit);
        line.put("expectedPriceVersion", item.path("priceVersion").asInt());
        return line;
    }

    private Map<String, Object> packageLine(JsonNode item, String count, UUID packageId) {
        Map<String, Object> line = new HashMap<>();
        line.put("itemId", item.path("id").asString());
        line.put("quantity", count);
        line.put("packageId", packageId.toString());
        line.put("expectedPriceVersion", item.path("priceVersion").asInt());
        return line;
    }

    @SafeVarargs
    private Map<String, Object> cart(UUID branch, Map<String, Object>... lines) {
        Map<String, Object> body = new HashMap<>();
        body.put("branchId", branch.toString());
        List<Map<String, Object>> list = new ArrayList<>();
        for (Map<String, Object> l : lines) {
            list.add(l);
        }
        body.put("lines", list);
        return body;
    }

    @SafeVarargs
    private Map<String, Object> draftBody(UUID clientRequestId, String note, Map<String, Object>... lines) {
        Map<String, Object> body = cart(w.branchId, lines);
        body.put("clientRequestId", clientRequestId.toString());
        if (note != null) {
            body.put("note", note);
        }
        return body;
    }

    private TestApi.Response quote(TestApi api, Map<String, Object> body) {
        return api.post(pos() + "/quote", body);
    }

    private TestApi.Response save(TestApi api, String key, Map<String, Object> body) {
        return api.send(HttpMethod.POST, pos() + "/drafts", body, Map.of("Idempotency-Key", key));
    }

    private JsonNode saved(TestApi api, Map<String, Object> body) {
        var response = save(api, "key-" + UUID.randomUUID(), body);
        assertThat(response.status()).as(response.body()).isEqualTo(201);
        return response.json();
    }

    private JsonNode problem(JsonNode quote, int index) {
        return quote.path("problems").get(index);
    }

    private long count(String table) {
        return jdbc.queryForObject("select count(*) from " + table, Long.class);
    }

    private void setMode(UUID merchantId, String mode) {
        jdbc.update("insert into merchant_settings (merchant_id, operating_mode, updated_at, version) values (?, ?, now(), 0) "
                + "on conflict (merchant_id) do update set operating_mode = excluded.operating_mode", merchantId, mode);
    }

    // ---- a mixed cart, priced from the catalog -----------------------------------------------------------------------

    @Test
    void aMixedCartOfGoodsAndServicesIsPricedFromTheCatalogWithTheServersArithmetic() {
        var response = quote(w.cashier, cart(w.branchId, line(rice, "2.5", "kg"), line(soda, "3", "pc"), line(repair, "1", "pc")));
        assertThat(response.status()).as(response.body()).isEqualTo(200);
        JsonNode quote = response.json();
        assertThat(quote.path("problems").size()).isZero();
        assertThat(quote.path("lines").size()).isEqualTo(3);
        assertThat(quote.path("totalRwf").asLong()).isEqualTo(3_750 + 1_200 + 5_000);
        JsonNode first = quote.path("lines").get(0);
        assertThat(first.path("name").asString()).isEqualTo("Rice");
        assertThat(first.path("unitPriceRwf").asLong()).isEqualTo(1_500);
        assertThat(first.path("priceVersion").asInt()).isEqualTo(1);
        assertThat(first.path("saleUnit").asString()).isEqualTo("kg");
        assertThat(first.path("quantityInSaleUnit").asString()).isEqualTo("2.5");
        assertThat(first.path("canonicalQuantity").asString()).isEqualTo("2500");
        assertThat(first.path("lineTotalRwf").asLong()).isEqualTo(3_750);
        assertThat(quote.path("stockNote").asString()).contains("checked again when you bill");
        // A service has no stock; goods do.
        assertThat(quote.path("lines").get(2).path("stock").path("state").asString()).isEqualTo("NOT_TRACKED");
        assertThat(first.path("stock").path("state").asString()).isEqualTo("SUFFICIENT");
    }

    @Test
    void thePriceIsTheCatalogsNeverTheClients() {
        Map<String, Object> tampered = line(rice, "1", "kg");
        tampered.put("unitPriceRwf", 1);
        tampered.put("lineTotalRwf", 1);
        tampered.put("pricePerSaleUnitRwf", 1);
        var response = save(w.cashier, "key-price-0001", draftBody(UUID.randomUUID(), null, tampered));
        assertThat(response.status()).as(response.body()).isEqualTo(201);
        assertThat(response.json().path("lines").get(0).path("unitPriceRwf").asLong()).isEqualTo(1_500);
        assertThat(response.json().path("totalRwf").asLong()).isEqualTo(1_500);
    }

    // ---- exact quantities ---------------------------------------------------------------------------------------------

    @Test
    void quantitiesAreConvertedExactlyToTheSellingUnitAndNeverRounded() {
        // Rice is priced per kg. 250 g is exactly 0.25 kg; 1 g is exactly 0.001 kg (the invoice model's finest quantity).
        JsonNode quote = quote(w.cashier, cart(w.branchId, line(rice, "250", "g"), line(rice, "1500", "g"), line(rice, "1", "g"))).json();
        assertThat(quote.path("problems").size()).isZero();
        assertThat(quote.path("lines").get(0).path("quantityInSaleUnit").asString()).isEqualTo("0.25");
        assertThat(quote.path("lines").get(0).path("canonicalQuantity").asString()).isEqualTo("250");
        assertThat(quote.path("lines").get(0).path("lineTotalRwf").asLong()).isEqualTo(375);
        assertThat(quote.path("lines").get(1).path("quantityInSaleUnit").asString()).isEqualTo("1.5");
        assertThat(quote.path("lines").get(1).path("lineTotalRwf").asLong()).isEqualTo(2_250);
        // Money uses the invoice rule: half up, once per line (1.5 RWF -> 2).
        assertThat(quote.path("lines").get(2).path("quantityInSaleUnit").asString()).isEqualTo("0.001");
        assertThat(quote.path("lines").get(2).path("lineTotalRwf").asLong()).isEqualTo(2);
        // Half a gram is 0.0005 kg: finer than the invoice model holds. It is REFUSED, never rounded.
        JsonNode finer = quote(w.cashier, cart(w.branchId, line(rice, "0.5", "g"))).json();
        assertThat(finer.path("lines").size()).isZero();
        assertThat(problem(finer, 0).path("code").asString()).isEqualTo("quantity_not_representable");
        assertThat(problem(finer, 0).path("message").asString()).contains("thousandths");
        // A fourth decimal of the selling unit itself is refused the same way.
        assertThat(problem(quote(w.cashier, cart(w.branchId, line(rice, "1.0005", "kg"))).json(), 0).path("code").asString()).isEqualTo("quantity_not_representable");
    }

    @Test
    void countedGoodsAreWholeAndMeasuredGoodsMayBeFractionalAndUnitsMustMatchTheDimension() {
        JsonNode counted = quote(w.cashier, cart(w.branchId, line(soda, "2.5", "pc"))).json();
        assertThat(problem(counted, 0).path("code").asString()).isEqualTo("invalid_count");
        assertThat(quote(w.cashier, cart(w.branchId, line(rice, "2.5", "kg"))).json().path("problems").size()).isZero();
        // A mass unit for a piece-counted good, and the reverse.
        assertThat(problem(quote(w.cashier, cart(w.branchId, line(soda, "1", "kg"))).json(), 0).path("code").asString()).isEqualTo("dimension_mismatch");
        assertThat(problem(quote(w.cashier, cart(w.branchId, line(rice, "1", "pc"))).json(), 0).path("code").asString()).isEqualTo("dimension_mismatch");
        assertThat(problem(quote(w.cashier, cart(w.branchId, line(rice, "1", "stone"))).json(), 0).path("code").asString()).isEqualTo("unsupported_unit");
        for (String bad : new String[] {"abc", "-1", "1e3", "1,5", "1.", ".5", "NaN", "+2"}) {
            JsonNode result = quote(w.cashier, cart(w.branchId, line(rice, bad, "kg"))).json();
            assertThat(problem(result, 0).path("code").asString()).as("quantity '" + bad + "'").isEqualTo("invalid_quantity");
        }
        // A blank quantity never reaches pricing: the request itself is invalid.
        assertThat(quote(w.cashier, cart(w.branchId, line(rice, "", "kg"))).status()).isEqualTo(422);
        assertThat(problem(quote(w.cashier, cart(w.branchId, line(rice, "0", "kg"))).json(), 0).path("code").asString()).isEqualTo("quantity_out_of_range");
        assertThat(problem(quote(w.cashier, cart(w.branchId, line(rice, "-1", "kg"))).json(), 0).path("code").asString()).isEqualTo("invalid_quantity");
        assertThat(problem(quote(w.cashier, cart(w.branchId, line(rice, "abc", "kg"))).json(), 0).path("code").asString()).isEqualTo("invalid_quantity");
        // Neither a unit nor a package, and both.
        Map<String, Object> neither = line(rice, "1", null);
        assertThat(problem(quote(w.cashier, cart(w.branchId, neither)).json(), 0).path("code").asString()).isEqualTo("unit_or_package_required");
        Map<String, Object> both = packageLine(soda, "1", crate);
        both.put("unit", "pc");
        assertThat(problem(quote(w.cashier, cart(w.branchId, both)).json(), 0).path("code").asString()).isEqualTo("unit_or_package_required");
    }

    @Test
    void packagesAreWholeNumbersOfTheItemsOwnPackagesConvertedExactly() {
        JsonNode quote = quote(w.cashier, cart(w.branchId, packageLine(soda, "2", crate))).json();
        assertThat(quote.path("problems").size()).isZero();
        JsonNode lineOne = quote.path("lines").get(0);
        // Two crates of 24 pieces: 48 pieces at RWF 400.
        assertThat(lineOne.path("quantityInSaleUnit").asString()).isEqualTo("48");
        assertThat(lineOne.path("canonicalQuantity").asString()).isEqualTo("48");
        assertThat(lineOne.path("lineTotalRwf").asLong()).isEqualTo(19_200);
        assertThat(lineOne.path("packageLabel").asString()).isEqualTo("Crate");
        assertThat(lineOne.path("enteredQuantity").asString()).isEqualTo("2");
        assertThat(problem(quote(w.cashier, cart(w.branchId, packageLine(soda, "1.5", crate))).json(), 0).path("code").asString()).isEqualTo("invalid_package_count");
        // Another item's package, and an unknown one.
        assertThat(problem(quote(w.cashier, cart(w.branchId, packageLine(rice, "1", crate))).json(), 0).path("code").asString()).isEqualTo("package_not_found");
        assertThat(problem(quote(w.cashier, cart(w.branchId, packageLine(soda, "1", UUID.randomUUID()))).json(), 0).path("code").asString()).isEqualTo("package_not_found");
    }

    // ---- price versions ---------------------------------------------------------------------------------------------------

    @Test
    void aSavedDraftKeepsTheSnapshotOfThePriceVersionItWasPricedAt() {
        JsonNode draft = saved(w.cashier, draftBody(UUID.randomUUID(), "Counter sale", line(rice, "2", "kg")));
        UUID draftId = UUID.fromString(draft.path("id").asString());
        assertThat(draft.path("lines").get(0).path("priceVersion").asInt()).isEqualTo(1);
        // The merchant reprices the rice: a new immutable version, price 1,800.
        var repriced = w.owner.put(catalog() + "/items/" + rice.path("id").asString(), Map.of("expectedVersion", rice.path("version").asLong(), "name", "Rice",
                "code", "RICE-25", "saleUnit", "kg", "pricePerSaleUnitRwf", 1_800, "priceChangeReason", "Market price"));
        assertThat(repriced.status()).as(repriced.body()).isEqualTo(200);
        // The draft still shows what it was priced at; the snapshot is in the table and is a real price version of that item.
        JsonNode reloaded = w.cashier.get(pos() + "/drafts/" + draftId).json();
        assertThat(reloaded.path("lines").get(0).path("unitPriceRwf").asLong()).isEqualTo(1_500);
        assertThat(reloaded.path("lines").get(0).path("priceVersion").asInt()).isEqualTo(1);
        assertThat(reloaded.path("totalRwf").asLong()).isEqualTo(3_000);
        // A cart still carrying the old version is refused with the NEW price, never silently re-priced.
        JsonNode stale = quote(w.cashier, cart(w.branchId, line(rice, "2", "kg"))).json();
        assertThat(problem(stale, 0).path("code").asString()).isEqualTo("price_changed");
        assertThat(problem(stale, 0).path("currentPriceVersion").asInt()).isEqualTo(2);
        assertThat(problem(stale, 0).path("currentPriceRwf").asLong()).isEqualTo(1_800);
        // Saving the draft again, on the version the cashier has now seen, re-prices it at the new version.
        Map<String, Object> fresh = line(rice, "2", "kg");
        fresh.put("expectedPriceVersion", 2);
        var updated = w.cashier.put(pos() + "/drafts/" + draftId, Map.of("expectedVersion", draft.path("version").asLong(), "lines", List.of(fresh)));
        assertThat(updated.status()).as(updated.body()).isEqualTo(200);
        assertThat(updated.json().path("lines").get(0).path("priceVersion").asInt()).isEqualTo(2);
        assertThat(updated.json().path("totalRwf").asLong()).isEqualTo(3_600);
        // The database itself refuses a line whose price is not a real price version of the item.
        assertThatThrownBy(() -> jdbc.update("update pos_draft_lines set unit_price_rwf = 1 where draft_id = ?", draftId)).isNotNull();
        assertThatThrownBy(() -> jdbc.update("insert into pos_draft_lines (id, draft_id, merchant_id, line_no, item_id, item_type, item_name, measurement_dimension, "
                + "entered_quantity, entered_unit, sale_unit, quantity_milli, canonical_quantity, price_version, unit_price_rwf, line_total_rwf) "
                + "values (?, ?, ?, 9, ?::uuid, 'GOODS', 'Rice', 'MASS', '1', 'kg', 'kg', 1000, 1000, 2, 1, 1)", UUID.randomUUID(), draftId, w.merchantId,
                rice.path("id").asString())).isNotNull();
    }

    @Test
    void invalidAndStalePriceVersionsAreRefusedAndMissingOnesToo() {
        Map<String, Object> wrong = line(rice, "1", "kg");
        wrong.put("expectedPriceVersion", 99);
        assertThat(problem(quote(w.cashier, cart(w.branchId, wrong)).json(), 0).path("code").asString()).isEqualTo("price_changed");
        Map<String, Object> missing = line(rice, "1", "kg");
        missing.remove("expectedPriceVersion");
        assertThat(quote(w.cashier, cart(w.branchId, missing)).status()).isEqualTo(422);
        // Saving refuses the whole cart with the first problem; nothing is stored.
        var refused = save(w.cashier, "key-stale-0001", draftBody(UUID.randomUUID(), null, wrong));
        assertThat(refused.status()).isEqualTo(422);
        assertThat(refused.code()).isEqualTo("invalid_cart");
        assertThat(count("pos_drafts")).isZero();
    }

    // ---- inactive, foreign and stocked items ------------------------------------------------------------------------------

    @Test
    void inactiveItemsCanNotBeSoldAndForeignItemsDoNotExist() {
        var off = w.owner.put(catalog() + "/items/" + soda.path("id").asString() + "/status", Map.of("expectedVersion", soda.path("version").asLong(), "active", false));
        assertThat(off.status()).as(off.body()).isEqualTo(200);
        assertThat(problem(quote(w.cashier, cart(w.branchId, line(soda, "1", "pc"))).json(), 0).path("code").asString()).isEqualTo("item_inactive");
        var listed = w.cashier.get(pos() + "/items?branchId=" + w.branchId).json();
        List<String> names = new ArrayList<>();
        listed.forEach(i -> names.add(i.path("name").asString()));
        assertThat(names).contains("Rice", "Phone repair").doesNotContain("Soda");
        // The cafe's own catalog is separate: the shop's item is not in it.
        UUID cafeBranch = w.cafeBranchId;
        var foreign = w.cafeOwner.post("/api/v1/merchants/" + w.cafeMerchantId + "/pos/quote", cart(cafeBranch, line(rice, "1", "kg")));
        // The cafe owner works at their own branch only if assigned; either way the shop's item is never visible to them.
        assertThat(foreign.status()).isIn(200, 409, 403, 404);
        if (foreign.status() == 200) {
            assertThat(problem(foreign.json(), 0).path("code").asString()).isEqualTo("item_not_found");
        }
    }

    @Test
    void stockIsInformationalInsufficientStockIsAWarningAndNothingIsReserved() {
        // 20 kg against 10 on hand: a warning, not an error, and the cart still prices and saves.
        JsonNode warned = quote(w.cashier, cart(w.branchId, line(rice, "20", "kg"))).json();
        assertThat(warned.path("problems").size()).isZero();
        JsonNode stock = warned.path("lines").get(0).path("stock");
        assertThat(stock.path("state").asString()).isEqualTo("INSUFFICIENT");
        assertThat(stock.path("onHand").asString()).isEqualTo("10000");
        assertThat(stock.path("requested").asString()).isEqualTo("20000");
        assertThat(stock.path("canonicalUnit").asString()).isEqualTo("g");
        // Two lines of one good draw on the same stock: neither is enough on its own terms.
        JsonNode twice = quote(w.cashier, cart(w.branchId, line(rice, "6", "kg"), line(rice, "6000", "g"))).json();
        assertThat(twice.path("lines").get(0).path("stock").path("state").asString()).isEqualTo("INSUFFICIENT");
        assertThat(twice.path("lines").get(1).path("stock").path("requested").asString()).isEqualTo("12000");
        // Goods that never had stock recorded at this branch.
        JsonNode beans = item(goods("Beans", "BEANS", "MASS", "kg", 900));
        JsonNode none = quote(w.cashier, cart(w.branchId, line(beans, "1", "kg"))).json();
        assertThat(none.path("lines").get(0).path("stock").path("state").asString()).isEqualTo("NO_STOCK_RECORD");
        // The catalog view for the branch shows the same informational figures, in the selling unit too.
        JsonNode view = w.cashier.get(pos() + "/items?branchId=" + w.branchId + "&q=rice").json().get(0);
        assertThat(view.path("stock").path("state").asString()).isEqualTo("RECORDED");
        assertThat(view.path("stock").path("onHandInSaleUnit").asString()).isEqualTo("10");
        assertThat(view.path("units").toString()).contains("kg").contains("g").doesNotContain("pc");
        // Saving it changes no stock at all.
        long movements = count("stock_movements");
        var balanceBefore = jdbc.queryForObject("select quantity_on_hand from inventory_balances where item_id = ?::uuid", java.math.BigDecimal.class, rice.path("id").asString());
        saved(w.cashier, draftBody(UUID.randomUUID(), null, line(rice, "20", "kg")));
        assertThat(count("stock_movements")).isEqualTo(movements);
        assertThat(jdbc.queryForObject("select quantity_on_hand from inventory_balances where item_id = ?::uuid", java.math.BigDecimal.class, rice.path("id").asString()))
                .isEqualByComparingTo(balanceBefore);
    }

    // ---- a draft is not a sale -------------------------------------------------------------------------------------------

    @Test
    void aDraftIsNotASaleItCreatesNoInvoiceNoPaymentRequestNoStockMovementAndConsumesNoNumber() {
        long invoices = count("invoices");
        long requests = count("payment_requests");
        long movements = count("stock_movements");
        long transactions = count("bank_transactions");
        long sequences = count("invoice_number_sequences");
        JsonNode draft = saved(w.cashier, draftBody(UUID.randomUUID(), "Counter sale", line(rice, "2", "kg"), line(repair, "1", "pc")));
        assertThat(draft.path("status").asString()).isEqualTo("DRAFT");
        assertThat(draft.path("notice").asString()).contains("not a sale").contains("no stock is reserved or deducted");
        assertThat(count("invoices")).isEqualTo(invoices);
        assertThat(count("payment_requests")).isEqualTo(requests);
        assertThat(count("stock_movements")).isEqualTo(movements);
        assertThat(count("bank_transactions")).isEqualTo(transactions);
        assertThat(count("invoice_number_sequences")).isEqualTo(sequences);
        // It is audited, with who and what.
        var audit = jdbc.queryForMap("select actor_user_id, message from audit_log where kind = 'POS_DRAFT_CREATED'");
        assertThat(audit.get("actor_user_id")).isEqualTo(w.cashierPerson.userId());
        assertThat(audit.get("message").toString()).contains("Not a sale");
        // Ordinary invoicing is untouched: the first real invoice still takes the first number.
        UUID invoice = w.issuedInvoice(10_000);
        assertThat(jdbc.queryForObject("select invoice_number from invoices where id = ?", String.class, invoice)).isEqualTo("INV-0001");
    }

    // ---- authorization ---------------------------------------------------------------------------------------------------------

    @Test
    void onlyBusinessesInBusinessModeAndPeopleAssignedToTheBranchCanBuildACart() {
        // The owner works at no branch: nothing to bill at.
        var owner = w.owner.get(pos() + "/options");
        assertThat(owner.json().path("readiness").asString()).isEqualTo("NO_BRANCH");
        assertThat(quote(w.owner, cart(w.branchId, line(rice, "1", "kg"))).code()).isEqualTo("no_eligible_branch");
        // The cashier is assigned to RM01 only.
        JsonNode options = w.cashier.get(pos() + "/options").json();
        assertThat(options.path("readiness").asString()).isEqualTo("READY");
        assertThat(options.path("branches").size()).isEqualTo(1);
        assertThat(options.path("maxLines").asInt()).isEqualTo(50);
        UUID otherBranch = fixtures.branch(w.merchantId, "RM02", "ACTIVE");
        var elsewhere = quote(w.cashier, cart(otherBranch, line(rice, "1", "kg")));
        assertThat(elsewhere.status()).isEqualTo(422);
        assertThat(elsewhere.code()).isEqualTo("branch_not_eligible");
        var inactive = quote(w.cashier, cart(w.inactiveBranchId, line(rice, "1", "kg")));
        assertThat(inactive.code()).isEqualTo("branch_not_eligible");
        assertThat(save(w.cashier, "key-branch-0001", draftBody(UUID.randomUUID(), null, line(rice, "1", "kg"))).status()).isEqualTo(201);
        // A manager assigned to RM01 follows the same rule.
        assertThat(quote(w.manager, cart(w.branchId, line(rice, "1", "kg"))).status()).isEqualTo(200);
        assertThat(quote(w.manager, cart(otherBranch, line(rice, "1", "kg"))).code()).isEqualTo("branch_not_eligible");
        // A SIMPLIFIED business keeps amount-only checkout.
        setMode(w.merchantId, "SIMPLIFIED");
        assertThat(w.cashier.get(pos() + "/options").json().path("readiness").asString()).isEqualTo("NOT_BUSINESS");
        var simplified = quote(w.cashier, cart(w.branchId, line(rice, "1", "kg")));
        assertThat(simplified.status()).isEqualTo(409);
        assertThat(simplified.code()).isEqualTo("pos_unavailable");
        assertThat(save(w.cashier, "key-mode-00001", draftBody(UUID.randomUUID(), null, line(rice, "1", "kg"))).code()).isEqualTo("pos_unavailable");
    }

    @Test
    void draftsAreVisibleToTheirCreatorTheBranchManagerAndTheOwnerButNotToOthersOrOtherBusinesses() {
        JsonNode mine = saved(w.cashier, draftBody(UUID.randomUUID(), null, line(rice, "1", "kg")));
        UUID id = UUID.fromString(mine.path("id").asString());
        JsonNode theirs = saved(w.otherCashier, draftBody(UUID.randomUUID(), null, line(soda, "2", "pc")));
        assertThat(ids(w.cashier.get(pos() + "/drafts").json())).containsExactly(mine.path("id").asString());
        assertThat(ids(w.otherCashier.get(pos() + "/drafts").json())).containsExactly(theirs.path("id").asString());
        assertThat(ids(w.manager.get(pos() + "/drafts").json())).containsExactlyInAnyOrder(mine.path("id").asString(), theirs.path("id").asString());
        assertThat(w.manager.get(pos() + "/drafts/" + id).status()).isEqualTo(200);
        // The owner oversees every draft of the business, though not assigned to a branch to bill at.
        assertThat(ids(w.owner.get(pos() + "/drafts").json())).containsExactlyInAnyOrder(mine.path("id").asString(), theirs.path("id").asString());
        // A cashier does not see another cashier's draft, nor can they change it; another business sees nothing.
        assertThat(w.otherCashier.get(pos() + "/drafts/" + id).status()).isEqualTo(404);
        assertThat(w.otherCashier.put(pos() + "/drafts/" + id, Map.of("expectedVersion", 0, "lines", List.of(line(rice, "1", "kg")))).status()).isEqualTo(404);
        assertThat(w.cafeOwner.get("/api/v1/merchants/" + w.cafeMerchantId + "/pos/drafts/" + id).status()).isIn(404, 409);
        assertThat(w.cafeOwner.get(pos() + "/drafts/" + id).status()).isIn(403, 404);
        assertThat(w.cafeOwner.get(pos() + "/items?branchId=" + w.cafeBranchId).status()).isIn(403, 404);
        // A manager at another branch sees none of it.
        UUID otherBranch = fixtures.branch(w.merchantId, "RM02", "ACTIVE");
        jdbc.update("update branch_assignments set status = 'ENDED', ended_at = now() where membership_id = ?", w.managerMembershipId);
        fixtures.assign(w.merchantId, w.managerMembershipId, otherBranch);
        assertThat(ids(w.manager.get(pos() + "/drafts").json())).isEmpty();
        assertThat(w.manager.get(pos() + "/drafts/" + id).status()).isEqualTo(404);
    }

    private static List<String> ids(JsonNode page) {
        List<String> ids = new ArrayList<>();
        page.path("items").forEach(i -> ids.add(i.path("id").asString()));
        return ids;
    }

    // ---- idempotency and concurrency -----------------------------------------------------------------------------------------

    @Test
    void aRepeatReturnsTheOriginalDraftAndADifferentCartUnderTheSameIdentityIsAConflict() {
        UUID clientRequestId = UUID.randomUUID();
        var body = draftBody(clientRequestId, "Counter", line(rice, "2", "kg"));
        var first = save(w.cashier, "key-idem-0001", body);
        var again = save(w.cashier, "key-idem-0001", body);
        assertThat(first.status()).isEqualTo(201);
        assertThat(again.status()).isEqualTo(200);
        assertThat(again.json().path("id").asString()).isEqualTo(first.json().path("id").asString());
        // Same identity under a new key and the same cart: still the original.
        var newKey = save(w.cashier, "key-idem-0002", body);
        assertThat(newKey.status()).isEqualTo(200);
        assertThat(newKey.json().path("id").asString()).isEqualTo(first.json().path("id").asString());
        // A different cart under the same identity, or the same key for a different cart.
        var different = save(w.cashier, "key-idem-0003", draftBody(clientRequestId, "Counter", line(rice, "3", "kg")));
        assertThat(different.status()).isEqualTo(409);
        assertThat(different.code()).isEqualTo("client_request_id_reuse");
        assertThat(save(w.cashier, "key-idem-0001", draftBody(UUID.randomUUID(), null, line(rice, "5", "kg"))).code()).isEqualTo("idempotency_key_reuse");
        // Another person can not take over the identity.
        assertThat(save(w.otherCashier, "key-idem-0009", body).status()).isEqualTo(409);
        assertThat(count("pos_drafts")).isEqualTo(1);
        // The key is mandatory.
        assertThat(w.cashier.send(HttpMethod.POST, pos() + "/drafts", draftBody(UUID.randomUUID(), null, line(rice, "1", "kg")), Map.of()).status()).isGreaterThanOrEqualTo(400);
    }

    @Test
    void manyConcurrentCreationsOfOneCartMakeOneDraft() throws Exception {
        UUID clientRequestId = UUID.randomUUID();
        var body = draftBody(clientRequestId, null, line(rice, "2", "kg"), line(repair, "1", "pc"));
        List<Callable<TestApi.Response>> sameKey = new ArrayList<>();
        List<Callable<TestApi.Response>> otherKeys = new ArrayList<>();
        for (int i = 0; i < 8; i++) {
            int n = i;
            sameKey.add(() -> save(w.cashier, "key-conc-same1", body));
            otherKeys.add(() -> save(w.cashier, "key-conc-diff" + n, body));
        }
        List<TestApi.Response> results = concurrently(sameKey);
        assertThat(results).allSatisfy(r -> assertThat(r.status()).as(r.body()).isIn(200, 201, 409));
        assertThat(results.stream().filter(r -> r.status() == 201).count()).isEqualTo(1);
        assertThat(count("pos_drafts")).isEqualTo(1);
        List<TestApi.Response> more = concurrently(otherKeys);
        assertThat(more).allSatisfy(r -> assertThat(r.status()).as(r.body()).isIn(200, 201, 409));
        assertThat(count("pos_drafts")).isEqualTo(1);
        assertThat(count("pos_draft_lines")).isEqualTo(2);
    }

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
                results.add(future.get(60, TimeUnit.SECONDS));
            }
            return results;
        } finally {
            pool.shutdownNow();
        }
    }

    // ---- editing, discarding and what the database keeps -------------------------------------------------------------------------

    @Test
    void aDraftIsReplacedAsAWholeDiscardedFinallyAndItsRecordIsProtectedByTheDatabase() {
        JsonNode draft = saved(w.cashier, draftBody(UUID.randomUUID(), "First", line(rice, "2", "kg")));
        UUID id = UUID.fromString(draft.path("id").asString());
        long version = draft.path("version").asLong();
        var updated = w.cashier.put(pos() + "/drafts/" + id, Map.of("expectedVersion", version, "note", "Second", "lines", List.of(line(soda, "5", "pc"), line(repair, "1", "pc"))));
        assertThat(updated.status()).as(updated.body()).isEqualTo(200);
        assertThat(updated.json().path("lines").size()).isEqualTo(2);
        assertThat(updated.json().path("totalRwf").asLong()).isEqualTo(2_000 + 5_000);
        assertThat(updated.json().path("version").asLong()).isEqualTo(version + 1);
        assertThat(count("pos_draft_lines")).isEqualTo(2);
        // A stale version is a conflict.
        var stale = w.cashier.put(pos() + "/drafts/" + id, Map.of("expectedVersion", version, "lines", List.of(line(rice, "1", "kg"))));
        assertThat(stale.status()).isEqualTo(409);
        assertThat(stale.code()).isEqualTo("version_conflict");
        // The stored total and line count can never drift from the lines (checked at commit).
        assertThatThrownBy(() -> jdbc.update("update pos_drafts set total_rwf = 1 where id = ?", id)).isNotNull();
        assertThatThrownBy(() -> jdbc.update("delete from pos_draft_lines where draft_id = ? and line_no = 1", id)).isNotNull();
        assertThatThrownBy(() -> jdbc.update("update pos_draft_lines set quantity_milli = 1 where draft_id = ?", id)).hasMessageContaining("never edited");
        assertThatThrownBy(() -> jdbc.update("delete from pos_drafts where id = ?", id)).hasMessageContaining("never deleted");
        // Discarding is final, on record, and changes nothing else.
        long movements = count("stock_movements");
        var discarded = w.cashier.delete(pos() + "/drafts/" + id + "?expectedVersion=" + (version + 1));
        assertThat(discarded.status()).as(discarded.body()).isEqualTo(200);
        assertThat(discarded.json().path("status").asString()).isEqualTo("DISCARDED");
        assertThat(w.cashier.put(pos() + "/drafts/" + id, Map.of("expectedVersion", version + 2, "lines", List.of(line(rice, "1", "kg")))).code()).isEqualTo("draft_not_open");
        assertThatThrownBy(() -> jdbc.update("update pos_drafts set status = 'DRAFT' where id = ?", id)).hasMessageContaining("final");
        assertThatThrownBy(() -> jdbc.update("delete from pos_draft_lines where draft_id = ?", id)).hasMessageContaining("discarded");
        assertThat(count("stock_movements")).isEqualTo(movements);
        assertThat(jdbc.queryForObject("select count(*) from audit_log where kind = 'POS_DRAFT_DISCARDED'", Integer.class)).isEqualTo(1);
    }

    @Test
    void aDraftNeedsAtLeastOneLineAndAtMostTheLimit() {
        assertThat(save(w.cashier, "key-empty-0001", draftBody(UUID.randomUUID(), null)).status()).isEqualTo(422);
        List<Map<String, Object>> many = new ArrayList<>();
        for (int i = 0; i < 101; i++) {
            many.add(line(soda, "1", "pc"));
        }
        Map<String, Object> body = cart(w.branchId, many.get(0));
        body.put("lines", many);
        body.put("clientRequestId", UUID.randomUUID().toString());
        assertThat(save(w.cashier, "key-many-0001", body).status()).isEqualTo(422);
        assertThat(count("pos_drafts")).isZero();
    }

    // ---- R7a review: lifecycle, concurrency, units, rounding, tax and isolation ---------------------------------------------------

    private JsonNode draftOf(TestApi api, UUID id) {
        return api.get(pos() + "/drafts/" + id).json();
    }

    private static long lineSum(JsonNode draft) {
        long sum = 0;
        for (JsonNode l : draft.path("lines")) {
            sum += l.path("lineTotalRwf").asLong();
        }
        return sum;
    }

    @Test
    void aFailedUpdateLeavesTheSavedCartExactlyAsItWasAndNothingElseChanges() {
        JsonNode draft = saved(w.cashier, draftBody(UUID.randomUUID(), "Keep me", line(rice, "2", "kg"), line(repair, "1", "pc")));
        UUID id = UUID.fromString(draft.path("id").asString());
        long version = draft.path("version").asLong();
        String before = draftOf(w.cashier, id).path("lines").toString();
        long linesBefore = count("pos_draft_lines");
        // A line that can not be priced (stale price version, fractional count, wrong unit): the whole update is refused.
        Map<String, Object> stale = line(rice, "9", "kg");
        stale.put("expectedPriceVersion", 77);
        for (Map<String, Object> bad : List.of(stale, line(soda, "1.5", "pc"), line(rice, "1", "pc"))) {
            var refused = w.cashier.put(pos() + "/drafts/" + id,
                    Map.of("expectedVersion", version, "note", "Changed", "lines", List.of(line(soda, "3", "pc"), bad)));
            assertThat(refused.status()).as(refused.body()).isEqualTo(422);
            assertThat(refused.code()).isEqualTo("invalid_cart");
        }
        JsonNode after = draftOf(w.cashier, id);
        assertThat(after.path("lines").toString()).isEqualTo(before);
        assertThat(after.path("totalRwf").asLong()).isEqualTo(3_000 + 5_000);
        assertThat(after.path("version").asLong()).isEqualTo(version);
        assertThat(after.path("note").asString()).isEqualTo("Keep me");
        assertThat(count("pos_draft_lines")).isEqualTo(linesBefore);
        // A stale version is a 409 and also changes nothing.
        var conflict = w.cashier.put(pos() + "/drafts/" + id, Map.of("expectedVersion", version + 5, "lines", List.of(line(soda, "3", "pc"))));
        assertThat(conflict.status()).isEqualTo(409);
        assertThat(draftOf(w.cashier, id).path("lines").toString()).isEqualTo(before);
    }

    @Test
    void aDiscardedDraftCanNeitherBeChangedNorDiscardedAgainAndStaleDiscardsConflict() {
        JsonNode draft = saved(w.cashier, draftBody(UUID.randomUUID(), null, line(rice, "1", "kg")));
        UUID id = UUID.fromString(draft.path("id").asString());
        var stale = w.cashier.delete(pos() + "/drafts/" + id + "?expectedVersion=9");
        assertThat(stale.status()).isEqualTo(409);
        assertThat(stale.code()).isEqualTo("version_conflict");
        assertThat(w.cashier.delete(pos() + "/drafts/" + id + "?expectedVersion=0").status()).isEqualTo(200);
        var again = w.cashier.delete(pos() + "/drafts/" + id + "?expectedVersion=1");
        assertThat(again.status()).isEqualTo(409);
        assertThat(again.code()).isEqualTo("draft_not_open");
        var edit = w.cashier.put(pos() + "/drafts/" + id, Map.of("expectedVersion", 1, "lines", List.of(line(rice, "2", "kg"))));
        assertThat(edit.status()).isEqualTo(409);
        assertThat(edit.code()).isEqualTo("draft_not_open");
        JsonNode discarded = draftOf(w.cashier, id);
        assertThat(discarded.path("status").asString()).isEqualTo("DISCARDED");
        // The history stays: the snapshot is still there, and no new draft appeared.
        assertThat(discarded.path("lines").size()).isEqualTo(1);
        assertThat(count("pos_drafts")).isEqualTo(1);
    }

    @Test
    void concurrentUpdatesAndDiscardsOfOneDraftNeverCorruptItAndExactlyOneWins() throws Exception {
        JsonNode draft = saved(w.cashier, draftBody(UUID.randomUUID(), null, line(rice, "1", "kg")));
        UUID id = UUID.fromString(draft.path("id").asString());
        long version = draft.path("version").asLong();
        List<Callable<TestApi.Response>> updates = new ArrayList<>();
        for (int i = 1; i <= 8; i++) {
            String kg = Integer.toString(i);
            updates.add(() -> w.cashier.put(pos() + "/drafts/" + id,
                    Map.of("expectedVersion", version, "lines", List.of(line(rice, kg, "kg"), line(repair, "1", "pc")))));
        }
        List<TestApi.Response> results = concurrently(updates);
        assertThat(results.stream().filter(r -> r.status() == 200).count()).isEqualTo(1);
        assertThat(results.stream().filter(r -> r.status() == 409)).hasSize(7).allSatisfy(r -> assertThat(r.code()).isEqualTo("version_conflict"));
        JsonNode winner = draftOf(w.cashier, id);
        assertThat(winner.path("version").asLong()).isEqualTo(version + 1);
        assertThat(winner.path("lines").size()).isEqualTo(2);
        assertThat(winner.path("totalRwf").asLong()).isEqualTo(lineSum(winner));
        assertThat(jdbc.queryForObject("select count(*) from pos_draft_lines where draft_id = ?", Long.class, id)).isEqualTo(2);
        // An update racing a discard on the same version: one wins, the draft is whole either way.
        long current = winner.path("version").asLong();
        List<Callable<TestApi.Response>> race = List.of(
                () -> w.cashier.put(pos() + "/drafts/" + id, Map.of("expectedVersion", current, "lines", List.of(line(soda, "4", "pc")))),
                () -> w.cashier.delete(pos() + "/drafts/" + id + "?expectedVersion=" + current));
        List<TestApi.Response> raced = concurrently(race);
        assertThat(raced.stream().filter(r -> r.status() == 200).count()).isEqualTo(1);
        assertThat(raced.stream().filter(r -> r.status() != 200)).allSatisfy(r -> assertThat(r.status()).isEqualTo(409));
        JsonNode fin = draftOf(w.cashier, id);
        assertThat(fin.path("totalRwf").asLong()).isEqualTo(lineSum(fin));
        assertThat(fin.path("version").asLong()).isEqualTo(current + 1);
    }

    @Test
    void updatingAndDiscardingCreateNoInvoicePaymentRequestOrStockMovementEither() {
        JsonNode draft = saved(w.cashier, draftBody(UUID.randomUUID(), null, line(rice, "1", "kg")));
        UUID id = UUID.fromString(draft.path("id").asString());
        long invoices = count("invoices");
        long requests = count("payment_requests");
        long movements = count("stock_movements");
        long sequences = count("invoice_number_sequences");
        var updated = w.cashier.put(pos() + "/drafts/" + id, Map.of("expectedVersion", 0, "lines", List.of(line(rice, "5", "kg"))));
        assertThat(updated.status()).isEqualTo(200);
        assertThat(w.cashier.delete(pos() + "/drafts/" + id + "?expectedVersion=1").status()).isEqualTo(200);
        assertThat(count("invoices")).isEqualTo(invoices);
        assertThat(count("payment_requests")).isEqualTo(requests);
        assertThat(count("stock_movements")).isEqualTo(movements);
        assertThat(count("invoice_number_sequences")).isEqualTo(sequences);
    }

    // ---- pricing units --------------------------------------------------------------------------------------------------------

    @Test
    void ricePricedPerKilogramIsBilledForWhatWasEnteredInAnyCompatibleUnit() {
        JsonNode quote = quote(w.cashier, cart(w.branchId, line(rice, "500", "g"), line(rice, "1.5", "kg"), line(rice, "1500", "g"))).json();
        assertThat(quote.path("problems").size()).isZero();
        // 500 g of rice at RWF 1,500 per kg is 0.5 kg: RWF 750.
        assertThat(quote.path("lines").get(0).path("quantityInSaleUnit").asString()).isEqualTo("0.5");
        assertThat(quote.path("lines").get(0).path("unitPriceRwf").asLong()).isEqualTo(1_500);
        assertThat(quote.path("lines").get(0).path("saleUnit").asString()).isEqualTo("kg");
        assertThat(quote.path("lines").get(0).path("lineTotalRwf").asLong()).isEqualTo(750);
        assertThat(quote.path("lines").get(1).path("lineTotalRwf").asLong()).isEqualTo(2_250);
        // 1.5 kg and 1,500 g are the same quantity and the same money.
        assertThat(quote.path("lines").get(2).path("canonicalQuantity").asString()).isEqualTo(quote.path("lines").get(1).path("canonicalQuantity").asString());
        assertThat(quote.path("lines").get(2).path("lineTotalRwf").asLong()).isEqualTo(2_250);
        assertThat(quote.path("totalRwf").asLong()).isEqualTo(750 + 2_250 + 2_250);
    }

    @Test
    void twoLinesOfOneItemInDifferentUnitsAreEachPricedExactlyAndShareOneStockCheck() {
        JsonNode quote = quote(w.cashier, cart(w.branchId, line(rice, "500", "g"), line(rice, "1.5", "kg"))).json();
        assertThat(quote.path("totalRwf").asLong()).isEqualTo(750 + 2_250);
        // Together they ask for 2 kg of the 10 kg on hand: sufficient, and both lines carry the SAME total requested.
        assertThat(quote.path("lines").get(0).path("stock").path("requested").asString()).isEqualTo("2000");
        assertThat(quote.path("lines").get(1).path("stock").path("requested").asString()).isEqualTo("2000");
        assertThat(quote.path("lines").get(0).path("stock").path("state").asString()).isEqualTo("SUFFICIENT");
        // Saved, each keeps its own entered quantity, unit and snapshot.
        JsonNode draft = saved(w.cashier, draftBody(UUID.randomUUID(), null, line(rice, "500", "g"), line(rice, "1.5", "kg")));
        assertThat(draft.path("lines").get(0).path("enteredQuantity").asString()).isEqualTo("500");
        assertThat(draft.path("lines").get(0).path("enteredUnit").asString()).isEqualTo("g");
        assertThat(draft.path("lines").get(1).path("enteredUnit").asString()).isEqualTo("kg");
        assertThat(draft.path("totalRwf").asLong()).isEqualTo(3_000);
    }

    @Test
    void aPackageIsOnlyAQuantityTheItemPriceIsAppliedOnceAndNoClientPackagePriceIsHonoured() {
        // Packages carry no price in the catalog: two crates of 24 pieces at RWF 400 per piece is 48 x 400, applied once.
        Map<String, Object> crates = packageLine(soda, "2", crate);
        crates.put("packagePriceRwf", 1);
        crates.put("unitPriceRwf", 1);
        JsonNode lineOne = quote(w.cashier, cart(w.branchId, crates)).json().path("lines").get(0);
        assertThat(lineOne.path("unitPriceRwf").asLong()).isEqualTo(400);
        assertThat(lineOne.path("quantityInSaleUnit").asString()).isEqualTo("48");
        assertThat(lineOne.path("lineTotalRwf").asLong()).isEqualTo(19_200);
        // The same goods entered as pieces cost exactly the same: nothing is counted twice.
        assertThat(quote(w.cashier, cart(w.branchId, line(soda, "48", "pc"))).json().path("lines").get(0).path("lineTotalRwf").asLong()).isEqualTo(19_200);
        // A package of rice priced per kg: two 25 kg bags are 50 kg times the kg price.
        UUID bagId = UUID.fromString(packageOf(rice, "Bag", "25", "kg").path("id").asString());
        JsonNode bags = quote(w.cashier, cart(w.branchId, packageLine(rice, "2", bagId))).json().path("lines").get(0);
        assertThat(bags.path("quantityInSaleUnit").asString()).isEqualTo("50");
        assertThat(bags.path("lineTotalRwf").asLong()).isEqualTo(50 * 1_500);
    }

    @Test
    void quantityPrecisionAndMoneyRoundingBoundariesFollowThePolicy() {
        JsonNode cheap = item(goods("Salt", "SALT", "MASS", "kg", 500));
        JsonNode tiny = item(goods("Pepper", "PEP", "MASS", "kg", 499));
        // 1 g = 0.001 kg: 500 x 0.001 = 0.5 -> half up -> 1; 499 x 0.001 = 0.499 -> 0, which is refused rather than given away.
        assertThat(quote(w.cashier, cart(w.branchId, line(cheap, "1", "g"))).json().path("lines").get(0).path("lineTotalRwf").asLong()).isEqualTo(1);
        JsonNode giveaway = quote(w.cashier, cart(w.branchId, line(tiny, "1", "g"))).json();
        assertThat(giveaway.path("lines").size()).isZero();
        assertThat(problem(giveaway, 0).path("code").asString()).isEqualTo("line_total_zero");
        assertThat(save(w.cashier, "key-zero-0001", draftBody(UUID.randomUUID(), null, line(tiny, "1", "g"))).code()).isEqualTo("invalid_cart");
        // Rounding is once per line, never per unit: 3 g at RWF 500/kg is 1.5 -> 2, not 3 x 1.
        assertThat(quote(w.cashier, cart(w.branchId, line(cheap, "3", "g"))).json().path("lines").get(0).path("lineTotalRwf").asLong()).isEqualTo(2);
        // Precision: 0.001 kg is the finest bill quantity; 0.1 g is refused, and so is a canonical quantity of more than six decimals.
        assertThat(problem(quote(w.cashier, cart(w.branchId, line(rice, "0.0001", "kg"))).json(), 0).path("code").asString()).isEqualTo("quantity_not_representable");
        assertThat(problem(quote(w.cashier, cart(w.branchId, line(rice, "0.0000000001", "kg"))).json(), 0).path("code").asString()).isEqualTo("precision_exceeded");
        // A quantity so large its money overflows is explained, not wrapped.
        JsonNode precious = item(goods("Gold", "GOLD", "MASS", "kg", 1_000_000_000));
        assertThat(problem(quote(w.cashier, cart(w.branchId, line(precious, "99999999999", "kg"))).json(), 0).path("code").asString()).isEqualTo("line_total_too_large");
    }

    // ---- tax, authoritative price, isolation --------------------------------------------------------------------------------------

    @Test
    void everyQuoteAndDraftLabelsTheTotalProvisionalAndNoTaxIsCalculated() {
        JsonNode quote = quote(w.cashier, cart(w.branchId, line(rice, "2", "kg"))).json();
        assertThat(quote.path("taxNote").asString()).contains("Provisional total").contains("tax is not calculated");
        JsonNode draft = saved(w.cashier, draftBody(UUID.randomUUID(), null, line(rice, "2", "kg")));
        assertThat(draft.path("taxNote").asString()).contains("Provisional total");
        assertThat(draftOf(w.cashier, UUID.fromString(draft.path("id").asString())).path("taxNote").asString()).contains("prices are rechecked when you bill");
        // The draft total is exactly the sum of the lines: no tax is added anywhere.
        assertThat(draft.path("totalRwf").asLong()).isEqualTo(3_000);
    }

    @Test
    void aStalePriceCanNeitherBeSavedNorSilentlyBecomeTheDraftPrice() {
        JsonNode draft = saved(w.cashier, draftBody(UUID.randomUUID(), null, line(rice, "2", "kg")));
        UUID id = UUID.fromString(draft.path("id").asString());
        var repriced = w.owner.put(catalog() + "/items/" + rice.path("id").asString(), Map.of("expectedVersion", rice.path("version").asLong(), "name", "Rice",
                "code", "RICE-25", "saleUnit", "kg", "pricePerSaleUnitRwf", 1_800, "priceChangeReason", "Market"));
        assertThat(repriced.status()).isEqualTo(200);
        // Re-saving the OLD cart (price version 1) is refused; the draft keeps its snapshot; creating with the old version is refused too.
        var update = w.cashier.put(pos() + "/drafts/" + id, Map.of("expectedVersion", 0, "lines", List.of(line(rice, "2", "kg"))));
        assertThat(update.status()).isEqualTo(422);
        assertThat(draftOf(w.cashier, id).path("lines").get(0).path("unitPriceRwf").asLong()).isEqualTo(1_500);
        assertThat(save(w.cashier, "key-stale-0002", draftBody(UUID.randomUUID(), null, line(rice, "1", "kg"))).code()).isEqualTo("invalid_cart");
    }

    @Test
    void aDraftLineCanNeverPointAtAnotherBusinessCatalogItemOrPrice() {
        JsonNode cafeItem = w.cafeOwner.post("/api/v1/merchants/" + w.cafeMerchantId + "/catalog/items", goods("Beans", "BEANS", "MASS", "kg", 900)).json();
        // Through the API the shop never sees it...
        assertThat(problem(quote(w.cashier, cart(w.branchId, line(cafeItem, "1", "kg"))).json(), 0).path("code").asString()).isEqualTo("item_not_found");
        assertThat(save(w.cashier, "key-iso-00001", draftBody(UUID.randomUUID(), null, line(cafeItem, "1", "kg"))).status()).isEqualTo(422);
        // ...and the database itself refuses a line of the shop draft that names the cafe item.
        JsonNode draft = saved(w.cashier, draftBody(UUID.randomUUID(), null, line(rice, "1", "kg")));
        UUID id = UUID.fromString(draft.path("id").asString());
        assertThatThrownBy(() -> jdbc.update("insert into pos_draft_lines (id, draft_id, merchant_id, line_no, item_id, item_type, item_name, measurement_dimension, "
                + "entered_quantity, entered_unit, sale_unit, quantity_milli, canonical_quantity, price_version, unit_price_rwf, line_total_rwf) "
                + "values (?, ?, ?, 7, ?::uuid, 'GOODS', 'Beans', 'MASS', '1', 'kg', 'kg', 1000, 1000, 1, 900, 900)", UUID.randomUUID(), id, w.merchantId,
                cafeItem.path("id").asString())).isNotNull();
        assertThat(count("pos_draft_lines")).isEqualTo(1);
    }
}
