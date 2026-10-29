package rw.oupay.checkout;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Callable;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpMethod;
import org.springframework.test.context.TestPropertySource;
import rw.oupay.support.TestApi;
import tools.jackson.databind.JsonNode;

/**
 * R7b: billing a POS draft is ONE atomic operation: an issued CODE invoice with immutable catalog and tax snapshots, a fixed-amount payment
 * request through the cashier's code, and a branch-scoped stock RESERVATION (never a deduction, never a sale movement).
 */
@TestPropertySource(properties = {
        "oupay.collection-codes.approval-enabled=true",
        "oupay.code-checkout.live-enabled=true",
        "oupay.code-checkout.instructions=Open the bank app|Pay to the merchant code shown",
        "oupay.pos.approved-tax-treatments=EXEMPT:0,ZERO_RATED:0,STANDARD:1800,NOT_APPLICABLE:0",
        "oupay.pos.reservation-review-grace=PT0S"})
class PosBillingIT extends PosBillingTestSupport {

    // ---- the happy path ------------------------------------------------------------------------------------------------

    @Test
    void aMixedCartOfGoodsAndServicesIsBilledAtomicallyAndTheGoodsAreReservedNotSold() {
        live();
        JsonNode draft = saveDraft(line(rice, "2", "kg"), line(repair, "1", "pc"));
        var review = review(w.cashier, draft);
        assertThat(review.status()).as(review.body()).isEqualTo(200);
        JsonNode r = review.json();
        assertThat(r.path("billable").asBoolean()).as(review.body()).isTrue();
        assertThat(r.path("mode").asString()).isEqualTo("LIVE");
        // Rice 2 kg x 1,500 = 3,000 + 18% = 540; repair 5,000 exempt.
        assertThat(r.path("subtotalRwf").asLong()).isEqualTo(8_000);
        assertThat(r.path("taxRwf").asLong()).isEqualTo(540);
        assertThat(r.path("totalRwf").asLong()).isEqualTo(8_540);
        assertThat(r.path("lines").get(0).path("taxCategory").asString()).isEqualTo("STANDARD");
        assertThat(r.path("lines").get(0).path("taxRateBp").asInt()).isEqualTo(1_800);
        assertThat(r.path("lines").get(0).path("availability").path("state").asString()).isEqualTo("SUFFICIENT");
        assertThat(r.path("lines").get(1).path("availability").path("state").asString()).isEqualTo("NOT_TRACKED");
        assertThat(r.path("taxNote").asString()).contains("Provisional");
        Map<String, Long> before = billRows();
        BigDecimal physicalBefore = onHand(rice);

        var response = bill(w.cashier, "bill-key-0001", draft, 8_540);
        assertThat(response.status()).as(response.body()).isEqualTo(201);
        JsonNode sale = response.json();
        assertThat(sale.path("mode").asString()).isEqualTo("LIVE");
        assertThat(reference(sale)).startsWith("OP-");
        assertThat(sale.path("sale").path("amountRwf").asLong()).isEqualTo(8_540);
        assertThat(sale.path("sale").path("status").asString()).isEqualTo("CREATED");
        assertThat(sale.path("sale").path("code").path("mode").asString()).isEqualTo("LIVE");
        assertThat(sale.path("sale").path("code").path("bankCode").asString()).isEqualTo("EQ-LIVE-77");
        assertThat(sale.path("reservation").path("state").asString()).isEqualTo("RESERVED");
        assertThat(sale.path("reservation").path("lines").size()).isEqualTo(1);
        assertThat(sale.path("reservation").path("lines").get(0).path("quantity").asString()).isEqualTo("2000");
        assertThat(sale.path("reservation").path("note").asString()).contains("RESERVED").contains("not sold");
        assertThat(sale.path("lines").size()).isEqualTo(2);

        // One invoice, issued, channel CODE, with the tax it was reviewed at; one fixed-amount payment request through the code.
        UUID invoiceId = UUID.fromString(sale.path("sale").path("invoiceId").asString());
        var invoice = w.owner.get("/api/v1/merchants/" + w.merchantId + "/invoices/" + invoiceId).json();
        assertThat(invoice.path("status").asString()).isEqualTo("ISSUED");
        assertThat(invoice.path("saleChannel").asString()).isEqualTo("CODE");
        assertThat(invoice.path("grandTotal").asLong()).isEqualTo(8_540);
        assertThat(invoice.path("taxTotal").asLong()).isEqualTo(540);
        assertThat(invoice.path("items").size()).isEqualTo(2);
        assertThat(invoice.path("paymentStatus").asString()).isEqualTo("UNPAID");
        var request = jdbc.queryForMap("select source, requested_amount_rwf from payment_requests where invoice_id = ?", invoiceId);
        assertThat(request.get("source")).isEqualTo("CODE");
        assertThat(((Number) request.get("requested_amount_rwf")).longValue()).isEqualTo(8_540);

        // The sale is linked to its code sale (the code, the assignment and the agent as they were) and to the draft, which is now BILLED.
        var codeSale = jdbc.queryForMap("select * from code_sales where invoice_id = ?", invoiceId);
        assertThat(codeSale.get("presentation_mode")).isEqualTo("LIVE");
        assertThat(codeSale.get("agent_user_id")).isEqualTo(w.cashierPerson.userId());
        assertThat(codeSale.get("collection_code_id").toString()).isEqualTo(id(live()));
        assertThat(codeSale.get("assignment_id")).isNotNull();
        var posSale = jdbc.queryForMap("select * from pos_sales where invoice_id = ?", invoiceId);
        assertThat(posSale.get("draft_id").toString()).isEqualTo(draft.path("id").asString());
        assertThat(posSale.get("payment_request_id")).isEqualTo(codeSale.get("payment_request_id"));
        assertThat(((Number) posSale.get("total_rwf")).longValue()).isEqualTo(8_540);
        assertThat(draftNow(draft).path("status").asString()).isEqualTo("BILLED");

        // The reservation: ACTIVE, canonical and exact, for the goods only; physical stock and the movement ledger are untouched.
        var reservation = jdbc.queryForMap("select * from stock_reservations where invoice_id = ?", invoiceId);
        assertThat(reservation.get("status")).isEqualTo("ACTIVE");
        assertThat(reservation.get("branch_id")).isEqualTo(w.branchId);
        assertThat(reserved(rice)).isEqualByComparingTo("2000");
        assertThat(reserved(repair)).isEqualByComparingTo("0");
        assertThat(onHand(rice)).isEqualByComparingTo(physicalBefore);
        Map<String, Long> after = billRows();
        assertThat(after.get("stock_movements")).isEqualTo(before.get("stock_movements"));
        assertThat(after.get("invoices")).isEqualTo(before.get("invoices") + 1);
        assertThat(after.get("payment_requests")).isEqualTo(before.get("payment_requests") + 1);
        assertThat(after.get("stock_reservations")).isEqualTo(before.get("stock_reservations") + 1);
        assertThat(after.get("stock_reservation_lines")).isEqualTo(before.get("stock_reservation_lines") + 1);
        assertThat(after.get("pos_sale_lines")).isEqualTo(before.get("pos_sale_lines") + 2);
        assertThat(jdbc.queryForObject("select count(*) from audit_log where kind = 'POS_SALE_BILLED'", Integer.class)).isEqualTo(1);

        // A billed draft is final.
        var edit = w.cashier.put(pos() + "/drafts/" + draft.path("id").asString(), Map.of("expectedVersion", draftNow(draft).path("version").asLong(),
                "lines", List.of(line(rice, "1", "kg"))));
        assertThat(edit.status()).isEqualTo(409);
        assertThat(edit.code()).isEqualTo("draft_not_open");
        // The sale can be fetched again by the cashier and shows no "paid".
        var again = w.cashier.get(pos() + "/sales/" + sale.path("sale").path("saleId").asString());
        assertThat(again.status()).isEqualTo(200);
        assertThat(again.json().path("sale").path("status").asString()).isEqualTo("CREATED");
    }

