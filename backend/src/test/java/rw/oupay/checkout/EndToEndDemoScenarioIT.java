package rw.oupay.checkout;

import static org.assertj.core.api.Assertions.assertThat;

import java.math.BigDecimal;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.context.TestPropertySource;
import rw.oupay.pos.PosFulfilmentService;
import tools.jackson.databind.JsonNode;

/**
 * The demonstration scenario, end to end, against a REAL PostgreSQL and the real HTTP API (MockMvc), in the APPROVED TEST CONFIGURATION only
 * (profile {@code test}: it is the one place the collection-code approval hook, live collection and the tax approval list may be switched on).
 * EVERYTHING HERE IS SYNTHETIC: the "bank" is the authenticated simulator, no Equity system is involved, and no real money exists.
 *
 * <p>One BUSINESS, two agents each holding their own collection code, goods and services in one catalog, stock received at one branch,
 * a mixed cart reviewed and billed, an authenticated simulated bank event, exact reconciliation, the fulfilment worker, and final balances.
 * Each step prints a line starting with {@code E2E>} so the run reads as a transcript.
 */
@TestPropertySource(properties = {
        "oupay.collection-codes.approval-enabled=true",
        "oupay.code-checkout.live-enabled=true",
        "oupay.code-checkout.instructions=Open the bank app|Pay to the merchant code shown",
        "oupay.pos.approved-tax-treatments=EXEMPT:0,ZERO_RATED:0,STANDARD:1800,NOT_APPLICABLE:0",
        "oupay.pos.reservation-review-grace=PT0S"})
class EndToEndDemoScenarioIT extends PosBillingTestSupport {

    @Autowired
    PosFulfilmentService fulfilments;

    private static void say(String line) {
        System.out.println("E2E> " + line);
    }

    private String status(JsonNode sale) {
        return view(sale).path("fulfilment").path("paymentState").asString() + " / " + view(sale).path("fulfilment").path("inventoryState").asString();
    }

    private JsonNode view(JsonNode sale) {
        var response = w.owner.get(pos() + "/sales/" + sale.path("sale").path("saleId").asString());
        assertThat(response.status()).as(response.body()).isEqualTo(200);
        return response.json();
    }

    private JsonNode billedBy(rw.oupay.support.TestApi agent, JsonNode draft) {
        var response = reviewAndBill(agent, draft);
        assertThat(response.status()).as(response.body()).isEqualTo(201);
        return response.json();
    }

