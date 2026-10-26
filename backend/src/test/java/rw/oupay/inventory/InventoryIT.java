package rw.oupay.inventory;

import static org.assertj.core.api.Assertions.assertThat;

import java.math.BigDecimal;
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

/** R5c: branch inventory through the real API: exactness, history, isolation, authorisation, idempotency and concurrency. */
class InventoryIT extends IntegrationTest {

    World w;
    UUID secondBranchId;
    JsonNode rice;
    JsonNode soda;
    JsonNode haircut;

    @BeforeEach
    void world() {
        w = World.create(this);
        secondBranchId = fixtures.branch(w.merchantId, "RM02", "ACTIVE");
        rice = catalogItem(goods("Rice", "RICE", "MASS", "kg"));
        soda = catalogItem(goods("Soda", "SODA", "COUNT", "pc"));
        haircut = catalogItem(Map.of("itemType", "SERVICE", "name", "Haircut", "pricePerSaleUnitRwf", 3_000));
    }

    // --- helpers ----------------------------------------------------------------------------------------

    private String base() {
        return "/api/v1/merchants/" + w.merchantId + "/inventory";
    }

    private static Map<String, Object> goods(String name, String code, String dimension, String saleUnit) {
        Map<String, Object> body = new HashMap<>();
        body.put("itemType", "GOODS");
        body.put("name", name);
        body.put("code", code);
        body.put("measurementDimension", dimension);
        body.put("saleUnit", saleUnit);
        body.put("pricePerSaleUnitRwf", 1_000);
        return body;
    }

    private JsonNode catalogItem(Map<String, Object> body) {
        var response = w.owner.post("/api/v1/merchants/" + w.merchantId + "/catalog/items", body);
        assertThat(response.status()).as(response.body()).isEqualTo(201);
        return response.json();
    }

    private JsonNode catalogPackage(JsonNode item, String label, String amount, String unit) {
        var response = w.owner.post("/api/v1/merchants/" + w.merchantId + "/catalog/items/" + item.path("id").asString() + "/packages",
                Map.of("label", label, "contentsAmount", amount, "contentsUnit", unit));
        assertThat(response.status()).as(response.body()).isEqualTo(201);
        return response.json();
    }

    private static UUID id(JsonNode node) {
        return UUID.fromString(node.asString());
    }

    /** A stock entry by amount and unit, with a fresh operation id. */
    private Map<String, Object> entry(UUID branchId, JsonNode item, String amount, String unit) {
        Map<String, Object> body = new HashMap<>();
        body.put("clientOperationId", UUID.randomUUID().toString());
        body.put("branchId", branchId.toString());
        body.put("itemId", item.path("id").asString());
        body.put("amount", amount);
        body.put("unit", unit);
        return body;
    }

    private Map<String, Object> adjustment(UUID branchId, JsonNode item, String direction, String amount, String unit, String reason) {
        Map<String, Object> body = entry(branchId, item, amount, unit);
        body.put("direction", direction);
        body.put("reason", reason);
        return body;
    }

    private TestApi.Response receive(TestApi api, Map<String, Object> body) {
        return api.post(base() + "/receive", body);
    }

    private TestApi.Response open(TestApi api, Map<String, Object> body) {
        return api.post(base() + "/opening", body);
    }

    private TestApi.Response adjust(TestApi api, Map<String, Object> body) {
        return api.post(base() + "/adjust", body);
    }

    private JsonNode ok(TestApi.Response response, int status) {
        assertThat(response.status()).as(response.body()).isEqualTo(status);
        return response.json();
    }

    private BigDecimal onHand(UUID branchId, JsonNode item) {
        var rows = jdbc.queryForList("select quantity_on_hand from inventory_balances where branch_id = ? and item_id = ?", BigDecimal.class,
                branchId, id(item.path("id")));
        return rows.isEmpty() ? null : rows.get(0);
    }

    private long count(String table) {
        return jdbc.queryForObject("select count(*) from " + table, Long.class);
    }

    private long auditCount(String kind) {
        return jdbc.queryForObject("select count(*) from audit_log where kind = ?", Long.class, kind);
    }

    private void setMode(UUID merchantId, String mode) {
        jdbc.update("insert into merchant_settings (merchant_id, operating_mode, updated_at, version) values (?, ?, now(), 0) "
                + "on conflict (merchant_id) do update set operating_mode = excluded.operating_mode", merchantId, mode);
    }

    private static boolean isAbsent(JsonNode node) {
        return node.isMissingNode() || node.isNull();
    }

    private void assertBalancesMatchHistory() {
        assertThat(jdbc.queryForList("select b.id from inventory_balances b where b.quantity_on_hand <> "
                + "coalesce((select sum(m.quantity_delta) from stock_movements m where m.merchant_id = b.merchant_id "
                + "and m.branch_id = b.branch_id and m.item_id = b.item_id), 0)", UUID.class)).isEmpty();
        assertThat(jdbc.queryForList("select b.id from inventory_balances b where b.quantity_on_hand <> "
                + "coalesce((select m.balance_after from stock_movements m where m.merchant_id = b.merchant_id "
                + "and m.branch_id = b.branch_id and m.item_id = b.item_id order by m.created_at desc, m.id desc limit 1), 0)",
                UUID.class)).isEmpty();
    }

    // --- opening, receiving, adjusting ------------------------------------------------------------------

    @Test
    void recordsOpeningReceiptAndAdjustmentsWithExactBalancesAndHistory() {
        JsonNode bag = catalogPackage(rice, "Bag", "25", "kg");
        var opening = ok(open(w.owner, entry(w.branchId, rice, "100", "kg")), 201);
        assertThat(opening.path("replayed").asBoolean()).isFalse();
        assertThat(opening.path("movement").path("movementType").asString()).isEqualTo("OPENING");
        assertThat(opening.path("movement").path("quantityDelta").asString()).isEqualTo("100000");
        assertThat(opening.path("movement").path("balanceAfter").asString()).isEqualTo("100000");
        assertThat(opening.path("movement").path("stockUnit").asString()).isEqualTo("g");
        assertThat(opening.path("movement").path("enteredAs").asString()).isEqualTo("100 kg");
        assertThat(opening.path("balance").path("quantityOnHand").asString()).isEqualTo("100000");
        assertThat(opening.path("balance").path("quantityInSaleUnit").asString()).isEqualTo("100");
        assertThat(opening.path("balance").path("saleUnit").asString()).isEqualTo("kg");

        Map<String, Object> byPackage = new HashMap<>();
        byPackage.put("clientOperationId", UUID.randomUUID().toString());
        byPackage.put("branchId", w.branchId.toString());
        byPackage.put("itemId", rice.path("id").asString());
        byPackage.put("packageId", bag.path("id").asString());
        byPackage.put("packageCount", "2");
        byPackage.put("reference", "DN-0042");
        var received = ok(receive(w.manager, byPackage), 201);
        assertThat(received.path("movement").path("quantityDelta").asString()).isEqualTo("50000");
        assertThat(received.path("movement").path("enteredAs").asString()).isEqualTo("2 x Bag");
        assertThat(received.path("movement").path("reference").asString()).isEqualTo("DN-0042");
        assertThat(received.path("movement").path("actorName").asString()).isEqualTo(w.managerPerson.fullName());
        assertThat(received.path("balance").path("quantityOnHand").asString()).isEqualTo("150000");

        var out = ok(adjust(w.owner, adjustment(w.branchId, rice, "OUT", "0.25", "kg", "Damaged in storage")), 201);
        assertThat(out.path("movement").path("movementType").asString()).isEqualTo("ADJUST_OUT");
        assertThat(out.path("movement").path("quantityDelta").asString()).isEqualTo("-250");
        assertThat(out.path("movement").path("reason").asString()).isEqualTo("Damaged in storage");
        assertThat(out.path("balance").path("quantityOnHand").asString()).isEqualTo("149750");
        assertThat(out.path("balance").path("quantityInSaleUnit").asString()).isEqualTo("149.75");

        var in = ok(adjust(w.owner, adjustment(w.branchId, rice, "IN", "1", "kg", "Found during count")), 201);
        assertThat(in.path("movement").path("movementType").asString()).isEqualTo("ADJUST_IN");
        assertThat(in.path("balance").path("quantityOnHand").asString()).isEqualTo("150750");

        var history = w.owner.get(base() + "/movements").json().path("items");
        assertThat(history.size()).isEqualTo(4);
        assertThat(history.get(0).path("movementType").asString()).isEqualTo("ADJUST_IN");
        assertThat(history.get(1).path("quantityDelta").asString()).isEqualTo("-250");
        assertThat(history.get(1).path("balanceAfter").asString()).isEqualTo("149750");
        assertThat(history.get(3).path("movementType").asString()).isEqualTo("OPENING");
        assertThat(history.get(3).path("itemName").asString()).isEqualTo("Rice");
        assertThat(history.get(3).path("branchName").asString()).isEqualTo("Branch RM01");
        assertBalancesMatchHistory();
        assertThat(count("stock_movements")).isEqualTo(4);
        assertThat(count("inventory_balances")).isEqualTo(1);
    }