    @Test
    void exactQuantitiesPackagesAndUnitsAreReservedInCanonicalUnitsAndKeepWhatWasEntered() {
        live();
        JsonNode bag = packageOf(rice, "Bag", "5", "kg");
        JsonNode draft = saveDraft(line(rice, "500", "g"), packageLine(rice, "1", bag), line(soda, "7", "pc"));
        JsonNode sale = billed(draft);
        // 500 g + one 5 kg bag of rice = 5.5 kg reserved, in grams, exactly; 7 sodas.
        assertThat(reserved(rice)).isEqualByComparingTo("5500");
        assertThat(reserved(soda)).isEqualByComparingTo("7");
        List<Map<String, Object>> lines = jdbc.queryForList("select * from stock_reservation_lines order by quantity");
        assertThat(lines).hasSize(3);
        Map<String, Object> grams = lines.stream().filter(l -> "g".equals(l.get("entered_unit"))).findFirst().orElseThrow();
        assertThat((BigDecimal) grams.get("quantity")).isEqualByComparingTo("500");
        assertThat(grams.get("entered_quantity")).isEqualTo("500");
        Map<String, Object> bags = lines.stream().filter(l -> "Bag".equals(l.get("package_label"))).findFirst().orElseThrow();
        assertThat((BigDecimal) bags.get("quantity")).isEqualByComparingTo("5000");
        assertThat(bags.get("entered_unit")).isNull();
        // The invoice line holds exact thousandths of the selling unit; the snapshot keeps the unit, package and canonical quantity.
        var snapshot = jdbc.queryForList("select * from pos_sale_lines where item_name = 'Rice' order by line_no");
        assertThat(snapshot).hasSize(2);
        assertThat(((Number) snapshot.get(0).get("quantity_milli")).longValue()).isEqualTo(500);
        assertThat(snapshot.get(0).get("sale_unit")).isEqualTo("kg");
        assertThat(snapshot.get(0).get("entered_unit")).isEqualTo("g");
        assertThat((BigDecimal) snapshot.get(0).get("canonical_quantity")).isEqualByComparingTo("500");
        assertThat(((Number) snapshot.get(1).get("quantity_milli")).longValue()).isEqualTo(5_000);
        assertThat(snapshot.get(1).get("package_label")).isEqualTo("Bag");
        assertThat(sale.path("lines").get(1).path("packageLabel").asString()).isEqualTo("Bag");
        // 500 g (0.5 kg x 1,500 = 750), 5 kg (7,500), 7 sodas (2,800) with tax: 750 + 135 + 7,500 + 1,350 + 2,800.
        assertThat(sale.path("totalRwf").asLong()).isEqualTo(750 + 135 + 7_500 + 1_350 + 2_800);
    }

    // ---- current price and tax, verified at billing ------------------------------------------------------------------------

    @Test
    void thePriceAndTaxAreReadAgainAtBillingAndAChangeSinceTheReviewIsRefusedWithTheNewFigures() {
        live();
        JsonNode draft = saveDraft(line(rice, "2", "kg"));
        long reviewed = review(w.cashier, draft).json().path("totalRwf").asLong();
        assertThat(reviewed).isEqualTo(3_540);
        // The merchant reprices the rice after the draft was saved and the cashier reviewed it.
        var repriced = w.owner.put(catalog() + "/items/" + rice.path("id").asString(), Map.of("expectedVersion", freshItem(rice).path("version").asLong(), "name", "Rice",
                "code", "RICE-25", "saleUnit", "kg", "pricePerSaleUnitRwf", 2_000, "priceChangeReason", "Market"));
        assertThat(repriced.status()).as(repriced.body()).isEqualTo(200);
        var stale = bill(w.cashier, "bill-stale-01", draft, reviewed);
        assertThat(stale.status()).isEqualTo(409);
        assertThat(stale.code()).isEqualTo("review_changed");
        assertThat(count("invoices")).isZero();
        // The review shows today's price, the version the draft was saved at and that it changed.
        JsonNode now = review(w.cashier, draft).json();
        assertThat(now.path("totalRwf").asLong()).isEqualTo(4_720);
        assertThat(now.path("lines").get(0).path("unitPriceRwf").asLong()).isEqualTo(2_000);
        assertThat(now.path("lines").get(0).path("draftUnitPriceRwf").asLong()).isEqualTo(1_500);
        assertThat(now.path("lines").get(0).path("priceChangedSinceDraft").asBoolean()).isTrue();
        // Billing what was reviewed NOW succeeds, at the current price and its version: the draft's old price never becomes the bill price.
        var ok = bill(w.cashier, "bill-fresh-01", draft, 4_720);
        assertThat(ok.status()).as(ok.body()).isEqualTo(201);
        var snapshot = jdbc.queryForMap("select price_version, unit_price_rwf, line_total_rwf from pos_sale_lines");
        assertThat(((Number) snapshot.get("price_version")).intValue()).isEqualTo(2);
        assertThat(((Number) snapshot.get("unit_price_rwf")).longValue()).isEqualTo(2_000);
        // A later price change never rewrites the sale snapshot.
        w.owner.put(catalog() + "/items/" + rice.path("id").asString(), Map.of("expectedVersion", freshItem(rice).path("version").asLong(), "name", "Rice",
                "code", "RICE-25", "saleUnit", "kg", "pricePerSaleUnitRwf", 9_999, "priceChangeReason", "Again"));
        assertThat(jdbc.queryForObject("select unit_price_rwf from pos_sale_lines", Long.class)).isEqualTo(2_000);
    }

    @Test
    void anItemWithoutATaxClassificationBlocksBillingAndNothingIsGuessed() {
        live();
        JsonNode untaxed = item(goods("Beans", "BEANS", "MASS", "kg", 900));
        stock(untaxed, "20", "kg");
        JsonNode draft = saveDraft(line(untaxed, "2", "kg"), line(repair, "1", "pc"));
        JsonNode review = review(w.cashier, draft).json();
        assertThat(review.path("billable").asBoolean()).isFalse();
        assertThat(review.path("problems").get(0).path("code").asString()).isEqualTo("tax_not_configured");
        assertThat(review.path("problems").get(0).path("lineNo").asInt()).isEqualTo(1);
        assertThat(review.path("lines").get(0).path("taxCategory").isNull() || review.path("lines").get(0).path("taxCategory").isMissingNode()).isTrue();
        Map<String, Long> before = billRows();
        var refused = bill(w.cashier, "bill-notax-01", draft, 5_000);
        assertThat(refused.status()).isEqualTo(422);
        assertThat(refused.code()).isEqualTo("tax_not_configured");
        assertThat(billRows()).isEqualTo(before);
        assertThat(draftNow(draft).path("status").asString()).isEqualTo("DRAFT");
        // Once the owner classifies it, the same draft bills.
        setTax(untaxed, "EXEMPT", 0);
        assertThat(reviewAndBill(w.cashier, draft).status()).isEqualTo(201);
    }