    @Test
    void aBusinessSellsGoodsAndServicesAndItsStockFollowsVerifiedPaymentExactly() {
        say("Business: Sample Shop Ltd (BUSINESS, synthetic). Agents: Aline Cashier and Eric Cashier, both assigned to branch RM01.");

        // Catalog: goods and a service in one catalog (set up by the base class). Stock is RECEIVED at the branch by the manager.
        Map<String, Object> receive = new HashMap<>();
        receive.put("clientOperationId", UUID.randomUUID().toString());
        receive.put("branchId", w.branchId.toString());
        receive.put("itemId", rice.path("id").asString());
        receive.put("amount", "20");
        receive.put("unit", "kg");
        receive.put("reference", "DN-DEMO-0001");
        assertThat(w.manager.post("/api/v1/merchants/" + w.merchantId + "/inventory/receive", receive).status()).isEqualTo(201);
        assertThat(onHand(rice)).isEqualByComparingTo("30000");
        say("Stock: rice 10 kg opening + 20 kg received (delivery note DN-DEMO-0001) = 30 kg; soda 100 pc.");

        // Each agent holds a different bank-approved (test hook) collection code.
        JsonNode alineCode = live();
        JsonNode ericCode = activeCode("Eric counter", "EQ-LIVE-88");
        assertThat(assign(ericCode, otherCashierMembership).status()).isEqualTo(201);
        say("Collection codes: EQ-LIVE-77 -> Aline, EQ-LIVE-88 -> Eric (approval granted through the TEST-ONLY hook; no operator console exists).");

        // Aline: a mixed cart, final price and tax review, billing and the stock reservation.
        JsonNode draft = saveDraft(line(rice, "2", "kg"), line(soda, "3", "pc"), line(repair, "1", "pc"));
        var review = review(w.cashier, draft);
        assertThat(review.status()).as(review.body()).isEqualTo(200);
        long total = review.json().path("totalRwf").asLong();
        say("Aline's cart: 2 kg rice (18% VAT), 3 soda (zero-rated), 1 repair (exempt). Reviewed total RWF " + total + " (net " + review.json().path("subtotalRwf").asLong() + " + tax).");
        JsonNode sale = billedBy(w.cashier, draft);
        assertThat(sale.path("mode").asString()).isEqualTo("LIVE");
        say("Billed LIVE sale " + reference(sale) + " for RWF " + total + " on code EQ-LIVE-77. Reservation ACTIVE; payment not yet received.");
        assertThat(reserved(rice)).isEqualByComparingTo("2000");
        assertThat(onHand(rice)).isEqualByComparingTo("30000");
        assertThat(status(sale)).isEqualTo("UNPAID / NOT_POSTED");
        say("State before payment: UNPAID / NOT_POSTED. Rice physical 30 kg, reserved 2 kg.");

        // The worker runs while nothing is paid: it must do nothing.
        assertThat(fulfilments.processDue(50).posted()).isZero();

        // Authenticated simulated bank event, exact amount, correct reference and code.
        var delivery = w.bank.payWithCode("POSTED", total, reference(sale), "EQ-LIVE-77");
        assertThat(delivery.outcome()).isEqualTo("APPLIED");
        var tx = jdbc.queryForMap("select status, attribution_status, agent_attribution, review_state from bank_transactions where provider_transaction_id = ?", delivery.transactionId());
        assertThat(tx.get("status")).isEqualTo("CONFIRMED");
        assertThat(tx.get("attribution_status")).isEqualTo("RESOLVED");
        assertThat(tx.get("agent_attribution")).isEqualTo("CONFIRMED_FROM_SALE_SNAPSHOT");
        assertThat(tx.get("review_state")).isEqualTo("NONE");
        say("SIMULATED bank event applied: transaction CONFIRMED, attribution RESOLVED to Aline from the sale snapshot, no review needed.");
        assertThat(status(sale)).isEqualTo("PAID / NOT_POSTED");
        assertThat(onHand(rice)).isEqualByComparingTo("30000");
        say("Reconciled: PAID, but stock is NOT deducted yet (the ledger never touches inventory). Handover: NOT_TRACKED.");

        // The fulfilment worker runs after the allocation committed.
        assertThat(fulfilments.processDue(50).posted()).isEqualTo(1);
        assertThat(status(sale)).isEqualTo("PAID / POSTED");
        assertThat(onHand(rice)).isEqualByComparingTo("28000");
        assertThat(onHand(soda)).isEqualByComparingTo("97");
        assertThat(reserved(rice)).isEqualByComparingTo("0");
        assertThat(jdbc.queryForObject("select count(*) from stock_movements where movement_type = 'SALE'", Integer.class)).isEqualTo(2);
        assertThat(view(sale).path("fulfilment").path("handover").asString()).isEqualTo("NOT_TRACKED");
        say("Worker posted fulfilment: 2 SALE movements (rice -2 kg, soda -3 pc), reservation FULFILLED. PAID / POSTED. Handover still NOT_TRACKED.");
        assertThat(fulfilments.processDue(50).posted()).isZero();
        assertThat(jdbc.queryForObject("select count(*) from stock_movements where movement_type = 'SALE'", Integer.class)).isEqualTo(2);
        say("Worker re-run: nothing posted again (idempotent).");

        // Eric: a services-only sale, paid; and a goods sale only partly paid.
        JsonNode ericService = billedBy(w.otherCashier, saveDraft(w.otherCashier, line(repair, "1", "pc")));
        long serviceTotal = ericService.path("sale").path("amountRwf").asLong();
        var servicePayment = w.bank.payWithCode("POSTED", serviceTotal, reference(ericService), "EQ-LIVE-88");
        assertThat(servicePayment.outcome()).as(servicePayment.response().body()).isEqualTo("APPLIED");
        assertThat(fulfilments.processDue(50).posted()).isZero();
        assertThat(status(ericService)).isEqualTo("PAID / NOT_REQUIRED");
        say("Eric's services-only sale " + reference(ericService) + ": PAID / NOT_REQUIRED (no goods, no movement, no failed work).");

        JsonNode ericGoods = billedBy(w.otherCashier, saveDraft(w.otherCashier, line(soda, "10", "pc")));
        long goodsTotal = ericGoods.path("sale").path("amountRwf").asLong();
        assertThat(w.bank.payWithCode("POSTED", goodsTotal - 1, reference(ericGoods), "EQ-LIVE-88").outcome()).isNotNull();
        assertThat(fulfilments.processDue(50).posted()).isZero();
        say("Eric's goods sale " + reference(ericGoods) + " paid RWF " + (goodsTotal - 1) + " of " + goodsTotal + ": " + status(ericGoods) + " (nothing deducted until paid in full; 10 soda stay reserved).");
        assertThat(onHand(soda)).isEqualByComparingTo("97");
        assertThat(jdbc.queryForObject("select status from stock_reservations where invoice_id = ?", String.class,
                UUID.fromString(ericGoods.path("sale").path("invoiceId").asString()))).isEqualTo("ACTIVE");

        // Final balances.
        BigDecimal rice = onHand(this.rice);
        BigDecimal soda = onHand(this.soda);
        say("FINAL: rice on hand " + rice + " g (expected 28000), soda on hand " + soda + " pc (expected 97), soda reserved " + reserved(this.soda) + " (expected 10).");
        assertThat(rice).isEqualByComparingTo("28000");
        assertThat(soda).isEqualByComparingTo("97");
        assertThat(reserved(this.soda)).isEqualByComparingTo("10");
        assertThat(jdbc.queryForObject("select count(*) from pos_fulfilment_exceptions", Integer.class)).isZero();
        say("No fulfilment exceptions. Owner's exception list: " + w.owner.get(pos() + "/fulfilment/exceptions").json().size() + " item(s).");
    }
}