    @Test
    void balancesAreListedPerBranchAndItem() {
        open(w.owner, entry(w.branchId, rice, "10", "kg"));
        open(w.owner, entry(secondBranchId, rice, "4", "kg"));
        open(w.owner, entry(w.branchId, soda, "48", "pc"));
        var all = w.owner.get(base() + "/balances").json().path("items");
        assertThat(all.size()).isEqualTo(3);
        var second = w.owner.get(base() + "/balances?branchId=" + secondBranchId).json().path("items");
        assertThat(second.size()).isEqualTo(1);
        assertThat(second.get(0).path("quantityOnHand").asString()).isEqualTo("4000");
        assertThat(second.get(0).path("branchCode").asString()).isEqualTo("RM02");
        assertThat(w.owner.get(base() + "/balances?itemId=" + soda.path("id").asString()).json().path("items").size()).isEqualTo(1);
        assertThat(w.owner.get(base() + "/balances?q=soda").json().path("items").size()).isEqualTo(1);
        assertThat(w.owner.get(base() + "/balances?q=RICE").json().path("items").size()).isEqualTo(2);
        assertThat(w.owner.get(base() + "/balances?q=nothing").json().path("items").size()).isZero();
        var onlySoda = w.owner.get(base() + "/balances?q=soda").json().path("items").get(0);
        assertThat(onlySoda.path("stockUnit").asString()).isEqualTo("pc");
        assertThat(onlySoda.path("quantityOnHand").asString()).isEqualTo("48");
    }

    // --- exact quantities -------------------------------------------------------------------------------

    @Test
    void quantitiesAreExactAndNeverRounded() {
        // 0.0000001 kg is 0.0001 g: representable.
        var tiny = ok(receive(w.owner, entry(w.branchId, rice, "0.0000001", "kg")), 201);
        assertThat(tiny.path("balance").path("quantityOnHand").asString()).isEqualTo("0.0001");
        assertThat(tiny.path("balance").path("quantityInSaleUnit").asString()).isEqualTo("0.0000001");
        assertThat(onHand(w.branchId, rice).toPlainString()).isEqualTo("0.000100");
        long movements = count("stock_movements");
        // 0.0000000001 kg is 0.0000001 g: not representable at six decimals. Nothing changes.
        assertThat(receive(w.owner, entry(w.branchId, rice, "0.0000000001", "kg")).code()).isEqualTo("precision_exceeded");
        assertThat(receive(w.owner, entry(w.branchId, rice, "100000000000", "kg")).code()).isEqualTo("quantity_out_of_range");
        assertThat(receive(w.owner, entry(w.branchId, rice, "abc", "kg")).code()).isEqualTo("invalid_quantity");
        assertThat(receive(w.owner, entry(w.branchId, rice, "1e3", "kg")).code()).isEqualTo("invalid_quantity");
        assertThat(receive(w.owner, entry(w.branchId, rice, "1", "stone")).code()).isEqualTo("unsupported_unit");
        assertThat(receive(w.owner, entry(w.branchId, rice, "1", "l")).code()).isEqualTo("dimension_mismatch");
        assertThat(count("stock_movements")).isEqualTo(movements);
        assertThat(onHand(w.branchId, rice).toPlainString()).isEqualTo("0.000100");
        assertBalancesMatchHistory();
    }

    @Test
    void theBalanceStaysWithinTheStorageRange() {
        ok(receive(w.owner, entry(w.branchId, rice, "99999999999999.999999", "g")), 201);
        var overflow = receive(w.owner, entry(w.branchId, rice, "0.000001", "g"));
        assertThat(overflow.status()).isEqualTo(422);
        assertThat(overflow.code()).isEqualTo("quantity_out_of_range");
        assertThat(onHand(w.branchId, rice).toPlainString()).isEqualTo("99999999999999.999999");
        assertThat(count("stock_movements")).isEqualTo(1);
    }

    @Test
    void discreteGoodsCannotHoldFractionalPieces() {
        JsonNode carton = catalogPackage(soda, "Carton", "24", "pc");
        assertThat(receive(w.owner, entry(w.branchId, soda, "1.5", "pc")).code()).isEqualTo("invalid_count");
        assertThat(receive(w.owner, entry(w.branchId, soda, "0.000001", "pc")).code()).isEqualTo("invalid_count");
        ok(receive(w.owner, entry(w.branchId, soda, "24", "pc")), 201);

        Map<String, Object> half = new HashMap<>();
        half.put("clientOperationId", UUID.randomUUID().toString());
        half.put("branchId", w.branchId.toString());
        half.put("itemId", soda.path("id").asString());
        half.put("packageId", carton.path("id").asString());
        half.put("packageCount", "1.5");
        var thirtySix = ok(receive(w.owner, half), 201);
        assertThat(thirtySix.path("movement").path("quantityDelta").asString()).isEqualTo("36");
        half.put("clientOperationId", UUID.randomUUID().toString());
        half.put("packageCount", "0.1");
        assertThat(receive(w.owner, half).code()).isEqualTo("invalid_count");
        assertThat(onHand(w.branchId, soda).toPlainString()).isEqualTo("60.000000");
    }

    @Test
    void anEntryIsEitherAnAmountOrAPackageAndMustBePositive() {
        JsonNode bag = catalogPackage(rice, "Bag", "25", "kg");
        Map<String, Object> both = entry(w.branchId, rice, "1", "kg");
        both.put("packageId", bag.path("id").asString());
        both.put("packageCount", "1");
        assertThat(receive(w.owner, both).status()).isEqualTo(422);
        Map<String, Object> neither = entry(w.branchId, rice, "1", "kg");
        neither.remove("amount");
        neither.remove("unit");
        assertThat(receive(w.owner, neither).status()).isEqualTo(422);
        Map<String, Object> amountOnly = entry(w.branchId, rice, "1", "kg");
        amountOnly.remove("unit");
        assertThat(receive(w.owner, amountOnly).status()).isEqualTo(422);
        assertThat(receive(w.owner, entry(w.branchId, rice, "0", "kg")).status()).isEqualTo(422);
        assertThat(receive(w.owner, entry(w.branchId, rice, "-5", "kg")).status()).isEqualTo(422);
        assertThat(receive(w.owner, entry(w.branchId, rice, "0.000000", "g")).status()).isEqualTo(422);
        Map<String, Object> noOperation = entry(w.branchId, rice, "1", "kg");
        noOperation.remove("clientOperationId");
        assertThat(receive(w.owner, noOperation).status()).isEqualTo(422);
        assertThat(count("stock_movements")).isZero();
        assertThat(count("inventory_balances")).isZero();
    }