    @Test
    void aTreatmentNobodyApprovedIsConfiguredButNeverBilled() {
        live();
        JsonNode unapproved = setTax(item(goods("Oil", "OIL", "VOLUME", "l", 3_000)), "STANDARD", 1_500);
        stock(unapproved, "10", "l");
        JsonNode draft = saveDraft(line(unapproved, "1", "l"));
        JsonNode review = review(w.cashier, draft).json();
        assertThat(review.path("billable").asBoolean()).isFalse();
        assertThat(review.path("problems").get(0).path("code").asString()).isEqualTo("tax_not_approved");
        assertThat(review.path("approvedTaxTreatments").toString()).contains("STANDARD 18.00%").doesNotContain("15.00");
        assertThat(bill(w.cashier, "bill-unappr-01", draft, 3_450).code()).isEqualTo("tax_not_approved");
        assertThat(count("invoices")).isZero();
        // The tax API says so too, and only a manager of the catalog may set it.
        var view = w.owner.get(catalog() + "/items/" + unapproved.path("id").asString() + "/tax").json();
        assertThat(view.path("configured").asBoolean()).isTrue();
        assertThat(view.path("approvedForPos").asBoolean()).isFalse();
        assertThat(w.cashier.put(catalog() + "/items/" + unapproved.path("id").asString() + "/tax",
                Map.of("expectedVersion", view.path("version").asLong(), "taxCategory", "EXEMPT", "taxRateBp", 0)).status()).isEqualTo(403);
        assertThat(w.owner.put(catalog() + "/items/" + unapproved.path("id").asString() + "/tax",
                Map.of("expectedVersion", view.path("version").asLong(), "taxCategory", "ZERO_RATED", "taxRateBp", 500)).code()).isEqualTo("invalid_tax_treatment");
        assertThat(w.owner.put(catalog() + "/items/" + unapproved.path("id").asString() + "/tax",
                Map.of("expectedVersion", 99, "taxCategory", "EXEMPT", "taxRateBp", 0)).status()).isEqualTo(409);
    }

    // ---- stock: available = physical - reserved ----------------------------------------------------------------------------------

    @Test
    void reservedStockIsNotAvailableAgainAndInsufficientStockRefusesWithoutAPartialBill() {
        live();
        JsonNode first = saveDraft(line(rice, "7", "kg"));
        billed(first);
        assertThat(reserved(rice)).isEqualByComparingTo("7000");
        assertThat(onHand(rice)).isEqualByComparingTo("10000");
        // 4 kg is physically there (10 kg) but only 3 kg is AVAILABLE.
        JsonNode second = saveDraft(w.otherCashier, line(rice, "4", "kg"));
        JsonNode review = review(w.otherCashier, second).json();
        assertThat(review.path("lines").get(0).path("availability").path("state").asString()).isEqualTo("INSUFFICIENT");
        assertThat(review.path("lines").get(0).path("availability").path("physical").asString()).isEqualTo("10000");
        assertThat(review.path("lines").get(0).path("availability").path("reserved").asString()).isEqualTo("7000");
        assertThat(review.path("lines").get(0).path("availability").path("available").asString()).isEqualTo("3000");
        assertThat(review.path("problems").get(0).path("code").asString()).isEqualTo("insufficient_stock");
        Map<String, Long> before = billRows();
        var refused = bill(w.otherCashier, "bill-short-001", second, 7_080);
        assertThat(refused.status()).isIn(404, 409, 422);
        assertThat(billRows()).isEqualTo(before);
        // The cart view of stock is available stock, with physical and reserved shown apart.
        JsonNode view = w.cashier.get(pos() + "/items?branchId=" + w.branchId + "&q=rice").json().get(0);
        assertThat(view.path("stock").path("onHand").asString()).isEqualTo("10000");
        assertThat(view.path("stock").path("reserved").asString()).isEqualTo("7000");
        assertThat(view.path("stock").path("available").asString()).isEqualTo("3000");
        // The inventory API reports the same three quantities.
        JsonNode balance = w.owner.get("/api/v1/merchants/" + w.merchantId + "/inventory/balances?q=rice").json().path("items").get(0);
        assertThat(balance.path("quantityOnHand").asString()).isEqualTo("10000");
        assertThat(balance.path("quantityReserved").asString()).isEqualTo("7000");
        assertThat(balance.path("quantityAvailable").asString()).isEqualTo("3000");
        assertThat(onHand(rice)).isEqualByComparingTo("10000");
    }

    @Test
    void goodsWithNoStockRecordAtTheBranchCanNotBeBilledAndServicesNeverNeedStock() {
        live();
        JsonNode unstocked = taxed(goods("Salt", "SALT", "MASS", "kg", 500), "EXEMPT", 0);
        JsonNode draft = saveDraft(line(unstocked, "1", "kg"));
        assertThat(review(w.cashier, draft).json().path("lines").get(0).path("availability").path("state").asString()).isEqualTo("NO_STOCK_RECORD");
        assertThat(bill(w.cashier, "bill-nostock-1", draft, 500).code()).isEqualTo("insufficient_stock");
        JsonNode serviceOnly = saveDraft(line(repair, "1", "pc"));
        JsonNode sale = billed(serviceOnly);
        assertThat(sale.path("reservation").path("state").asString()).isEqualTo("NOT_RESERVED");
        assertThat(count("stock_reservations")).isZero();
    }

    @Test
    void concurrentCashiersCanNeverReserveTheSameRemainingStockTwice() throws Exception {
        live();
        // 10 kg on hand; six drafts of 3 kg each: at most three can be billed (9 kg), the rest are refused cleanly.
        List<JsonNode> drafts = new ArrayList<>();
        for (int i = 0; i < 6; i++) {
            drafts.add(saveDraft(i % 2 == 0 ? w.cashier : w.cashier, line(rice, "3", "kg")));
        }
        List<Callable<TestApi.Response>> bills = new ArrayList<>();
        for (int i = 0; i < drafts.size(); i++) {
            JsonNode draft = drafts.get(i);
            int n = i;
            bills.add(() -> bill(w.cashier, "bill-conc-" + n, draft, 5_310));
        }
        List<TestApi.Response> results = concurrently(bills);
        long created = results.stream().filter(r -> r.status() == 201).count();
        assertThat(created).as(results.stream().map(TestApi.Response::body).toList().toString()).isEqualTo(3);
        assertThat(results.stream().filter(r -> r.status() != 201)).allSatisfy(r -> {
            assertThat(r.status()).isEqualTo(409);
            assertThat(r.code()).isEqualTo("insufficient_stock");
        });
        assertThat(reserved(rice)).isEqualByComparingTo("9000");
        assertThat(onHand(rice)).isEqualByComparingTo("10000");
        assertThat(count("stock_reservations")).isEqualTo(3);
        assertThat(count("invoices")).isEqualTo(3);
        assertThat(count("payment_requests")).isEqualTo(3);
        assertThat(count("pos_sales")).isEqualTo(3);
        assertThat(jdbc.queryForObject("select count(*) from pos_drafts where status = 'BILLED'", Integer.class)).isEqualTo(3);
        assertThat(jdbc.queryForObject("select count(*) from pos_drafts where status = 'DRAFT'", Integer.class)).isEqualTo(3);
    }

    @Test
    void aStockAdjustmentCanNeverRemoveReservedStockAndRacesWithABillAreSerialised() throws Exception {
        live();
        billed(saveDraft(line(rice, "9", "kg")));
        // 10 kg physical, 9 kg reserved: only 1 kg can be adjusted away, through the service and through the database.
        var tooMuch = adjustOut(rice, "2", "kg");
        assertThat(tooMuch.status()).isEqualTo(409);
        assertThat(tooMuch.code()).isEqualTo("stock_reserved");
        assertThat(onHand(rice)).isEqualByComparingTo("10000");
        assertThat(adjustOut(rice, "1", "kg").status()).isEqualTo(201);
        assertThat(onHand(rice)).isEqualByComparingTo("9000");
        assertThat(adjustOut(rice, "1", "g").code()).isEqualTo("stock_reserved");
        assertThatThrownBy(() -> jdbc.update("update inventory_balances set quantity_on_hand = 1 where item_id = ?::uuid", rice.path("id").asString())).isNotNull();
        // A bill and an adjustment racing for the same stock: exactly one wins and the invariant holds either way.
        JsonNode beans = taxed(goods("Beans", "BEANS", "MASS", "kg", 900), "EXEMPT", 0);
        stock(beans, "10", "kg");
        JsonNode draft = saveDraft(line(beans, "8", "kg"));
        List<Callable<TestApi.Response>> race = List.of(
                () -> bill(w.cashier, "bill-race-001", draft, 7_200),
                () -> adjustOut(beans, "5", "kg"));
        List<TestApi.Response> raced = concurrently(race);
        TestApi.Response bill = raced.get(0);
        TestApi.Response adjust = raced.get(1);
        assertThat(bill.status() == 201 && adjust.status() == 201).as("a bill and an adjustment can not both take the same stock").isFalse();
        assertThat(bill.status() == 201 || adjust.status() == 201).isTrue();
        assertThat(onHand(beans)).isGreaterThanOrEqualTo(reserved(beans));
        assertThat(onHand(beans).subtract(reserved(beans))).isGreaterThanOrEqualTo(BigDecimal.ZERO);
    }

