package rw.oupay.checkout;

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
import org.springframework.http.HttpMethod;
import rw.oupay.support.TestApi;
import tools.jackson.databind.JsonNode;

/** Shared set-up for the R7b POS billing tests: a catalog with taxed goods and a service, stock at the shop's branch, and cashier codes. */
abstract class PosBillingTestSupport extends CodeCheckoutTestSupport {

    JsonNode rice;
    JsonNode soda;
    JsonNode repair;
    JsonNode liveCode;

    @BeforeEach
    void posWorld() {
        // Rice: RWF 1,500 per kg, 18% standard rated, 10 kg on hand. Soda: RWF 400 per piece, zero-rated, 100 pieces. Repair: RWF 5,000, exempt.
        rice = taxed(goods("Rice", "RICE-25", "MASS", "kg", 1_500), "STANDARD", 1_800);
        soda = taxed(goods("Soda", "SODA", "COUNT", "pc", 400), "ZERO_RATED", 0);
        repair = taxed(service("Phone repair", "FIX", 5_000), "EXEMPT", 0);
        stock(rice, "10", "kg");
        stock(soda, "100", "pc");
    }

    // ---- urls ----------------------------------------------------------------------------------

    String catalog() {
        return "/api/v1/merchants/" + w.merchantId + "/catalog";
    }

    String pos() {
        return "/api/v1/merchants/" + w.merchantId + "/pos";
    }

    // ---- catalog and stock ---------------------------------------------------------------------

    Map<String, Object> goods(String name, String code, String dimension, String saleUnit, long price) {
        Map<String, Object> body = new HashMap<>();
        body.put("itemType", "GOODS");
        body.put("name", name);
        body.put("code", code);
        body.put("measurementDimension", dimension);
        body.put("saleUnit", saleUnit);
        body.put("pricePerSaleUnitRwf", price);
        return body;
    }

    Map<String, Object> service(String name, String code, long price) {
        Map<String, Object> body = new HashMap<>();
        body.put("itemType", "SERVICE");
        body.put("name", name);
        body.put("code", code);
        body.put("pricePerSaleUnitRwf", price);
        return body;
    }

    JsonNode item(Map<String, Object> body) {
        var response = w.owner.post(catalog() + "/items", body);
        assertThat(response.status()).as(response.body()).isEqualTo(201);
        return response.json();
    }

    JsonNode freshItem(JsonNode item) {
        return w.owner.get(catalog() + "/items/" + item.path("id").asString()).json();
    }

    JsonNode taxed(Map<String, Object> body, String category, int rateBp) {
        return setTax(item(body), category, rateBp);
    }

    JsonNode setTax(JsonNode item, String category, int rateBp) {
        var response = w.owner.put(catalog() + "/items/" + item.path("id").asString() + "/tax",
                Map.of("expectedVersion", freshItem(item).path("version").asLong(), "taxCategory", category, "taxRateBp", rateBp));
        assertThat(response.status()).as(response.body()).isEqualTo(200);
        return freshItem(item);
    }

    JsonNode packageOf(JsonNode item, String label, String amount, String unit) {
        var response = w.owner.post(catalog() + "/items/" + item.path("id").asString() + "/packages", Map.of("label", label, "contentsAmount", amount, "contentsUnit", unit));
        assertThat(response.status()).as(response.body()).isEqualTo(201);
        return response.json();
    }

    void stock(JsonNode item, String amount, String unit) {
        var response = w.owner.post("/api/v1/merchants/" + w.merchantId + "/inventory/opening", Map.of("clientOperationId", UUID.randomUUID().toString(),
                "branchId", w.branchId.toString(), "itemId", item.path("id").asString(), "amount", amount, "unit", unit));
        assertThat(response.status()).as(response.body()).isEqualTo(201);
    }

    TestApi.Response adjustOut(JsonNode item, String amount, String unit) {
        return w.owner.post("/api/v1/merchants/" + w.merchantId + "/inventory/adjust", Map.of("clientOperationId", UUID.randomUUID().toString(),
                "branchId", w.branchId.toString(), "itemId", item.path("id").asString(), "direction", "OUT", "amount", amount, "unit", unit, "reason", "Damaged stock"));
    }

    BigDecimal onHand(JsonNode item) {
        return jdbc.queryForObject("select quantity_on_hand from inventory_balances where item_id = ?::uuid and branch_id = ?", BigDecimal.class, item.path("id").asString(),
                w.branchId);
    }

    BigDecimal reserved(JsonNode item) {
        return jdbc.queryForObject("select active_reserved_quantity(?, ?, ?::uuid)", BigDecimal.class, w.merchantId, w.branchId, item.path("id").asString());
    }