    @Test
    void packagesMustBelongToTheItemAndBeActive() {
        JsonNode bag = catalogPackage(rice, "Bag", "25", "kg");
        Map<String, Object> wrongItem = new HashMap<>();
        wrongItem.put("clientOperationId", UUID.randomUUID().toString());
        wrongItem.put("branchId", w.branchId.toString());
        wrongItem.put("itemId", soda.path("id").asString());
        wrongItem.put("packageId", bag.path("id").asString());
        wrongItem.put("packageCount", "1");
        assertThat(receive(w.owner, wrongItem).status()).isEqualTo(404);

        w.owner.put("/api/v1/merchants/" + w.merchantId + "/catalog/items/" + rice.path("id").asString() + "/packages/" + bag.path("id").asString(),
                Map.of("expectedVersion", bag.path("version").asLong(), "label", "Bag", "contentsAmount", "25", "contentsUnit", "kg", "active", false));
        Map<String, Object> inactive = new HashMap<>(wrongItem);
        inactive.put("clientOperationId", UUID.randomUUID().toString());
        inactive.put("itemId", rice.path("id").asString());
        var response = receive(w.owner, inactive);
        assertThat(response.status()).isEqualTo(422);
        assertThat(response.code()).isEqualTo("package_inactive");
        assertThat(count("stock_movements")).isZero();
    }

    // --- goods versus services --------------------------------------------------------------------------

    @Test
    void servicesNeverHaveStock() {
        for (var response : List.of(open(w.owner, entry(w.branchId, haircut, "1", "pc")), receive(w.owner, entry(w.branchId, haircut, "1", "pc")),
                adjust(w.owner, adjustment(w.branchId, haircut, "IN", "1", "pc", "Count")))) {
            assertThat(response.status()).as(response.body()).isEqualTo(422);
            assertThat(response.code()).isEqualTo("invalid_item");
        }
        assertThat(count("inventory_balances")).isZero();
        assertThat(count("stock_movements")).isZero();
        assertThat(w.owner.get(base() + "/balances").json().path("items").size()).isZero();
    }

    @Test
    void inactiveItemsKeepTheirStockAndCanStillBeReceived() {
        ok(open(w.owner, entry(w.branchId, rice, "5", "kg")), 201);
        var off = w.owner.put("/api/v1/merchants/" + w.merchantId + "/catalog/items/" + rice.path("id").asString() + "/status",
                Map.of("expectedVersion", rice.path("version").asLong(), "active", false));
        assertThat(off.status()).isEqualTo(200);
        assertThat(w.owner.get(base() + "/balances").json().path("items").size()).isEqualTo(1);
        ok(receive(w.owner, entry(w.branchId, rice, "1", "kg")), 201);
        assertThat(onHand(w.branchId, rice).toPlainString()).isEqualTo("6000.000000");
    }

    // --- negative stock and opening rules ---------------------------------------------------------------

    @Test
    void stockCanNeverGoNegative() {
        ok(open(w.owner, entry(w.branchId, rice, "2", "kg")), 201);
        var tooMuch = adjust(w.owner, adjustment(w.branchId, rice, "OUT", "2.000001", "kg", "Shrinkage"));
        assertThat(tooMuch.status()).isEqualTo(409);
        assertThat(tooMuch.code()).isEqualTo("insufficient_stock");
        assertThat(onHand(w.branchId, rice).toPlainString()).isEqualTo("2000.000000");
        assertThat(count("stock_movements")).isEqualTo(1);
        // Exactly everything is allowed and leaves zero.
        var all = ok(adjust(w.owner, adjustment(w.branchId, rice, "OUT", "2", "kg", "Written off")), 201);
        assertThat(all.path("balance").path("quantityOnHand").asString()).isEqualTo("0");
        assertThat(adjust(w.owner, adjustment(w.branchId, rice, "OUT", "0.000001", "g", "Nothing left")).code()).isEqualTo("insufficient_stock");
        assertBalancesMatchHistory();
    }

    @Test
    void aFailedFirstOperationLeavesNoBalanceMovementOrAuditEntry() {
        long audits = count("audit_log");
        var response = adjust(w.owner, adjustment(w.branchId, rice, "OUT", "1", "kg", "Nothing to remove"));
        assertThat(response.status()).isEqualTo(409);
        assertThat(count("inventory_balances")).isZero();
        assertThat(count("stock_movements")).isZero();
        assertThat(count("audit_log")).isEqualTo(audits);
        // An invalid conversion on an item that already has stock changes nothing either.
        ok(receive(w.owner, entry(w.branchId, rice, "3", "kg")), 201);
        assertThat(receive(w.owner, entry(w.branchId, rice, "0.0000000001", "kg")).status()).isEqualTo(422);
        assertThat(onHand(w.branchId, rice).toPlainString()).isEqualTo("3000.000000");
        assertThat(count("stock_movements")).isEqualTo(1);
        assertBalancesMatchHistory();
    }

    @Test
    void openingStockIsRecordedOnceAndBeforeAnyOtherMovement() {
        ok(open(w.owner, entry(w.branchId, rice, "5", "kg")), 201);
        var second = open(w.owner, entry(w.branchId, rice, "9", "kg"));
        assertThat(second.status()).isEqualTo(409);
        assertThat(second.code()).isEqualTo("opening_already_recorded");
        // Another branch and another item have their own opening.
        ok(open(w.owner, entry(secondBranchId, rice, "9", "kg")), 201);
        ok(open(w.owner, entry(w.branchId, soda, "9", "pc")), 201);
        // After a receipt, an opening is refused.
        ok(receive(w.owner, entry(w.branchId, rice, "1", "kg")), 201);
        JsonNode sugar = catalogItem(goods("Sugar", "SUGAR", "MASS", "kg"));
        ok(receive(w.owner, entry(w.branchId, sugar, "1", "kg")), 201);
        assertThat(open(w.owner, entry(w.branchId, sugar, "9", "kg")).code()).isEqualTo("opening_already_recorded");
        assertThat(onHand(w.branchId, rice).toPlainString()).isEqualTo("6000.000000");
    }

    @Test
    void adjustmentsNeedAnExplicitDirectionAndReason() {
        ok(open(w.owner, entry(w.branchId, rice, "5", "kg")), 201);
        Map<String, Object> noReason = adjustment(w.branchId, rice, "OUT", "1", "kg", null);
        noReason.remove("reason");
        assertThat(adjust(w.owner, noReason).status()).isEqualTo(422);
        assertThat(adjust(w.owner, adjustment(w.branchId, rice, "OUT", "1", "kg", "   ")).status()).isEqualTo(422);
        assertThat(adjust(w.owner, adjustment(w.branchId, rice, "SIDEWAYS", "1", "kg", "Why")).status()).isEqualTo(422);
        Map<String, Object> noDirection = adjustment(w.branchId, rice, "OUT", "1", "kg", "Why");
        noDirection.remove("direction");
        assertThat(adjust(w.owner, noDirection).status()).isEqualTo(422);
        assertThat(adjust(w.owner, adjustment(w.branchId, rice, "OUT", "1", "kg", "x".repeat(201))).status()).isEqualTo(422);
        assertThat(count("stock_movements")).isEqualTo(1);
    }

    // --- durable idempotency ----------------------------------------------------------------------------