    @Test
    void billingChangesNoPhysicalStockAndPostsNoSaleMovementEvenAfterAPaymentIsVerified() {
        live();
        JsonNode sale = billed(saveDraft(line(rice, "4", "kg")));
        long movements = count("stock_movements");
        w.bank.payWithCode("POSTED", 7_080, reference(sale), "EQ-LIVE-77");
        // The payment is matched and the invoice is PAID, but R7b never fulfils: the reservation stays ACTIVE and physical stock stays put.
        assertThat(paymentStatusOf(sale)).isEqualTo("PAID");
        assertThat(count("stock_movements")).isEqualTo(movements);
        assertThat(onHand(rice)).isEqualByComparingTo("10000");
        assertThat(reserved(rice)).isEqualByComparingTo("4000");
        assertThat(jdbc.queryForObject("select status from stock_reservations", String.class)).isEqualTo("ACTIVE");
        assertThat(jdbc.queryForObject("select count(*) from stock_movements where movement_type not in ('OPENING')", Integer.class)).isZero();
    }

    /** Moves a reservation past its review time (a test-only change: the trigger that fixes it is switched off for one statement). */
    private void makeReviewable() {
        jdbc.execute("alter table stock_reservations disable trigger trg_stock_reservations_guard");
        try {
            jdbc.update("update stock_reservations set expiry_review_at = created_at");
        } finally {
            jdbc.execute("alter table stock_reservations enable trigger trg_stock_reservations_guard");
        }
    }

    private String paymentStatusOf(JsonNode sale) {
        return w.owner.get("/api/v1/merchants/" + w.merchantId + "/invoices/" + sale.path("sale").path("invoiceId").asString()).json().path("paymentStatus").asString();
    }

    // ---- idempotency, replay and durable identity ----------------------------------------------------------------------------------

    @Test
    void identicalRetriesReturnTheSameSaleAndConflictingOnesAreRefused() {
        live();
        JsonNode draft = saveDraft(line(rice, "2", "kg"), line(repair, "1", "pc"));
        var first = bill(w.cashier, "bill-idem-0001", draft, 8_540);
        var again = bill(w.cashier, "bill-idem-0001", draft, 8_540);
        assertThat(first.status()).isEqualTo(201);
        assertThat(again.status()).isEqualTo(200);
        assertThat(again.json().path("sale").path("saleId").asString()).isEqualTo(first.json().path("sale").path("saleId").asString());
        assertThat(reference(again.json())).isEqualTo(reference(first.json()));
        // The same key for another bill (R2) is a conflict.
        assertThat(bill(w.cashier, "bill-idem-0001", draft, 9_999).code()).isEqualTo("idempotency_key_reuse");
        // A new key for the same draft and bill: still the one sale (the durable identity, not the HTTP record).
        var newKey = bill(w.cashier, "bill-idem-0002", draft, 8_540);
        assertThat(newKey.status()).as(newKey.body()).isEqualTo(200);
        assertThat(newKey.json().path("sale").path("saleId").asString()).isEqualTo(first.json().path("sale").path("saleId").asString());
        // Even when every temporary HTTP idempotency record is gone.
        jdbc.update("delete from idempotency_keys");
        var afterPrune = bill(w.cashier, "bill-idem-0003", draft, 8_540);
        assertThat(afterPrune.status()).isEqualTo(200);
        assertThat(reference(afterPrune.json())).isEqualTo(reference(first.json()));
        // A different total, or the same key for another bill, conflicts.
        assertThat(bill(w.cashier, "bill-idem-0004", draft, 9_999).code()).isEqualTo("bill_conflict");
        assertThat(count("invoices")).isEqualTo(1);
        assertThat(count("payment_requests")).isEqualTo(1);
        assertThat(count("stock_reservations")).isEqualTo(1);
        assertThat(count("pos_sales")).isEqualTo(1);
        assertThat(reserved(rice)).isEqualByComparingTo("2000");
    }

    @Test
    void manyConcurrentBillRequestsForOneDraftMakeOneInvoiceOneReservationAndOneRequest() throws Exception {
        live();
        JsonNode draft = saveDraft(line(rice, "2", "kg"), line(repair, "1", "pc"));
        List<Callable<TestApi.Response>> bills = new ArrayList<>();
        for (int i = 0; i < 8; i++) {
            int n = i;
            // Four share one key, four use their own: both layers are exercised.
            bills.add(() -> bill(w.cashier, i(n) % 2 == 0 ? "bill-same-key-1" : "bill-own-key-" + n, draft, 8_540));
        }
        List<TestApi.Response> results = concurrently(bills);
        assertThat(results).allSatisfy(r -> assertThat(r.status()).as(r.body()).isIn(200, 201, 409));
        assertThat(results.stream().filter(r -> r.status() == 201).count()).isEqualTo(1);
        assertThat(count("invoices")).isEqualTo(1);
        assertThat(count("payment_requests")).isEqualTo(1);
        assertThat(count("stock_reservations")).isEqualTo(1);
        assertThat(count("pos_sales")).isEqualTo(1);
        assertThat(reserved(rice)).isEqualByComparingTo("2000");
    }

    private static int i(int n) {
        return n;
    }

    @Test
    void anEditAndABillOfOneDraftTakeTurnsAndABillAtAStaleDraftVersionIsRefused() {
        live();
        JsonNode draft = saveDraft(line(rice, "2", "kg"));
        long reviewedVersion = draft.path("version").asLong();
        var edit = w.cashier.put(pos() + "/drafts/" + draft.path("id").asString(), Map.of("expectedVersion", reviewedVersion, "lines", List.of(line(rice, "3", "kg"))));
        assertThat(edit.status()).isEqualTo(200);
        // The cashier reviewed the OLD version: the bill at that version is refused, and the draft is untouched.
        Map<String, Object> body = new HashMap<>();
        body.put("expectedDraftVersion", reviewedVersion);
        body.put("reviewedTotalRwf", 3_540);
        var stale = w.cashier.send(HttpMethod.POST, pos() + "/drafts/" + draft.path("id").asString() + "/bill", body, Map.of("Idempotency-Key", "bill-version-01"));
        assertThat(stale.status()).isEqualTo(409);
        assertThat(stale.code()).isEqualTo("version_conflict");
        assertThat(count("invoices")).isZero();
        assertThat(billed(edit.json()).path("totalRwf").asLong()).isEqualTo(5_310);
    }

    // ---- failure injection: every write stage rolls the whole bill back --------------------------------------------------------------