    // ---- codes ---------------------------------------------------------------------------------

    /** A real (non-simulated), bank-approved code held by the cashier: its sales are LIVE. */
    JsonNode live() {
        if (liveCode == null) {
            makeAccountReal();
            ensureProfile();
            liveCode = activeCode("Live", "EQ-LIVE-77");
            assertThat(assign(liveCode, cashierMembership).status()).isEqualTo(201);
        }
        return liveCode;
    }

    /** A simulated code held by the cashier: its sales are DEMONSTRATIONS. */
    JsonNode demo() {
        ensureProfile();
        JsonNode code = activeCode("Counter", "EQ-DEMO-1");
        assertThat(assign(code, cashierMembership).status()).isEqualTo(201);
        return code;
    }

    // ---- carts, drafts, billing ----------------------------------------------------------------

    Map<String, Object> line(JsonNode item, String quantity, String unit) {
        Map<String, Object> line = new HashMap<>();
        line.put("itemId", item.path("id").asString());
        line.put("quantity", quantity);
        line.put("unit", unit);
        line.put("expectedPriceVersion", freshItem(item).path("priceVersion").asInt());
        return line;
    }

    Map<String, Object> packageLine(JsonNode item, String count, JsonNode pack) {
        Map<String, Object> line = new HashMap<>();
        line.put("itemId", item.path("id").asString());
        line.put("quantity", count);
        line.put("packageId", pack.path("id").asString());
        line.put("expectedPriceVersion", freshItem(item).path("priceVersion").asInt());
        return line;
    }

    @SafeVarargs
    final JsonNode saveDraft(TestApi api, Map<String, Object>... lines) {
        Map<String, Object> body = new HashMap<>();
        body.put("clientRequestId", UUID.randomUUID().toString());
        body.put("branchId", w.branchId.toString());
        List<Map<String, Object>> list = new ArrayList<>();
        for (Map<String, Object> l : lines) {
            list.add(l);
        }
        body.put("lines", list);
        var response = api.send(HttpMethod.POST, pos() + "/drafts", body, Map.of("Idempotency-Key", "draft-" + UUID.randomUUID()));
        assertThat(response.status()).as(response.body()).isEqualTo(201);
        return response.json();
    }

    @SafeVarargs
    final JsonNode saveDraft(Map<String, Object>... lines) {
        return saveDraft(w.cashier, lines);
    }

    TestApi.Response review(TestApi api, JsonNode draft) {
        return api.get(pos() + "/drafts/" + draft.path("id").asString() + "/billing-review");
    }

    TestApi.Response bill(TestApi api, String key, JsonNode draft, long reviewedTotal) {
        Map<String, Object> body = new HashMap<>();
        body.put("expectedDraftVersion", draft.path("version").asLong());
        body.put("reviewedTotalRwf", reviewedTotal);
        return api.send(HttpMethod.POST, pos() + "/drafts/" + draft.path("id").asString() + "/bill", body, Map.of("Idempotency-Key", key));
    }

    /** Reviews the draft as the cashier and bills exactly what was reviewed. */
    TestApi.Response reviewAndBill(TestApi api, JsonNode draft) {
        var review = review(api, draft);
        assertThat(review.status()).as(review.body()).isEqualTo(200);
        return bill(api, "bill-" + UUID.randomUUID(), draft, review.json().path("totalRwf").asLong());
    }

    JsonNode billed(JsonNode draft) {
        var response = reviewAndBill(w.cashier, draft);
        assertThat(response.status()).as(response.body()).isEqualTo(201);
        return response.json();
    }

    JsonNode draftNow(JsonNode draft) {
        return w.cashier.get(pos() + "/drafts/" + draft.path("id").asString()).json();
    }

    String reference(JsonNode sale) {
        return sale.path("sale").path("saleReference").asString();
    }

    // ---- counting and concurrency --------------------------------------------------------------

    /** The rows a bill writes, counted together: all zero or all present, never in between. */
    Map<String, Long> billRows() {
        Map<String, Long> rows = new HashMap<>();
        for (String table : List.of("invoices", "invoice_items", "payment_requests", "code_sales", "pos_sales", "pos_sale_lines", "stock_reservations", "stock_reservation_lines",
                "stock_movements")) {
            rows.put(table, (long) count(table));
        }
        return rows;
    }

    <T> List<T> concurrently(List<Callable<T>> tasks) throws Exception {
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
                results.add(future.get(90, TimeUnit.SECONDS));
            }
            return results;
        } finally {
            pool.shutdownNow();
        }
    }
}