    @Test
    void repeatingAnOperationNeverAddsStockTwice() {
        Map<String, Object> body = entry(w.branchId, rice, "10", "kg");
        var first = ok(receive(w.owner, body), 201);
        var again = ok(receive(w.owner, body), 200);
        assertThat(again.path("replayed").asBoolean()).isTrue();
        assertThat(again.path("movement").path("id").asString()).isEqualTo(first.path("movement").path("id").asString());
        assertThat(again.path("balance").path("quantityOnHand").asString()).isEqualTo("10000");
        assertThat(onHand(w.branchId, rice).toPlainString()).isEqualTo("10000.000000");
        assertThat(count("stock_movements")).isEqualTo(1);
        assertThat(auditCount("INVENTORY_STOCK_RECEIVED")).isEqualTo(1);

        // The same quantity written another way is the same operation.
        Map<String, Object> spelledInGrams = new HashMap<>(body);
        spelledInGrams.put("amount", "10000");
        spelledInGrams.put("unit", "g");
        assertThat(receive(w.owner, spelledInGrams).status()).isEqualTo(200);

        // A replay reports the CURRENT balance, not the balance at the time.
        ok(receive(w.owner, entry(w.branchId, rice, "1", "kg")), 201);
        assertThat(ok(receive(w.owner, body), 200).path("balance").path("quantityOnHand").asString()).isEqualTo("11000");
        assertThat(onHand(w.branchId, rice).toPlainString()).isEqualTo("11000.000000");
    }

    @Test
    void theSameIdWithADifferentRequestIsAConflictAndChangesNothing() {
        Map<String, Object> body = entry(w.branchId, rice, "10", "kg");
        ok(receive(w.owner, body), 201);
        for (Map<String, Object> changed : List.of(withAmount(body, "11"), with(body, "branchId", secondBranchId.toString()),
                with(body, "itemId", soda.path("id").asString()), with(body, "reference", "OTHER"))) {
            var response = receive(w.owner, changed);
            assertThat(response.status()).as(response.body()).isIn(409, 422);
            if (response.status() == 409) {
                assertThat(response.code()).isEqualTo("operation_id_reuse");
            }
        }
        // The same id under another movement type is a different operation too.
        Map<String, Object> asAdjustment = new HashMap<>(body);
        asAdjustment.put("direction", "IN");
        asAdjustment.put("reason", "Recount");
        assertThat(adjust(w.owner, asAdjustment).code()).isEqualTo("operation_id_reuse");
        // And so is another person using it.
        assertThat(receive(w.manager, body).code()).isEqualTo("operation_id_reuse");
        assertThat(onHand(w.branchId, rice).toPlainString()).isEqualTo("10000.000000");
        assertThat(count("stock_movements")).isEqualTo(1);
    }

    private static Map<String, Object> with(Map<String, Object> body, String key, Object value) {
        Map<String, Object> copy = new HashMap<>(body);
        copy.put(key, value);
        return copy;
    }

    private static Map<String, Object> withAmount(Map<String, Object> body, String amount) {
        return with(body, "amount", amount);
    }

    @Test
    void idempotencyIsDurableAndDoesNotRelyOnTheHttpIdempotencyRecords() {
        Map<String, Object> body = entry(w.branchId, rice, "10", "kg");
        ok(receive(w.owner, body), 201);
        // The operation id is the stored identity: no HTTP idempotency record is involved at all, so nothing can be pruned.
        assertThat(count("idempotency_keys")).isZero();
        jdbc.update("delete from idempotency_keys");
        assertThat(receive(w.owner, body).status()).isEqualTo(200);
        assertThat(jdbc.queryForObject("select count(*) from stock_movements where operation_id = ?", Long.class, UUID.fromString((String) body.get("clientOperationId"))))
                .isEqualTo(1);
        assertThat(onHand(w.branchId, rice).toPlainString()).isEqualTo("10000.000000");
    }

    @Test
    void anOperationIdOfAnotherBusinessIsIndependent() {
        Map<String, Object> body = entry(w.branchId, rice, "10", "kg");
        ok(receive(w.owner, body), 201);
        // The cafe owner cannot see the shop's data and its own use of the same id is its own operation.
        var cafeCatalog = w.cafeOwner.post("/api/v1/merchants/" + w.cafeMerchantId + "/catalog/items", goods("Coffee", "COF", "MASS", "kg"));
        assertThat(cafeCatalog.status()).isEqualTo(201);
        Map<String, Object> cafe = new HashMap<>(body);
        cafe.put("branchId", w.cafeBranchId.toString());
        cafe.put("itemId", cafeCatalog.json().path("id").asString());
        var response = w.cafeOwner.post("/api/v1/merchants/" + w.cafeMerchantId + "/inventory/receive", cafe);
        assertThat(response.status()).as(response.body()).isEqualTo(201);
        assertThat(count("stock_movements")).isEqualTo(2);
    }

    // --- concurrency ------------------------------------------------------------------------------------

    @Test
    void concurrentReceiptsAreAllCountedExactly() throws Exception {
        List<Callable<TestApi.Response>> tasks = new ArrayList<>();
        for (int i = 0; i < 8; i++) {
            TestApi api = i % 2 == 0 ? w.owner : w.manager;
            Map<String, Object> body = entry(w.branchId, rice, "1", "kg");
            tasks.add(() -> receive(api, body));
        }
        List<TestApi.Response> results = runTogether(tasks);
        assertThat(results.stream().filter(r -> r.status() == 201).count()).as(results.toString()).isEqualTo(8);
        assertThat(count("inventory_balances")).isEqualTo(1);
        assertThat(count("stock_movements")).isEqualTo(8);
        assertThat(onHand(w.branchId, rice).toPlainString()).isEqualTo("8000.000000");
        assertBalancesMatchHistory();
    }

    @Test
    void concurrentRemovalsCanNeverTakeMoreThanIsThere() throws Exception {
        ok(open(w.owner, entry(w.branchId, rice, "5", "kg")), 201);
        List<Callable<TestApi.Response>> tasks = new ArrayList<>();
        for (int i = 0; i < 9; i++) {
            TestApi api = i % 2 == 0 ? w.owner : w.manager;
            Map<String, Object> body = adjustment(w.branchId, rice, "OUT", "1", "kg", "Sold off-system " + i);
            tasks.add(() -> adjust(api, body));
        }
        List<TestApi.Response> results = runTogether(tasks);
        assertThat(results.stream().filter(r -> r.status() == 201).count()).isEqualTo(5);
        assertThat(results.stream().filter(r -> r.status() == 409 && "insufficient_stock".equals(r.code())).count()).isEqualTo(4);
        assertThat(onHand(w.branchId, rice).toPlainString()).isEqualTo("0.000000");
        assertThat(count("stock_movements")).isEqualTo(6);
        assertBalancesMatchHistory();
    }

    @Test
    void concurrentRepeatsOfOneOperationAddStockOnce() throws Exception {
        Map<String, Object> body = entry(w.branchId, rice, "10", "kg");
        List<Callable<TestApi.Response>> tasks = new ArrayList<>();
        for (int i = 0; i < 6; i++) {
            // The same person repeats the request (a double click, a retry): one receipt, five replays.
            tasks.add(() -> receive(w.owner, body));
        }
        List<TestApi.Response> results = runTogether(tasks);
        assertThat(results.stream().filter(r -> r.status() == 201).count()).isEqualTo(1);
        assertThat(results.stream().filter(r -> r.status() == 200 && r.json().path("replayed").asBoolean()).count()).isEqualTo(5);
        assertThat(count("stock_movements")).isEqualTo(1);
        assertThat(onHand(w.branchId, rice).toPlainString()).isEqualTo("10000.000000");
    }

    @Test
    void concurrentFirstOperationsOnAnEmptyBalanceCreateOneBalance() throws Exception {
        List<Callable<TestApi.Response>> tasks = new ArrayList<>();
        for (int i = 0; i < 6; i++) {
            Map<String, Object> body = entry(w.branchId, soda, "2", "pc");
            tasks.add(() -> receive(w.owner, body));
        }
        runTogether(tasks);
        assertThat(count("inventory_balances")).isEqualTo(1);
        assertThat(onHand(w.branchId, soda).toPlainString()).isEqualTo("12.000000");
        assertBalancesMatchHistory();
    }