    @Test
    void aFailureAtAnyWriteStageLeavesNothingBehindAndTheDraftEditableAndBillableAgain() {
        live();
        JsonNode draft = saveDraft(line(rice, "2", "kg"), line(repair, "1", "pc"));
        long version = draft.path("version").asLong();
        Map<String, Long> before = billRows();
        // Each table a bill writes, in turn, is made to refuse the insert: invoice, line snapshots, payment request, code sale, reservation, sale link.
        for (String table : List.of("invoice_items", "pos_sale_lines", "payment_requests", "code_sales", "stock_reservations", "stock_reservation_lines", "pos_sales")) {
            jdbc.execute("create or replace function pos_test_fail() returns trigger as $$ begin raise exception 'injected failure at " + table + "'; end; $$ language plpgsql");
            jdbc.execute("create trigger trg_pos_test_fail before insert on " + table + " for each row execute function pos_test_fail()");
            try {
                var failed = bill(w.cashier, "bill-fail-" + table, draft, 8_540);
                assertThat(failed.status()).as(table + ": " + failed.body()).isGreaterThanOrEqualTo(400);
            } finally {
                jdbc.execute("drop trigger trg_pos_test_fail on " + table);
                jdbc.execute("drop function pos_test_fail()");
            }
            assertThat(billRows()).as("nothing remains after a failure at " + table).isEqualTo(before);
            JsonNode after = draftNow(draft);
            assertThat(after.path("status").asString()).isEqualTo("DRAFT");
            assertThat(after.path("version").asLong()).isEqualTo(version);
            assertThat(reserved(rice)).isEqualByComparingTo("0");
            assertThat(onHand(rice)).isEqualByComparingTo("10000");
        }
        // The draft is still editable, and billable: the same attempt that failed is safe to retry.
        var edit = w.cashier.put(pos() + "/drafts/" + draft.path("id").asString(), Map.of("expectedVersion", version, "lines", List.of(line(rice, "2", "kg"), line(repair, "1", "pc"))));
        assertThat(edit.status()).isEqualTo(200);
        JsonNode edited = edit.json();
        assertThat(bill(w.cashier, "bill-after-fail", edited, 8_540).status()).isEqualTo(201);
        assertThat(count("invoices")).isEqualTo(1);
    }

    // ---- immutability ------------------------------------------------------------------------------------------------------------------------

    @Test
    void theCatalogSnapshotOfASaleAndItsReservationAreImmutableAndMustMatchTheInvoice() {
        live();
        JsonNode sale = billed(saveDraft(line(rice, "2", "kg")));
        UUID invoiceId = UUID.fromString(sale.path("sale").path("invoiceId").asString());
        assertThatThrownBy(() -> jdbc.update("update pos_sale_lines set item_name = 'Other'")).hasMessageContaining("never changed");
        assertThatThrownBy(() -> jdbc.update("delete from pos_sale_lines")).hasMessageContaining("never changed");
        assertThatThrownBy(() -> jdbc.update("update stock_reservation_lines set quantity = 1")).hasMessageContaining("never changed");
        assertThatThrownBy(() -> jdbc.update("delete from stock_reservation_lines")).hasMessageContaining("never changed");
        assertThatThrownBy(() -> jdbc.update("delete from stock_reservations")).hasMessageContaining("never deleted");
        assertThatThrownBy(() -> jdbc.update("update stock_reservations set invoice_id = gen_random_uuid()")).isNotNull();
        assertThatThrownBy(() -> jdbc.update("update pos_sales set total_rwf = 1")).hasMessageContaining("never changed");
        assertThatThrownBy(() -> jdbc.update("delete from pos_sales")).hasMessageContaining("never changed");
        assertThatThrownBy(() -> jdbc.update("update pos_drafts set status = 'DRAFT'")).hasMessageContaining("final");
        // The issued invoice line is immutable too (existing rule), and a snapshot that disagrees with it can not be inserted.
        assertThatThrownBy(() -> jdbc.update("update invoice_items set quantity_milli = 1 where invoice_id = ?", invoiceId)).isNotNull();
        UUID itemId = jdbc.queryForObject("select id from invoice_items where invoice_id = ?", UUID.class, invoiceId);
        assertThatThrownBy(() -> jdbc.update("insert into pos_sale_lines (invoice_item_id, invoice_id, merchant_id, line_no, catalog_item_id, item_type, item_name, measurement_dimension, "
                + "entered_quantity, entered_unit, sale_unit, quantity_milli, canonical_quantity, price_version, unit_price_rwf, tax_category, tax_rate_bp, net_rwf, tax_rwf, "
                + "line_total_rwf) values (?, ?, ?, 9, ?::uuid, 'GOODS', 'Rice', 'MASS', '1', 'kg', 'kg', 1000, 1000, 1, 1500, 'EXEMPT', 0, 1500, 0, 1500)", itemId, invoiceId,
                w.merchantId, rice.path("id").asString())).isNotNull();
        // Renaming the item later does not change what was sold.
        w.owner.put(catalog() + "/items/" + rice.path("id").asString(), Map.of("expectedVersion", freshItem(rice).path("version").asLong(), "name", "Premium rice",
                "code", "RICE-25", "saleUnit", "kg", "pricePerSaleUnitRwf", 1_500));
        assertThat(jdbc.queryForObject("select item_name from pos_sale_lines", String.class)).isEqualTo("Rice");
        // A reservation can not be over-filled by writing around the service: the database refuses a line beyond the available stock.
        assertThatThrownBy(() -> jdbc.update("insert into stock_reservation_lines (id, reservation_id, merchant_id, branch_id, invoice_item_id, item_id, item_type, "
                + "measurement_dimension, quantity, entered_quantity, entered_unit, created_at) select gen_random_uuid(), r.id, r.merchant_id, r.branch_id, ?, ?::uuid, 'GOODS', "
                + "'MASS', 99000, '99', 'kg', now() from stock_reservations r", itemId, rice.path("id").asString())).isNotNull();
    }

    // ---- authorization ---------------------------------------------------------------------------------------------------------------------

    @Test
    void onlyThePersonWhoPreparedTheDraftAndHoldsACodeCanBillAndEverythingIsRecheckedOnReplay() {
        live();
        JsonNode draft = saveDraft(line(rice, "1", "kg"));
        // Someone else at the branch, a manager, the owner and another business: not found, nothing created.
        assertThat(bill(w.otherCashier, "bill-auth-0001", draft, 1_770).status()).isEqualTo(404);
        assertThat(review(w.otherCashier, draft).status()).isEqualTo(404);
        assertThat(bill(w.manager, "bill-auth-0002", draft, 1_770).status()).isEqualTo(404);
        assertThat(bill(w.cafeOwner, "bill-auth-0003", draft, 1_770).status()).isIn(403, 404);
        assertThat(count("invoices")).isZero();
        // The preparer without an assigned code is told so; a suspended member can not bill, and a replay re-checks it.
        var ok = bill(w.cashier, "bill-auth-0004", draft, 1_770);
        assertThat(ok.status()).as(ok.body()).isEqualTo(201);
        jdbc.update("update memberships set status = 'SUSPENDED' where id = ?", cashierMembership);
        assertThat(bill(w.cashier, "bill-auth-0004", draft, 1_770).status()).isIn(401, 403, 404);
        assertThat(bill(w.cashier, "bill-auth-0005", draft, 1_770).status()).isIn(401, 403, 404);
        jdbc.update("update memberships set status = 'ACTIVE' where id = ?", cashierMembership);
        // Another cashier can not read the sale.
        assertThat(w.otherCashier.get(pos() + "/sales/" + ok.json().path("sale").path("saleId").asString()).status()).isEqualTo(404);
        assertThat(w.cashier.get(pos() + "/sales/" + ok.json().path("sale").path("saleId").asString()).status()).isEqualTo(200);
    }

    @Test
    void aCashierWithoutACodeAndASimplifiedBusinessCanNotBill() {
        // No code assigned to the cashier at all.
        JsonNode draft = saveDraft(line(rice, "1", "kg"));
        JsonNode review = review(w.cashier, draft).json();
        assertThat(review.path("billable").asBoolean()).isFalse();
        assertThat(review.path("mode").asString()).isEqualTo("UNAVAILABLE");
        assertThat(review.path("problems").toString()).contains("no_assigned_code");
        assertThat(bill(w.cashier, "bill-nocode-001", draft, 1_770).code()).isEqualTo("no_assigned_code");
        // A branch the cashier is no longer assigned to: the draft can not be billed.
        live();
        jdbc.update("update branch_assignments set status = 'ENDED', ended_at = now() where membership_id = ?", cashierMembership);
        assertThat(bill(w.cashier, "bill-nobranch-1", draft, 1_770).status()).isGreaterThanOrEqualTo(400);
        assertThat(count("invoices")).isZero();
        jdbc.update("update branch_assignments set status = 'ACTIVE', ended_at = null where membership_id = ?", cashierMembership);
        // A simplified business keeps amount-only checkout.
        jdbc.update("insert into merchant_settings (merchant_id, operating_mode, updated_at, version) values (?, 'SIMPLIFIED', now(), 0) "
                + "on conflict (merchant_id) do update set operating_mode = excluded.operating_mode", w.merchantId);
        assertThat(bill(w.cashier, "bill-simpl-0001", draft, 1_770).code()).isEqualTo("pos_unavailable");
    }

    @Test
    void anInactiveItemOrADiscardedDraftCanNotBeBilled() {
        live();
        JsonNode draft = saveDraft(line(rice, "1", "kg"));
        var off = w.owner.put(catalog() + "/items/" + rice.path("id").asString() + "/status", Map.of("expectedVersion", freshItem(rice).path("version").asLong(), "active", false));
        assertThat(off.status()).isEqualTo(200);
        JsonNode review = review(w.cashier, draft).json();
        assertThat(review.path("billable").asBoolean()).isFalse();
        assertThat(review.path("problems").get(0).path("code").asString()).isEqualTo("item_inactive");
        assertThat(bill(w.cashier, "bill-inactive-1", draft, 1_770).code()).isEqualTo("item_inactive");
        JsonNode other = saveDraft(line(repair, "1", "pc"));
        assertThat(w.cashier.delete(pos() + "/drafts/" + other.path("id").asString() + "?expectedVersion=0").status()).isEqualTo(200);
        var discarded = bill(w.cashier, "bill-discard-01", other, 5_000);
        assertThat(discarded.status()).isEqualTo(409);
        assertThat(discarded.code()).isEqualTo("draft_not_open");
        assertThat(count("invoices")).isZero();
    }

    // ---- demonstration -------------------------------------------------------------------------------------------------------------------------

    @Test
    void aDemonstrationSaleIsBilledAsADemonstrationReservesNothingAndStaysOutOfTheRealBooks() {
        demo();
        JsonNode draft = saveDraft(line(rice, "2", "kg"), line(repair, "1", "pc"));
        JsonNode review = review(w.cashier, draft).json();
        assertThat(review.path("mode").asString()).isEqualTo("DEMONSTRATION");
        assertThat(review.path("modeNote").asString()).contains("DEMONSTRATION");
        JsonNode sale = billed(draft);
        assertThat(sale.path("mode").asString()).isEqualTo("DEMONSTRATION");
        assertThat(sale.path("sale").path("code").path("mode").asString()).isEqualTo("DEMONSTRATION");
        assertThat(sale.path("sale").path("code").path("notice").asString()).contains("DEMONSTRATION ONLY");
        assertThat(sale.path("sale").path("code").path("bankCode").isNull() || sale.path("sale").path("code").path("bankCode").asString().isEmpty()).isTrue();
        assertThat(sale.path("reservation").path("state").asString()).isEqualTo("NOT_RESERVED");
        assertThat(sale.path("reservation").path("note").asString()).contains("DEMONSTRATION");
        assertThat(count("stock_reservations")).isZero();
        assertThat(reserved(rice)).isEqualByComparingTo("0");
        assertThat(onHand(rice)).isEqualByComparingTo("10000");
        // A real invoice flag and number series: DEMO-0001, never listed, never counted, and it can never take bank money.
        var invoice = jdbc.queryForMap("select invoice_number, is_demonstration from invoices");
        assertThat(invoice.get("invoice_number").toString()).startsWith("DEMO-");
        assertThat(invoice.get("is_demonstration")).isEqualTo(true);
        assertThat(w.owner.get("/api/v1/merchants/" + w.merchantId + "/invoices").json().path("items").size()).isZero();
        assertThat(jdbc.queryForObject("select presentation_mode from pos_sales", String.class)).isEqualTo("DEMONSTRATION");
        assertThat(jdbc.queryForObject("select count(*) from invoice_number_sequences", Integer.class)).isZero();
    }

    // ---- late payment, expiry and release -----------------------------------------------------------------------------------------------------

    @Test
    void anExpiredRequestNeverReleasesStockByItselfAndALatePaymentIsStillAppliedWithoutNegativeStock() {
        live();
        JsonNode sale = billed(saveDraft(line(rice, "4", "kg")));
        jdbc.update("update payment_requests set expires_at = now() - interval '2 hours' where public_reference = ?", reference(sale));
        makeReviewable();
        // Time passing releases nothing: there is no worker, and reads do not release either.
        assertThat(w.cashier.get(pos() + "/sales/" + sale.path("sale").path("saleId").asString()).json().path("reservation").path("state").asString()).isEqualTo("RESERVED");
        assertThat(w.cashier.get(pos() + "/sales/" + sale.path("sale").path("saleId").asString()).json().path("sale").path("status").asString()).isEqualTo("EXPIRED");
        assertThat(reserved(rice)).isEqualByComparingTo("4000");
        // A late bank confirmation is matched to the sale; the reservation and the stock are exactly as they were: never negative.
        w.bank.payWithCode("POSTED", 7_080, reference(sale), "EQ-LIVE-77");
        assertThat(paymentStatusOf(sale)).isEqualTo("PAID");
        assertThat(jdbc.queryForObject("select status from stock_reservations", String.class)).isEqualTo("ACTIVE");
        assertThat(onHand(rice)).isEqualByComparingTo("10000");
        assertThat(onHand(rice).subtract(reserved(rice))).isGreaterThanOrEqualTo(BigDecimal.ZERO);
        // And it can no longer be released by hand: a payment was applied.
        var blocked = w.owner.post(pos() + "/sales/" + sale.path("sale").path("saleId").asString() + "/release-reservation", Map.of("reason", "Customer never came back"));
        assertThat(blocked.status()).isEqualTo(409);
        assertThat(blocked.code()).isEqualTo("release_blocked_payment_evidence");
    }