    @Test
    void concurrentMixedTrafficOnSeveralBalancesStaysConsistent() throws Exception {
        ok(open(w.owner, entry(w.branchId, rice, "50", "kg")), 201);
        ok(open(w.owner, entry(secondBranchId, rice, "50", "kg")), 201);
        List<Callable<TestApi.Response>> tasks = new ArrayList<>();
        for (int i = 0; i < 12; i++) {
            UUID branch = i % 2 == 0 ? w.branchId : secondBranchId;
            Map<String, Object> body = i % 3 == 0 ? adjustment(branch, rice, "OUT", "2", "kg", "Spoiled " + i) : entry(branch, rice, "3", "kg");
            boolean out = i % 3 == 0;
            tasks.add(() -> out ? adjust(w.owner, body) : receive(w.owner, body));
        }
        List<TestApi.Response> results = runTogether(tasks);
        assertThat(results.stream().allMatch(r -> r.status() == 201)).as(results.toString()).isTrue();
        assertBalancesMatchHistory();
        assertThat(count("stock_movements")).isEqualTo(14);
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
                results.add(future.get(60, TimeUnit.SECONDS));
            }
            return results;
        } finally {
            pool.shutdownNow();
        }
    }

    // --- authorisation and isolation --------------------------------------------------------------------

    @Test
    void cashiersOnlyViewAndOnlyTheirOwnBranches() {
        ok(open(w.owner, entry(w.branchId, rice, "5", "kg")), 201);
        ok(open(w.owner, entry(secondBranchId, rice, "7", "kg")), 201);
        // The cashier is assigned to RM01 only.
        var balances = w.cashier.get(base() + "/balances");
        assertThat(balances.status()).isEqualTo(200);
        assertThat(balances.json().path("items").size()).isEqualTo(1);
        assertThat(balances.json().path("items").get(0).path("branchCode").asString()).isEqualTo("RM01");
        assertThat(w.cashier.get(base() + "/balances?branchId=" + secondBranchId).json().path("items").size()).isZero();
        assertThat(w.cashier.get(base() + "/movements").json().path("items").size()).isEqualTo(1);
        assertThat(w.cashier.get(base() + "/movements?branchId=" + secondBranchId).json().path("items").size()).isZero();
        var options = w.cashier.get(base() + "/options").json().path("branches");
        assertThat(options.size()).isEqualTo(1);
        assertThat(options.get(0).path("writable").asBoolean()).isFalse();

        assertThat(open(w.cashier, entry(w.branchId, rice, "1", "kg")).status()).isEqualTo(403);
        assertThat(receive(w.cashier, entry(w.branchId, rice, "1", "kg")).status()).isEqualTo(403);
        assertThat(adjust(w.cashier, adjustment(w.branchId, rice, "IN", "1", "kg", "Nope")).status()).isEqualTo(403);
        assertThat(onHand(w.branchId, rice).toPlainString()).isEqualTo("5000.000000");
        assertThat(count("stock_movements")).isEqualTo(2);
    }

    @Test
    void managersWriteOnlyAtTheirAssignedBranchesButSeeEverything() {
        // The manager is assigned to RM01, not RM02.
        ok(receive(w.manager, entry(w.branchId, rice, "2", "kg")), 201);
        var refused = receive(w.manager, entry(secondBranchId, rice, "2", "kg"));
        assertThat(refused.status()).isEqualTo(403);
        assertThat(adjust(w.manager, adjustment(secondBranchId, rice, "IN", "1", "kg", "Recount")).status()).isEqualTo(403);
        assertThat(open(w.manager, entry(secondBranchId, soda, "1", "pc")).status()).isEqualTo(403);
        assertThat(onHand(secondBranchId, rice)).isNull();
        // The owner records at any active branch.
        ok(receive(w.owner, entry(secondBranchId, rice, "2", "kg")), 201);
        assertThat(w.manager.get(base() + "/balances").json().path("items").size()).isEqualTo(2);
        var options = w.manager.get(base() + "/options").json().path("branches");
        boolean sawFirst = false;
        for (JsonNode option : options) {
            if ("RM01".equals(option.path("code").asString())) {
                assertThat(option.path("writable").asBoolean()).isTrue();
                sawFirst = true;
            }
            if ("RM02".equals(option.path("code").asString())) {
                assertThat(option.path("writable").asBoolean()).isFalse();
            }
            if ("OLD1".equals(option.path("code").asString())) {
                assertThat(option.path("status").asString()).isEqualTo("INACTIVE");
                assertThat(option.path("writable").asBoolean()).isFalse();
            }
        }
        assertThat(sawFirst).isTrue();
    }

    @Test
    void anonymousCallersAreRejected() {
        assertThat(new TestApi(mvc).get(base() + "/balances").status()).isEqualTo(401);
        assertThat(new TestApi(mvc).post(base() + "/receive", entry(w.branchId, rice, "1", "kg")).status()).isIn(401, 403);
    }

    @Test
    void anotherBusinessCannotReadOrChangeInventoryAndIdsDoNotCrossBusinesses() {
        ok(open(w.owner, entry(w.branchId, rice, "5", "kg")), 201);
        for (String path : List.of("/balances", "/movements", "/options")) {
            assertThat(w.cafeOwner.get(base() + path).status()).as(path).isEqualTo(404);
        }
        assertThat(receive(w.cafeOwner, entry(w.branchId, rice, "1", "kg")).status()).isEqualTo(404);
        // Through the cafe's own URL, the shop's branch and item ids are simply unknown.
        String cafeBase = "/api/v1/merchants/" + w.cafeMerchantId + "/inventory";
        var viaCafe = w.cafeOwner.post(cafeBase + "/receive", entry(w.branchId, rice, "1", "kg"));
        assertThat(viaCafe.status()).isEqualTo(404);
        var cafeItem = w.cafeOwner.post("/api/v1/merchants/" + w.cafeMerchantId + "/catalog/items", goods("Coffee", "COF", "MASS", "kg")).json();
        var shopBranchCafeItem = w.cafeOwner.post(cafeBase + "/receive", entry(w.branchId, cafeItem, "1", "kg"));
        assertThat(shopBranchCafeItem.status()).isEqualTo(404);
        var cafeBranchShopItem = w.cafeOwner.post(cafeBase + "/receive", entry(w.cafeBranchId, rice, "1", "kg"));
        assertThat(cafeBranchShopItem.status()).isEqualTo(404);
        assertThat(w.cafeOwner.get(cafeBase + "/balances").json().path("items").size()).isZero();
        assertThat(count("stock_movements")).isEqualTo(1);
        assertThat(onHand(w.branchId, rice).toPlainString()).isEqualTo("5000.000000");
    }

    @Test
    void inventoryExistsOnlyForBusinessModeMerchants() {
        ok(open(w.owner, entry(w.branchId, rice, "5", "kg")), 201);
        setMode(w.merchantId, "SIMPLIFIED");
        for (var response : List.of(w.owner.get(base() + "/balances"), w.owner.get(base() + "/movements"), w.owner.get(base() + "/options"),
                receive(w.owner, entry(w.branchId, rice, "1", "kg")), open(w.owner, entry(w.branchId, soda, "1", "pc")),
                adjust(w.owner, adjustment(w.branchId, rice, "IN", "1", "kg", "Count")), w.cashier.get(base() + "/balances"))) {
            assertThat(response.status()).as(response.body()).isEqualTo(409);
            assertThat(response.code()).isEqualTo("inventory_unavailable");
        }
        assertThat(count("stock_movements")).isEqualTo(1);
        setMode(w.merchantId, "BUSINESS");
        assertThat(w.owner.get(base() + "/balances").status()).isEqualTo(200);
    }

    @Test
    void stockIsRecordedOnlyAtActiveBranchesButAReplayStillWorks() {
        var inactive = receive(w.owner, entry(w.inactiveBranchId, rice, "1", "kg"));
        assertThat(inactive.status()).isEqualTo(409);
        assertThat(inactive.code()).isEqualTo("branch_inactive");
        assertThat(count("inventory_balances")).isZero();

        Map<String, Object> body = entry(w.branchId, rice, "4", "kg");
        ok(receive(w.owner, body), 201);
        jdbc.update("update branches set status = 'INACTIVE' where id = ?", w.branchId);
        assertThat(receive(w.owner, entry(w.branchId, rice, "1", "kg")).code()).isEqualTo("branch_inactive");
        assertThat(receive(w.owner, body).status()).isEqualTo(200);
        // History and balances of an inactive branch stay readable.
        assertThat(w.owner.get(base() + "/balances?branchId=" + w.branchId).json().path("items").size()).isEqualTo(1);
        assertThat(w.owner.get(base() + "/movements?branchId=" + w.branchId).json().path("items").size()).isEqualTo(1);
        assertThat(receive(w.owner, entry(UUID.randomUUID(), rice, "1", "kg")).status()).isEqualTo(404);
        JsonNode unknownItem = TestApi.json().readTree("{\"id\":\"" + UUID.randomUUID() + "\"}");
        assertThat(receive(w.owner, entry(w.branchId, unknownItem, "1", "kg")).status()).isEqualTo(404);
    }

    // --- history ----------------------------------------------------------------------------------------

    @Test
    void movementHistoryIsPagedDeterministicallyAndFiltered() {
        ok(open(w.owner, entry(w.branchId, rice, "10", "kg")), 201);
        for (int i = 1; i <= 4; i++) {
            ok(receive(w.owner, entry(w.branchId, rice, String.valueOf(i), "kg")), 201);
        }
        ok(adjust(w.owner, adjustment(w.branchId, rice, "OUT", "1", "kg", "Loss")), 201);
        ok(receive(w.owner, entry(secondBranchId, soda, "6", "pc")), 201);

        var first = w.owner.get(base() + "/movements?limit=3").json();
        assertThat(first.path("items").size()).isEqualTo(3);
        String cursor = first.path("nextCursor").asString();
        assertThat(cursor).isNotEmpty();
        List<String> seen = new ArrayList<>();
        List<java.time.Instant> times = new ArrayList<>();
        first.path("items").forEach(m -> {
            seen.add(m.path("id").asString());
            times.add(java.time.Instant.parse(m.path("createdAt").asString()));
        });
        while (!cursor.isEmpty()) {
            var next = w.owner.get(base() + "/movements?limit=3&cursor=" + cursor).json();
            next.path("items").forEach(m -> {
                seen.add(m.path("id").asString());
                times.add(java.time.Instant.parse(m.path("createdAt").asString()));
            });
            cursor = isAbsent(next.path("nextCursor")) ? "" : next.path("nextCursor").asString();
        }
        assertThat(seen).hasSize(7).doesNotHaveDuplicates();
        // Across different balances rows created in one clock tick are ordered by id, so creation times just never increase down the list.
        for (int i = 1; i < times.size(); i++) {
            assertThat(times.get(i).isAfter(times.get(i - 1))).isFalse();
        }
        // Within ONE balance the order is exactly the order the balance changed in, whatever the clock does: the running balance reads 19, 20, 16, 13, 11, 10.
        var chain = w.owner.get(base() + "/movements?itemId=" + rice.path("id").asString() + "&branchId=" + w.branchId).json().path("items");
        List<String> running = new ArrayList<>();
        chain.forEach(m -> running.add(m.path("balanceAfter").asString()));
        assertThat(running).containsExactly("19000", "20000", "16000", "13000", "11000", "10000");

        assertThat(w.owner.get(base() + "/movements?type=ADJUST_OUT").json().path("items").size()).isEqualTo(1);
        assertThat(w.owner.get(base() + "/movements?type=RECEIVE").json().path("items").size()).isEqualTo(5);
        assertThat(w.owner.get(base() + "/movements?branchId=" + secondBranchId).json().path("items").size()).isEqualTo(1);
        assertThat(w.owner.get(base() + "/movements?itemId=" + rice.path("id").asString() + "&branchId=" + w.branchId).json().path("items").size())
                .isEqualTo(6);
        assertThat(w.owner.get(base() + "/movements?cursor=garbage").status()).isEqualTo(400);
        assertThat(w.owner.get(base() + "/movements?type=SALE").status()).isEqualTo(400);
    }

    @Test
    void balancesArePagedDeterministically() {
        for (int i = 0; i < 5; i++) {
            JsonNode item = catalogItem(goods("Item " + i, "IT" + i, "COUNT", "pc"));
            ok(open(w.owner, entry(w.branchId, item, "1", "pc")), 201);
        }
        List<String> seen = new ArrayList<>();
        String cursor = "";
        for (int guard = 0; guard < 10; guard++) {
            var page = w.owner.get(base() + "/balances?limit=2" + (cursor.isEmpty() ? "" : "&cursor=" + cursor)).json();
            page.path("items").forEach(b -> seen.add(b.path("id").asString()));
            if (isAbsent(page.path("nextCursor"))) {
                break;
            }
            cursor = page.path("nextCursor").asString();
        }
        assertThat(seen).hasSize(5).doesNotHaveDuplicates();
        assertThat(w.owner.get(base() + "/balances?cursor=garbage").status()).isEqualTo(400);
    }

    @Test
    void historyCannotBeChangedOrDeletedThroughTheApi() {
        ok(open(w.owner, entry(w.branchId, rice, "5", "kg")), 201);
        String movement = w.owner.get(base() + "/movements").json().path("items").get(0).path("id").asString();
        for (var response : List.of(w.owner.delete(base() + "/movements/" + movement), w.owner.put(base() + "/movements/" + movement, Map.of("reason", "x")),
                w.owner.delete(base() + "/balances"))) {
            assertThat(response.status()).isIn(404, 405);
        }
        assertThat(count("stock_movements")).isEqualTo(1);
    }

    @Test
    void auditsEveryWrite() {
        ok(open(w.owner, entry(w.branchId, rice, "5", "kg")), 201);
        ok(receive(w.owner, entry(w.branchId, rice, "1", "kg")), 201);
        ok(adjust(w.owner, adjustment(w.branchId, rice, "OUT", "1", "kg", "Spilled")), 201);
        ok(adjust(w.owner, adjustment(w.branchId, rice, "IN", "1", "kg", "Recount")), 201);
        assertThat(auditCount("INVENTORY_STOCK_OPENED")).isEqualTo(1);
        assertThat(auditCount("INVENTORY_STOCK_RECEIVED")).isEqualTo(1);
        assertThat(auditCount("INVENTORY_STOCK_ADJUSTED")).isEqualTo(2);
        String message = jdbc.queryForObject("select message from audit_log where kind = 'INVENTORY_STOCK_ADJUSTED' order by id limit 1", String.class);
        assertThat(message).contains("Adjusted out").contains("1000 g").contains("Rice").contains("RM01").contains("Spilled");
        assertThat(jdbc.queryForObject("select actor_user_id from audit_log where kind = 'INVENTORY_STOCK_OPENED'", UUID.class))
                .isEqualTo(w.ownerPerson.userId());
        // Refused operations leave no audit entry.
        long audits = count("audit_log");
        receive(w.cashier, entry(w.branchId, rice, "1", "kg"));
        adjust(w.owner, adjustment(w.branchId, rice, "OUT", "999", "kg", "Too much"));
        assertThat(count("audit_log")).isEqualTo(audits);
    }

    // --- R5c corrections: accounting integrity, zero opening, privacy, inactive products ---------------------

    @Test
    void twoSimultaneousFirstReceiptsWithDifferentOperationIdsAreBothAccountedOnce() throws Exception {
        List<Callable<TestApi.Response>> tasks = List.of(
                () -> receive(w.owner, entry(w.branchId, rice, "3", "kg")),
                () -> receive(w.manager, entry(w.branchId, rice, "4.7", "kg")));
        List<TestApi.Response> results = runTogether(tasks);
        assertThat(results.get(0).status()).as(results.get(0).body()).isEqualTo(201);
        assertThat(results.get(1).status()).as(results.get(1).body()).isEqualTo(201);
        assertThat(count("inventory_balances")).isEqualTo(1);
        assertThat(count("stock_movements")).isEqualTo(2);
        assertThat(onHand(w.branchId, rice).toPlainString()).isEqualTo("7700.000000");
        assertThat(jdbc.queryForObject("select sum(quantity_delta) from stock_movements", BigDecimal.class).compareTo(onHand(w.branchId, rice)))
                .isZero();
        // The movements form a chain: each starts where the previous one ended.
        var rows = jdbc.queryForList("select balance_after - quantity_delta as before_qty, balance_after from stock_movements order by balance_after");
        assertThat(((BigDecimal) rows.get(0).get("before_qty")).signum()).isZero();
        assertThat(((BigDecimal) rows.get(1).get("before_qty")).compareTo((BigDecimal) rows.get(0).get("balance_after"))).isZero();
        assertBalancesMatchHistory();
    }

    @Test
    void competingRemovalsOfDifferentSizesNeverExceedTheStock() throws Exception {
        ok(open(w.owner, entry(w.branchId, rice, "5", "kg")), 201);
        List<Callable<TestApi.Response>> tasks = new ArrayList<>();
        for (String amount : List.of("3", "3", "2", "2.5", "1")) {
            Map<String, Object> body = adjustment(w.branchId, rice, "OUT", amount, "kg", "Competing " + amount);
            tasks.add(() -> adjust(w.owner, body));
        }
        List<TestApi.Response> results = runTogether(tasks);
        BigDecimal removed = BigDecimal.ZERO;
        for (TestApi.Response response : results) {
            if (response.status() == 201) {
                removed = removed.add(new BigDecimal(response.json().path("movement").path("quantityDelta").asString()).negate());
            } else {
                assertThat(response.status()).as(response.body()).isEqualTo(409);
                assertThat(response.code()).isEqualTo("insufficient_stock");
            }
        }
        assertThat(removed.compareTo(new BigDecimal("5000")) <= 0).isTrue();
        assertThat(onHand(w.branchId, rice).compareTo(new BigDecimal("5000").subtract(removed))).isZero();
        assertThat(onHand(w.branchId, rice).signum() >= 0).isTrue();
        assertBalancesMatchHistory();
    }

    @Test
    void aFailedOperationDoesNotReserveItsOperationId() {
        Map<String, Object> removal = adjustment(w.branchId, rice, "OUT", "5", "kg", "Count difference");
        assertThat(adjust(w.owner, removal).code()).isEqualTo("insufficient_stock");
        assertThat(count("stock_movements")).isZero();
        // The id is free again: the same operation succeeds once the stock exists.
        ok(receive(w.owner, entry(w.branchId, rice, "10", "kg")), 201);
        ok(adjust(w.owner, removal), 201);
        assertThat(onHand(w.branchId, rice).toPlainString()).isEqualTo("5000.000000");
        assertThat(adjust(w.owner, removal).status()).isEqualTo(200);
        // A rejected conversion does not burn the id either.
        Map<String, Object> bad = entry(w.branchId, rice, "0.0000000001", "kg");
        assertThat(receive(w.owner, bad).code()).isEqualTo("precision_exceeded");
        bad.put("amount", "1");
        ok(receive(w.owner, bad), 201);
        assertBalancesMatchHistory();
    }

    @Test
    void zeroOpeningStockIsRefusedWithAClearMessage() {
        for (String zero : List.of("0", "0.000000", "0.0")) {
            var response = open(w.owner, entry(w.branchId, rice, zero, "kg"));
            assertThat(response.status()).isEqualTo(422);
            assertThat(response.code()).isEqualTo("quantity_out_of_range");
            assertThat(response.json().path("message").asString()).contains("Opening stock must be greater than zero");
        }
        assertThat(count("stock_movements")).isZero();
        assertThat(count("inventory_balances")).isZero();
        // So a refused zero never blocks the real opening afterwards.
        ok(open(w.owner, entry(w.branchId, rice, "1", "kg")), 201);
    }

    @Test
    void anIdenticalOpeningReplayIsSafeButAnotherOpeningIsRefused() {
        Map<String, Object> opening = entry(w.branchId, rice, "5", "kg");
        ok(open(w.owner, opening), 201);
        var replay = ok(open(w.owner, opening), 200);
        assertThat(replay.path("replayed").asBoolean()).isTrue();
        assertThat(open(w.owner, entry(w.branchId, rice, "5", "kg")).code()).isEqualTo("opening_already_recorded");
        assertThat(onHand(w.branchId, rice).toPlainString()).isEqualTo("5000.000000");
        assertThat(count("stock_movements")).isEqualTo(1);
    }

    @Test
    void anotherActorCannotReadAMovementThroughItsOperationId() {
        Map<String, Object> body = entry(w.branchId, rice, "10", "kg");
        ok(receive(w.owner, body), 201);
        // A cashier is refused before anything is looked up.
        var cashier = receive(w.cashier, body);
        assertThat(cashier.status()).isEqualTo(403);
        assertThat(cashier.body()).doesNotContain("movement").doesNotContain("balance").doesNotContain(body.get("clientOperationId").toString());
        // An assigned manager with the same id gets a bare conflict: no movement, no balance, no quantity.
        var manager = receive(w.manager, body);
        assertThat(manager.status()).isEqualTo(409);
        assertThat(manager.code()).isEqualTo("operation_id_reuse");
        assertThat(isAbsent(manager.json().path("movement"))).isTrue();
        assertThat(isAbsent(manager.json().path("balance"))).isTrue();
        assertThat(manager.body()).doesNotContain("10000");
        // A manager outside the branch is refused before the lookup too.
        Map<String, Object> elsewhere = new HashMap<>(body);
        elsewhere.put("branchId", secondBranchId.toString());
        assertThat(receive(w.manager, elsewhere).status()).isEqualTo(403);
        // Another business never sees it either.
        assertThat(w.cafeOwner.post("/api/v1/merchants/" + w.cafeMerchantId + "/inventory/receive", body).status()).isEqualTo(404);
    }

    @Test
    void foreignBranchAndItemIdsNeverLeakDataOrBypassIsolation() {
        ok(open(w.owner, entry(w.branchId, rice, "5", "kg")), 201);
        String cafeBase = "/api/v1/merchants/" + w.cafeMerchantId + "/inventory";
        // Filtering the cafe's lists by the shop's ids finds nothing (and reveals nothing).
        assertThat(w.cafeOwner.get(cafeBase + "/balances?branchId=" + w.branchId).json().path("items").size()).isZero();
        assertThat(w.cafeOwner.get(cafeBase + "/movements?branchId=" + w.branchId + "&itemId=" + rice.path("id").asString()).json().path("items").size())
                .isZero();
        // And the shop's lists filtered by the cafe's branch find nothing of the cafe's.
        assertThat(w.owner.get(base() + "/balances?branchId=" + w.cafeBranchId).json().path("items").size()).isZero();
        assertThat(w.owner.get(base() + "/movements?branchId=" + w.cafeBranchId).json().path("items").size()).isZero();
        for (UUID bogus : List.of(w.cafeBranchId, UUID.randomUUID())) {
            assertThat(receive(w.owner, entry(bogus, rice, "1", "kg")).status()).isEqualTo(404);
            assertThat(open(w.owner, entry(bogus, rice, "1", "kg")).status()).isEqualTo(404);
            assertThat(adjust(w.owner, adjustment(bogus, rice, "IN", "1", "kg", "Why")).status()).isEqualTo(404);
        }
        assertThat(count("stock_movements")).isEqualTo(1);
    }

    @Test
    void cashiersAndManagersSeeAndWriteOnlyAssignedActiveBranches() {
        ok(open(w.owner, entry(w.branchId, rice, "5", "kg")), 201);
        assertThat(w.cashier.get(base() + "/balances").json().path("items").size()).isEqualTo(1);
        assertThat(w.cashier.get(base() + "/options").json().path("branches").size()).isEqualTo(1);
        jdbc.update("update branches set status = 'INACTIVE' where id = ?", w.branchId);
        // The assigned branch is no longer active: the cashier sees nothing of it, and the manager can no longer write there.
        assertThat(w.cashier.get(base() + "/balances").json().path("items").size()).isZero();
        assertThat(w.cashier.get(base() + "/movements").json().path("items").size()).isZero();
        assertThat(w.cashier.get(base() + "/options").json().path("branches").size()).isZero();
        assertThat(receive(w.manager, entry(w.branchId, rice, "1", "kg")).status()).isEqualTo(403);
        // The owner still reads the history of an inactive branch.
        assertThat(w.owner.get(base() + "/balances?branchId=" + w.branchId).json().path("items").size()).isEqualTo(1);
        assertThat(onHand(w.branchId, rice).toPlainString()).isEqualTo("5000.000000");
    }

    @Test
    void inactiveGoodsKeepTheirStockAndAreNeverSilentlyReactivated() {
        ok(open(w.owner, entry(w.branchId, rice, "5", "kg")), 201);
        var off = w.owner.put("/api/v1/merchants/" + w.merchantId + "/catalog/items/" + rice.path("id").asString() + "/status",
                Map.of("expectedVersion", rice.path("version").asLong(), "active", false));
        assertThat(off.status()).isEqualTo(200);
        long catalogVersion = off.json().path("version").asLong();
        // Authorised stock operations on an inactive product are allowed: the physical stock is real.
        ok(receive(w.owner, entry(w.branchId, rice, "1", "kg")), 201);
        ok(adjust(w.manager, adjustment(w.branchId, rice, "OUT", "0.5", "kg", "Clearance")), 201);
        ok(open(w.owner, entry(secondBranchId, rice, "2", "kg")), 201);
        assertThat(onHand(w.branchId, rice).toPlainString()).isEqualTo("5500.000000");
        // None of it touched the catalog: still inactive, same version, same price history.
        var item = w.owner.get("/api/v1/merchants/" + w.merchantId + "/catalog/items/" + rice.path("id").asString()).json();
        assertThat(item.path("active").asBoolean()).isFalse();
        assertThat(item.path("version").asLong()).isEqualTo(catalogVersion);
        assertThat(item.path("priceVersion").asInt()).isEqualTo(1);
        // History survives the deactivation and stays readable.
        assertThat(w.owner.get(base() + "/movements?itemId=" + rice.path("id").asString()).json().path("items").size()).isEqualTo(4);
        assertThat(w.owner.get(base() + "/balances?itemId=" + rice.path("id").asString()).json().path("items").size()).isEqualTo(2);
    }

    @Test
    void numericComparisonIgnoresDecimalScale() {
        ok(receive(w.owner, entry(w.branchId, rice, "0.5", "g")), 201);
        // 0.500000 g and 0.5 g are the same quantity: removing it leaves exactly zero, and one millionth more is too much.
        assertThat(adjust(w.owner, adjustment(w.branchId, rice, "OUT", "0.500001", "g", "Too much")).code()).isEqualTo("insufficient_stock");
        var all = ok(adjust(w.owner, adjustment(w.branchId, rice, "OUT", "0.500000", "g", "All of it")), 201);
        assertThat(all.path("balance").path("quantityOnHand").asString()).isEqualTo("0");
        assertThat(onHand(w.branchId, rice).signum()).isZero();
        // 1 kg written as 1000 g, as 1.000 kg and as 1 kg all add the same exact amount.
        ok(receive(w.owner, entry(w.branchId, rice, "1000", "g")), 201);
        ok(receive(w.owner, entry(w.branchId, rice, "1.000", "kg")), 201);
        ok(receive(w.owner, entry(w.branchId, rice, "1", "kg")), 201);
        assertThat(onHand(w.branchId, rice).toPlainString()).isEqualTo("3000.000000");
        assertBalancesMatchHistory();
    }

    @Test
    void stockCannotBeChangedByAnythingButAMovementEvenThroughTheApplicationsOwnDatabaseUser() {
        ok(open(w.owner, entry(w.branchId, rice, "5", "kg")), 201);
        assertThat(org.assertj.core.api.Assertions.catchThrowable(() -> jdbc.update("update inventory_balances set quantity_on_hand = 999")))
                .isNotNull();
        assertThat(org.assertj.core.api.Assertions.catchThrowable(() -> jdbc.update("update stock_movements set quantity_delta = 999")))
                .isNotNull();
        assertThat(onHand(w.branchId, rice).toPlainString()).isEqualTo("5000.000000");
        assertBalancesMatchHistory();
    }

    @Test
    void aFailureWhileRecordingTheAuditEntryRollsBackTheWholeOperation() {
        ok(open(w.owner, entry(w.branchId, rice, "5", "kg")), 201);
        Map<String, Object> body = entry(w.branchId, rice, "1", "kg");
        // Make the audit insert for a receipt fail, as a stand-in for any failure after the movement was written.
        jdbc.execute("create function fail_stock_audit() returns trigger as $$ begin raise exception 'audit refused'; end; $$ language plpgsql");
        jdbc.execute("create trigger trg_fail_stock_audit before insert on audit_log for each row "
                + "when (new.kind = 'INVENTORY_STOCK_RECEIVED') execute function fail_stock_audit()");
        try {
            var response = receive(w.owner, body);
            assertThat(response.status()).as(response.body()).isGreaterThanOrEqualTo(400);
            // Neither the movement nor the balance change survived, and nothing says the stock arrived.
            assertThat(count("stock_movements")).isEqualTo(1);
            assertThat(onHand(w.branchId, rice).toPlainString()).isEqualTo("5000.000000");
            assertThat(auditCount("INVENTORY_STOCK_RECEIVED")).isZero();
            assertBalancesMatchHistory();
        } finally {
            jdbc.execute("drop trigger trg_fail_stock_audit on audit_log");
            jdbc.execute("drop function fail_stock_audit()");
        }
        // The failed operation did not reserve its id: the same request succeeds once the audit trail is healthy.
        ok(receive(w.owner, body), 201);
        assertThat(onHand(w.branchId, rice).toPlainString()).isEqualTo("6000.000000");
        assertThat(auditCount("INVENTORY_STOCK_RECEIVED")).isEqualTo(1);
        assertBalancesMatchHistory();
    }

    @Test
    void theCatalogAndInventoryDoNotInterfere() {
        // Repricing an item never touches stock.
        ok(open(w.owner, entry(w.branchId, rice, "5", "kg")), 201);
        var updated = w.owner.put("/api/v1/merchants/" + w.merchantId + "/catalog/items/" + rice.path("id").asString(),
                Map.of("expectedVersion", rice.path("version").asLong(), "name", "Rice", "code", "RICE", "saleUnit", "g", "pricePerSaleUnitRwf", 2));
        assertThat(updated.status()).as(updated.body()).isEqualTo(200);
        assertThat(onHand(w.branchId, rice).toPlainString()).isEqualTo("5000.000000");
        // The sale unit changed, the stock unit did not: the display follows the sale unit, the quantity is still exact.
        var balance = w.owner.get(base() + "/balances").json().path("items").get(0);
        assertThat(balance.path("saleUnit").asString()).isEqualTo("g");
        assertThat(balance.path("quantityInSaleUnit").asString()).isEqualTo("5000");
        assertThat(balance.path("stockUnit").asString()).isEqualTo("g");
        assertThat(w.owner.get("/api/v1/merchants/" + w.merchantId + "/invoices").status()).isEqualTo(200);
    }
}