    @Test
    void aReservationIsReleasedOnlyByTheOwnerAfterTheRequestClosedWithNoPaymentEvidenceAndTheStockIsAvailableAgain() {
        live();
        JsonNode withEvidence = billed(saveDraft(line(rice, "4", "kg")));
        JsonNode sale = billed(saveDraft(line(rice, "5", "kg")));
        String saleId = sale.path("sale").path("saleId").asString();
        Map<String, Object> reason = Map.of("reason", "Customer abandoned the sale");
        // Open request: refused. Not the owner: refused. A short reason: refused.
        assertThat(w.owner.post(pos() + "/sales/" + saleId + "/release-reservation", reason).code()).isEqualTo("release_too_early");
        makeReviewable();
        assertThat(w.owner.post(pos() + "/sales/" + saleId + "/release-reservation", reason).code()).isEqualTo("payment_request_still_open");
        jdbc.update("update payment_requests set expires_at = now() - interval '2 hours'");
        assertThat(w.manager.post(pos() + "/sales/" + saleId + "/release-reservation", reason).status()).isEqualTo(403);
        assertThat(w.cashier.post(pos() + "/sales/" + saleId + "/release-reservation", reason).status()).isEqualTo(403);
        assertThat(w.owner.post(pos() + "/sales/" + saleId + "/release-reservation", Map.of("reason", "short")).status()).isEqualTo(422);
        // A bank transaction that names a sale (even a part payment) is evidence: that stock stays reserved for reconciliation.
        w.bank.payWithCode("POSTED", 100, reference(withEvidence), "EQ-LIVE-77");
        var blocked = w.owner.post(pos() + "/sales/" + withEvidence.path("sale").path("saleId").asString() + "/release-reservation", reason);
        assertThat(blocked.status()).isEqualTo(409);
        assertThat(blocked.code()).isEqualTo("release_blocked_payment_evidence");
        assertThat(reserved(rice)).isEqualByComparingTo("9000");
        // A sale with no evidence at all can be released by the owner: final, audited, and the stock is available to sell again.
        var released = w.owner.post(pos() + "/sales/" + saleId + "/release-reservation", reason);
        assertThat(released.status()).as(released.body()).isEqualTo(200);
        assertThat(released.json().path("reservation").path("state").asString()).isEqualTo("RELEASED");
        assertThat(released.json().path("reservation").path("releaseReason").asString()).isEqualTo("Customer abandoned the sale");
        assertThat(reserved(rice)).isEqualByComparingTo("4000");
        assertThat(onHand(rice)).isEqualByComparingTo("10000");
        assertThat(w.owner.post(pos() + "/sales/" + saleId + "/release-reservation", reason).code()).isEqualTo("reservation_not_active");
        assertThat(jdbc.queryForObject("select count(*) from audit_log where kind = 'POS_RESERVATION_RELEASED'", Integer.class)).isEqualTo(1);
        assertThatThrownBy(() -> jdbc.update("update stock_reservations set status = 'ACTIVE', released_at = null, released_by_user_id = null, release_reason = null"))
                .isNotNull();
        // The released stock is available again: the same quantity can be billed afresh.
        assertThat(billed(saveDraft(line(rice, "5", "kg"))).path("reservation").path("state").asString()).isEqualTo("RESERVED");
    }

    // ---- legacy and neighbours ---------------------------------------------------------------------------------------------------------------------

    @Test
    void ordinaryInvoicesAndTheAmountOnlyCodeCheckoutAreUnchangedByPosBilling() {
        live();
        // The ordinary code sale (R6c) still works, still takes INV- numbers, and reserves nothing.
        var plain = bill(w.cashier, "key-plain-0001", body(7_000, "Two coffees", null, UUID.randomUUID()));
        assertThat(plain.status()).as(plain.body()).isEqualTo(201);
        assertThat(count("stock_reservations")).isZero();
        assertThat(count("pos_sales")).isZero();
        JsonNode sale = billed(saveDraft(line(rice, "1", "kg")));
        var numbers = jdbc.queryForList("select invoice_number from invoices order by created_at", String.class);
        assertThat(numbers).containsExactly("INV-0001", "INV-0002");
        UUID invoiceId = w.issuedInvoice(10_000);
        assertThat(jdbc.queryForObject("select invoice_number from invoices where id = ?", String.class, invoiceId)).isEqualTo("INV-0003");
        assertThat(reference(sale)).startsWith("OP-");
    }

    // ---- R7b review: release races, replay after release, and the invoice as the reviewed cart ----------------------------------------

    /** A sale whose request has expired and whose reservation may be reviewed: the point from which the owner may consider a release. */
    private JsonNode expiredSale(String quantityKg) {
        JsonNode sale = billed(saveDraft(line(rice, quantityKg, "kg")));
        jdbc.update("update payment_requests set expires_at = now() - interval '2 hours' where public_reference = ?", reference(sale));
        makeReviewable();
        return sale;
    }

    private String release(JsonNode sale) {
        return pos() + "/sales/" + sale.path("sale").path("saleId").asString() + "/release-reservation";
    }

    private void assertStockInvariants(JsonNode item) {
        BigDecimal physical = onHand(item);
        BigDecimal reserved = reserved(item);
        assertThat(physical).as("physical stock is never negative").isGreaterThanOrEqualTo(BigDecimal.ZERO);
        assertThat(reserved).isGreaterThanOrEqualTo(BigDecimal.ZERO);
        assertThat(physical.subtract(reserved)).as("available = physical - reserved is never negative").isGreaterThanOrEqualTo(BigDecimal.ZERO);
    }

    @Test
    void twoReleasesOfOneReservationNeverBothSucceedAndTheStockIsFreedOnce() throws Exception {
        live();
        JsonNode sale = expiredSale("4");
        Map<String, Object> reason = Map.of("reason", "Customer abandoned the sale");
        List<Callable<TestApi.Response>> releases = new ArrayList<>();
        for (int i = 0; i < 6; i++) {
            releases.add(() -> w.owner.post(release(sale), reason));
        }
        List<TestApi.Response> results = concurrently(releases);
        assertThat(results.stream().filter(r -> r.status() == 200).count()).isEqualTo(1);
        assertThat(results.stream().filter(r -> r.status() != 200)).allSatisfy(r -> {
            assertThat(r.status()).isEqualTo(409);
            assertThat(r.code()).isEqualTo("reservation_not_active");
        });
        assertThat(reserved(rice)).isEqualByComparingTo("0");
        assertThat(onHand(rice)).isEqualByComparingTo("10000");
        assertThat(jdbc.queryForObject("select count(*) from audit_log where kind = 'POS_RESERVATION_RELEASED'", Integer.class)).isEqualTo(1);
        assertThat(jdbc.queryForObject("select version from stock_reservations", Long.class)).isEqualTo(1L);
        assertStockInvariants(rice);
    }

    @Test
    void anExpiredRequestAloneIsNotProofAPendingBankPaymentKeepsTheStockReserved() {
        live();
        JsonNode sale = expiredSale("4");
        // The request is expired and its review time has passed, but the bank has reported a payment that is still pending.
        w.bank.payWithCode("PENDING", 7_080, reference(sale), "EQ-LIVE-77");
        var blocked = w.owner.post(release(sale), Map.of("reason", "Customer abandoned the sale"));
        assertThat(blocked.status()).isEqualTo(409);
        assertThat(blocked.code()).isEqualTo("release_blocked_payment_evidence");
        assertThat(reserved(rice)).isEqualByComparingTo("4000");
        assertThat(jdbc.queryForObject("select status from stock_reservations", String.class)).isEqualTo("ACTIVE");
    }

    @Test
    void aBillReplayedAfterAReleaseReturnsTheSameSaleAndNeverReservesAgain() {
        live();
        JsonNode draft = saveDraft(line(rice, "4", "kg"));
        var first = bill(w.cashier, "bill-replay-rel-1", draft, 7_080);
        assertThat(first.status()).isEqualTo(201);
        jdbc.update("update payment_requests set expires_at = now() - interval '2 hours'");
        makeReviewable();
        assertThat(w.owner.post(release(first.json()), Map.of("reason", "Customer abandoned the sale")).status()).isEqualTo(200);
        assertThat(reserved(rice)).isEqualByComparingTo("0");
        // The same bill again, with the same key and with a new key: the original sale comes back, as RELEASED. Nothing is reserved anew.
        for (String key : List.of("bill-replay-rel-1", "bill-replay-rel-2")) {
            var again = bill(w.cashier, key, draft, 7_080);
            assertThat(again.status()).as(again.body()).isEqualTo(200);
            assertThat(again.json().path("sale").path("saleId").asString()).isEqualTo(first.json().path("sale").path("saleId").asString());
            assertThat(again.json().path("reservation").path("state").asString()).isEqualTo("RELEASED");
        }
        assertThat(count("stock_reservations")).isEqualTo(1);
        assertThat(count("invoices")).isEqualTo(1);
        assertThat(reserved(rice)).isEqualByComparingTo("0");
        // The draft is billed for good: it can not be billed anew to take the stock again.
        assertThat(w.cashier.put(pos() + "/drafts/" + draft.path("id").asString(), Map.of("expectedVersion", 1, "lines", List.of(line(rice, "1", "kg")))).code())
                .isEqualTo("draft_not_open");
    }

    @Test
    void aLateConfirmedPaymentAfterAReleaseNeverMakesStockNegativeAndIsVisibleToFulfilmentAsAnException() {
        live();
        JsonNode sale = expiredSale("4");
        assertThat(jdbc.queryForObject("select count(*) from pos_sale_fulfilment_exceptions", Integer.class)).isZero();
        assertThat(w.owner.post(release(sale), Map.of("reason", "Customer abandoned the sale")).status()).isEqualTo(200);
        assertThat(jdbc.queryForObject("select count(*) from pos_sale_fulfilment_exceptions", Integer.class)).as("released and unpaid is not an exception").isZero();
        long movements = count("stock_movements");
        // The bank confirms the money after the release: R6d-B still applies it to the sale (an expired request is not proof that no payment is coming).
        w.bank.payWithCode("POSTED", 7_080, reference(sale), "EQ-LIVE-77");
        assertThat(paymentStatusOf(sale)).isEqualTo("PAID");
        assertThat(count("stock_movements")).isEqualTo(movements);
        assertThat(onHand(rice)).isEqualByComparingTo("10000");
        assertThat(reserved(rice)).isEqualByComparingTo("0");
        assertStockInvariants(rice);
        // R7c can find this sale: paid, with a released reservation. It is for fulfilment to handle, never to fulfil as usual.
        var exception = jdbc.queryForMap("select * from pos_sale_fulfilment_exceptions");
        assertThat(exception.get("sale_id").toString()).isEqualTo(sale.path("sale").path("saleId").asString());
        assertThat(exception.get("reservation_status")).isEqualTo("RELEASED");
        assertThat(((Number) exception.get("applied_rwf")).longValue()).isEqualTo(7_080);
        // The sale reads back as paid with a released reservation: nothing is hidden.
        JsonNode view = w.cashier.get(pos() + "/sales/" + sale.path("sale").path("saleId").asString()).json();
        assertThat(view.path("reservation").path("state").asString()).isEqualTo("RELEASED");
        assertThat(view.path("sale").path("status").asString()).isEqualTo("SETTLED");
    }

    @Test
    void aReleaseRacingAPaymentLeavesStockAndMoneyConsistentWhicheverWins() throws Exception {
        live();
        JsonNode sale = expiredSale("4");
        List<Callable<Object>> race = List.of(
                () -> w.owner.post(release(sale), Map.of("reason", "Customer abandoned the sale")),
                () -> w.bank.payWithCode("POSTED", 7_080, reference(sale), "EQ-LIVE-77"));
        List<Object> results = concurrently(race);
        TestApi.Response release = (TestApi.Response) results.get(0);
        assertThat(release.status()).as(release.body()).isIn(200, 409);
        assertThat(paymentStatusOf(sale)).isEqualTo("PAID");
        String status = jdbc.queryForObject("select status from stock_reservations", String.class);
        assertThat(status).isIn("ACTIVE", "RELEASED");
        assertThat(release.status() == 200).isEqualTo("RELEASED".equals(status));
        // If the release won, fulfilment is told; if the payment was seen first, the release was refused and the stock is still held. Either way:
        int exceptions = jdbc.queryForObject("select count(*) from pos_sale_fulfilment_exceptions", Integer.class);
        assertThat(exceptions).isEqualTo("RELEASED".equals(status) ? 1 : 0);
        if (release.status() == 409) {
            assertThat(release.code()).isEqualTo("release_blocked_payment_evidence");
        }
        assertThat(onHand(rice)).isEqualByComparingTo("10000");
        assertStockInvariants(rice);
        assertThat(jdbc.queryForObject("select coalesce(sum(amount_rwf), 0) from payment_allocations where status = 'ACTIVE'", Long.class)).isEqualTo(7_080L);
    }

    @Test
    void theInvoiceIsTheReviewedCartLineForLineAndTheReservationIsTheCanonicalQuantities() {
        live();
        JsonNode bag = packageOf(rice, "Bag", "5", "kg");
        JsonNode draft = saveDraft(line(rice, "500", "g"), packageLine(rice, "1", bag), line(soda, "7", "pc"), line(repair, "1", "pc"));
        JsonNode review = review(w.cashier, draft).json();
        long reviewed = review.path("totalRwf").asLong();
        JsonNode sale = billed(draft);
        UUID invoiceId = UUID.fromString(sale.path("sale").path("invoiceId").asString());
        JsonNode invoice = w.owner.get("/api/v1/merchants/" + w.merchantId + "/invoices/" + invoiceId).json();
        // The invoice amount is exactly the reviewed final total, line by line.
        assertThat(invoice.path("grandTotal").asLong()).isEqualTo(reviewed);
        assertThat(sale.path("sale").path("amountRwf").asLong()).isEqualTo(reviewed);
        assertThat(invoice.path("items").size()).isEqualTo(review.path("lines").size());
        List<Map<String, Object>> snapshot = jdbc.queryForList("select * from pos_sale_lines order by line_no");
        for (int i = 0; i < invoice.path("items").size(); i++) {
            JsonNode item = invoice.path("items").get(i);
            JsonNode reviewLine = review.path("lines").get(i);
            Map<String, Object> snap = snapshot.get(i);
            assertThat(item.path("lineTotal").asLong()).isEqualTo(reviewLine.path("lineTotalRwf").asLong());
            assertThat(item.path("netAmount").asLong()).isEqualTo(reviewLine.path("netRwf").asLong());
            assertThat(item.path("taxAmount").asLong()).isEqualTo(reviewLine.path("taxRwf").asLong());
            assertThat(item.path("unitPrice").asLong()).isEqualTo(reviewLine.path("unitPriceRwf").asLong());
            assertThat(item.path("taxRate").path("category").asString()).isEqualTo(reviewLine.path("taxCategory").asString());
            assertThat(item.path("taxRate").path("rateBp").asInt()).isEqualTo(reviewLine.path("taxRateBp").asInt());
            assertThat(new BigDecimal(item.path("quantity").asString())).isEqualByComparingTo(reviewLine.path("quantityInSaleUnit").asString());
            assertThat(item.path("description").asString()).startsWith(reviewLine.path("name").asString());
            // And the immutable snapshot says the same, with the catalog item, price version and tax of that moment.
            assertThat(snap.get("item_name")).isEqualTo(reviewLine.path("name").asString());
            assertThat(((Number) snap.get("price_version")).intValue()).isEqualTo(reviewLine.path("priceVersion").asInt());
            assertThat(snap.get("tax_category")).isEqualTo(reviewLine.path("taxCategory").asString());
            assertThat(((Number) snap.get("tax_rate_bp")).intValue()).isEqualTo(reviewLine.path("taxRateBp").asInt());
            assertThat(((Number) snap.get("line_total_rwf")).longValue()).isEqualTo(reviewLine.path("lineTotalRwf").asLong());
        }
        // Each goods line has exactly one reservation line with its canonical quantity (500 g, 5,000 g, 7 pc); the service has none.
        List<Map<String, Object>> reservedLines = jdbc.queryForList("select r.invoice_item_id, r.quantity, s.canonical_quantity, s.item_type from stock_reservation_lines r "
                + "join pos_sale_lines s on s.invoice_item_id = r.invoice_item_id order by s.line_no");
        assertThat(reservedLines).hasSize(3);
        for (Map<String, Object> line : reservedLines) {
            assertThat((BigDecimal) line.get("quantity")).isEqualByComparingTo((BigDecimal) line.get("canonical_quantity"));
            assertThat(line.get("item_type")).isEqualTo("GOODS");
        }
        assertThat(jdbc.queryForObject("select count(*) from stock_reservation_lines r join pos_sale_lines s on s.invoice_item_id = r.invoice_item_id "
                + "where s.item_type = 'SERVICE'", Integer.class)).isZero();
        assertThat(reserved(rice)).isEqualByComparingTo("5500");
        assertThat(reserved(soda)).isEqualByComparingTo("7");
    }
}
