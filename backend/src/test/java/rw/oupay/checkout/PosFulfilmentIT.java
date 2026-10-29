package rw.oupay.checkout;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Callable;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.context.TestPropertySource;
import rw.oupay.pos.PosFulfilmentService;
import rw.oupay.support.TestApi;
import tools.jackson.databind.JsonNode;

/**
 * R7c: a LIVE POS sale paid in full through RECONCILED bank money has its reservation turned into SALE stock movements, once, in one transaction,
 * by a worker that runs after the allocation committed. Everything else (partial, unmatched, released, reversed, demonstration) deducts nothing.
 */
@TestPropertySource(properties = {
        "oupay.collection-codes.approval-enabled=true",
        "oupay.code-checkout.live-enabled=true",
        "oupay.code-checkout.instructions=Open the bank app|Pay to the merchant code shown",
        "oupay.pos.approved-tax-treatments=EXEMPT:0,ZERO_RATED:0,STANDARD:1800,NOT_APPLICABLE:0",
        "oupay.pos.reservation-review-grace=PT0S",
        "oupay.pos.fulfilment.max-attempts=3"})
class PosFulfilmentIT extends PosBillingTestSupport {

    @Autowired
    PosFulfilmentService fulfilments;

    // ---- helpers -------------------------------------------------------------------------------------------------------

    private JsonNode billedMixed() {
        live();
        return billed(saveDraft(line(rice, "2", "kg"), line(soda, "3", "pc"), line(repair, "1", "pc")));
    }

    private long total(JsonNode sale) {
        return sale.path("totalRwf").asLong();
    }

    private PosFulfilmentService.Summary work() {
        return fulfilments.processDue(50);
    }

    private rw.oupay.support.Bank.Delivery pay(JsonNode sale, long amount) {
        return w.bank.payWithCode("POSTED", amount, reference(sale), "EQ-LIVE-77");
    }

    private List<Map<String, Object>> saleMovements() {
        return jdbc.queryForList("select * from stock_movements where movement_type = 'SALE' order by created_at, id");
    }

    private String saleId(JsonNode sale) {
        return sale.path("sale").path("saleId").asString();
    }

    private JsonNode view(JsonNode sale) {
        var response = w.cashier.get(pos() + "/sales/" + saleId(sale));
        assertThat(response.status()).as(response.body()).isEqualTo(200);
        return response.json();
    }

    private String fulfilmentStatus() {
        return jdbc.queryForObject("select status from pos_fulfilments", String.class);
    }

    private void makeReviewable() {
        jdbc.execute("alter table stock_reservations disable trigger trg_stock_reservations_guard");
        try {
            jdbc.update("update stock_reservations set expiry_review_at = created_at");
        } finally {
            jdbc.execute("alter table stock_reservations enable trigger trg_stock_reservations_guard");
        }
    }

    private void dueNow() {
        jdbc.update("update pos_fulfilments set next_attempt_at = now() - interval '1 minute' where status = 'PENDING'");
    }

    // ---- eligibility ---------------------------------------------------------------------------------------------------

    @Test
    void aSalePaidInFullThroughReconciledMoneyIsPostedOnceAsOneSaleMovementPerGoodsLine() {
        JsonNode sale = billedMixed();
        // Nothing is paid yet: nothing is posted, and the reservation is still just a reservation.
        assertThat(work().posted()).isZero();
        assertThat(saleMovements()).isEmpty();
        assertThat(view(sale).path("fulfilment").path("inventoryState").asString()).isEqualTo("NOT_POSTED");
        assertThat(view(sale).path("fulfilment").path("paymentState").asString()).isEqualTo("UNPAID");

        pay(sale, total(sale));
        // PAID is not "fulfilled": until the worker has run, nothing was deducted.
        JsonNode paid = view(sale);
        assertThat(paid.path("fulfilment").path("paymentState").asString()).isEqualTo("PAID");
        assertThat(paid.path("fulfilment").path("inventoryState").asString()).isEqualTo("NOT_POSTED");
        assertThat(onHand(rice)).isEqualByComparingTo("10000");

        var summary = work();
        assertThat(summary.posted()).isEqualTo(1);
        List<Map<String, Object>> movements = saleMovements();
        // The service has no stock: exactly two movements, one per GOODS line, the exact canonical quantities, posted by the system.
        assertThat(movements).hasSize(2);
        assertThat(movements.stream().map(m -> ((BigDecimal) m.get("quantity_delta")).stripTrailingZeros().toPlainString()).toList()).containsExactlyInAnyOrder("-2000", "-3");
        assertThat(movements).allSatisfy(m -> {
            assertThat(m.get("actor_user_id")).isNull();
            assertThat(m.get("reference")).isEqualTo(reference(sale));
            assertThat(m.get("reason").toString()).contains("Paid in full");
        });
        assertThat(onHand(rice)).isEqualByComparingTo("8000");
        assertThat(onHand(soda)).isEqualByComparingTo("97");
        assertThat(reserved(rice)).isEqualByComparingTo("0");
        assertThat(jdbc.queryForObject("select status from stock_reservations", String.class)).isEqualTo("FULFILLED");
        assertThat(fulfilmentStatus()).isEqualTo("POSTED");
        assertThat(count("pos_fulfilment_lines")).isEqualTo(2);
        assertThat(jdbc.queryForObject("select count(*) from audit_log where kind = 'POS_FULFILMENT_POSTED'", Integer.class)).isEqualTo(1);
        // The sale now shows four separate facts, and says plainly that handing the goods over is not recorded.
        JsonNode done = view(sale);
        JsonNode f = done.path("fulfilment");
        assertThat(f.path("paymentState").asString()).isEqualTo("PAID");
        assertThat(done.path("reservation").path("state").asString()).isEqualTo("FULFILLED");
        assertThat(f.path("inventoryState").asString()).isEqualTo("POSTED");
        assertThat(f.path("handover").asString()).isEqualTo("NOT_TRACKED");
        assertThat(f.path("note").asString()).contains("Handing the goods over is not recorded");
        assertThat(f.path("lines").size()).isEqualTo(2);
        assertThat(f.path("lines").get(0).path("physicalNow").asString()).isNotEmpty();
        // The invoice is still just PAID: that never means delivered.
        assertThat(paymentStatusOf(sale)).isEqualTo("PAID");
        // Running the worker again, and again, deducts nothing more.
        assertThat(work().posted()).isZero();
        assertThat(work().posted()).isZero();
        assertThat(saleMovements()).hasSize(2);
        assertThat(onHand(rice)).isEqualByComparingTo("8000");
        // The movements are in the inventory history, as OuPay itself.
        var history = w.owner.get("/api/v1/merchants/" + w.merchantId + "/inventory/movements?limit=50").json().path("items");
        List<String> actors = new ArrayList<>();
        history.forEach(m -> {
            if ("SALE".equals(m.path("movementType").asString())) {
                actors.add(m.path("actorName").asString());
            }
        });
        assertThat(actors).containsExactly("OuPay (verified payment)", "OuPay (verified payment)");
    }

    private String paymentStatusOf(JsonNode sale) {
        return w.owner.get("/api/v1/merchants/" + w.merchantId + "/invoices/" + sale.path("sale").path("invoiceId").asString()).json().path("paymentStatus").asString();
    }

    @Test
    void aPartialPaymentDeductsNothingAndTheRestCompletesIt() {
        JsonNode sale = billedMixed();
        pay(sale, total(sale) / 2);
        assertThat(work().posted()).isZero();
        assertThat(saleMovements()).isEmpty();
        assertThat(view(sale).path("fulfilment").path("paymentState").asString()).isEqualTo("PARTIAL");
        assertThat(onHand(rice)).isEqualByComparingTo("10000");
        pay(sale, total(sale) - total(sale) / 2);
        assertThat(work().posted()).isEqualTo(1);
        assertThat(saleMovements()).hasSize(2);
    }

    @Test
    void aConfirmedButUnmatchedPaymentDeductsNothing() {
        JsonNode sale = billedMixed();
        // The full amount, the right reference, but the wrong code: the bank confirmed money that R6d-B did not match to the sale.
        activeCode("Other", "EQ-LIVE-B2");
        w.bank.payWithCode("POSTED", total(sale), reference(sale), "EQ-LIVE-B2");
        assertThat(count("payment_allocations")).isZero();
        assertThat(work().posted()).isZero();
        assertThat(saleMovements()).isEmpty();
        assertThat(count("pos_fulfilments")).isZero();
        assertThat(onHand(rice)).isEqualByComparingTo("10000");
        assertThat(view(sale).path("fulfilment").path("paymentState").asString()).isEqualTo("UNPAID");
    }

    @Test
    void aReversalBeforePostingLeavesNothingToDo() {
        JsonNode sale = billedMixed();
        var delivery = w.bank.payWithCode("POSTED", total(sale), reference(sale), "EQ-LIVE-77");
        assertThat(w.bank.updateWithCode(delivery.transactionId(), "REVERSED", total(sale), reference(sale), "EQ-LIVE-77").outcome()).isEqualTo("APPLIED");
        assertThat(work().posted()).isZero();
        assertThat(saleMovements()).isEmpty();
        assertThat(view(sale).path("fulfilment").path("paymentState").asString()).isEqualTo("REVERSED");
    }

    // ---- exact quantities ------------------------------------------------------------------------------------------------

    @Test
    void unitsAndPackagesAreDeductedAsTheirExactCanonicalReservedQuantities() {
        live();
        JsonNode bag = packageOf(rice, "Bag", "5", "kg");
        JsonNode sale = billed(saveDraft(line(rice, "500", "g"), packageLine(rice, "1", bag), line(soda, "7", "pc"), line(repair, "1", "pc")));
        pay(sale, total(sale));
        assertThat(work().posted()).isEqualTo(1);
        // One movement per reservation line: 500 g, 5,000 g (one bag), 7 pieces: exactly what was reserved, nothing rounded.
        List<Map<String, Object>> movements = jdbc.queryForList("select m.quantity_delta, m.entered_as, m.balance_after, r.quantity from stock_movements m "
                + "join pos_fulfilment_lines p on p.movement_id = m.id join stock_reservation_lines r on r.id = p.reservation_line_id where m.movement_type = 'SALE' order by r.quantity");
        assertThat(movements).hasSize(3);
        for (Map<String, Object> m : movements) {
            assertThat((BigDecimal) m.get("quantity_delta")).isEqualByComparingTo(((BigDecimal) m.get("quantity")).negate());
        }
        assertThat(movements.stream().map(m -> m.get("entered_as").toString()).toList()).containsExactlyInAnyOrder("500 g", "1 x Bag", "7 pc");
        assertThat(onHand(rice)).isEqualByComparingTo("4500");
        assertThat(onHand(soda)).isEqualByComparingTo("93");
        // The running balance of the ledger agrees with the sum of its movements.
        assertThat(jdbc.queryForList("select b.id from inventory_balances b where b.quantity_on_hand <> coalesce((select sum(m.quantity_delta) from stock_movements m "
                + "where m.merchant_id = b.merchant_id and m.branch_id = b.branch_id and m.item_id = b.item_id), 0)", UUID.class)).isEmpty();
    }

    // ---- duplicates, retries, concurrency -----------------------------------------------------------------------------------

    @Test
    void duplicateBankEventsAndRepeatedWorkerRunsNeverDeductTwice() {
        JsonNode sale = billedMixed();
        var delivery = w.bank.payWithCode("POSTED", total(sale), reference(sale), "EQ-LIVE-77");
        assertThat(work().posted()).isEqualTo(1);
        // The same confirmed event arrives again (a duplicate webhook): it changes nothing, and nothing is posted again.
        w.bank.updateWithCode(delivery.transactionId(), "POSTED", total(sale), reference(sale), "EQ-LIVE-77");
        for (int i = 0; i < 3; i++) {
            assertThat(work().posted()).isZero();
        }
        assertThat(saleMovements()).hasSize(2);
        assertThat(onHand(rice)).isEqualByComparingTo("8000");
        assertThat(onHand(soda)).isEqualByComparingTo("97");
        assertThat(count("pos_fulfilment_lines")).isEqualTo(2);
    }

    @Test
    void manyWorkersRunningAtOnceDeductExactlyOnce() throws Exception {
        JsonNode sale = billedMixed();
        pay(sale, total(sale));
        List<Callable<PosFulfilmentService.Summary>> workers = new ArrayList<>();
        for (int i = 0; i < 8; i++) {
            workers.add(this::work);
        }
        List<PosFulfilmentService.Summary> results = concurrently(workers);
        assertThat(results.stream().mapToInt(PosFulfilmentService.Summary::posted).sum()).isEqualTo(1);
        assertThat(results.stream().mapToInt(PosFulfilmentService.Summary::failed).sum()).isZero();
        assertThat(saleMovements()).hasSize(2);
        assertThat(onHand(rice)).isEqualByComparingTo("8000");
        assertThat(onHand(soda)).isEqualByComparingTo("97");
        assertThat(fulfilmentStatus()).isEqualTo("POSTED");
    }

    @Test
    void severalPaidSalesOfTheSameGoodsArePostedConsistentlyWithoutNegativeStock() throws Exception {
        live();
        List<JsonNode> sales = new ArrayList<>();
        for (int i = 0; i < 3; i++) {
            sales.add(billed(saveDraft(line(rice, "3", "kg"), line(soda, "5", "pc"))));
        }
        for (JsonNode sale : sales) {
            pay(sale, total(sale));
        }
        List<Callable<PosFulfilmentService.Summary>> workers = new ArrayList<>();
        for (int i = 0; i < 4; i++) {
            workers.add(this::work);
        }
        concurrently(workers);
        assertThat(count("pos_fulfilments")).isEqualTo(3);
        assertThat(saleMovements()).hasSize(6);
        assertThat(onHand(rice)).isEqualByComparingTo("1000");
        assertThat(onHand(soda)).isEqualByComparingTo("85");
        assertThat(reserved(rice)).isEqualByComparingTo("0");
        assertThat(jdbc.queryForObject("select count(*) from inventory_balances where quantity_on_hand < 0", Integer.class)).isZero();
        assertThat(jdbc.queryForObject("select count(*) from stock_reservations where status = 'FULFILLED'", Integer.class)).isEqualTo(3);
    }

    // ---- atomicity, failure injection and recovery -------------------------------------------------------------------------

    private void failOn(String table, String condition) {
        jdbc.execute("create or replace function pos_test_fail() returns trigger as $$ begin if " + condition + " then raise exception 'injected failure at " + table
                + "'; end if; return new; end; $$ language plpgsql");
        jdbc.execute("create trigger trg_pos_test_fail before insert on " + table + " for each row execute function pos_test_fail()");
    }

    private void stopFailing(String table) {
        jdbc.execute("drop trigger if exists trg_pos_test_fail on " + table);
        jdbc.execute("drop function if exists pos_test_fail()");
    }

    @Test
    void aFailureAnywhereInAMultiLinePostingRollsEverythingBackAndALaterRetryPostsOnce() {
        JsonNode sale = billedMixed();
        pay(sale, total(sale));
        // The SECOND movement fails: the first movement, the reservation change and every posting roll back with it.
        failOn("stock_movements", "(select count(*) from stock_movements where movement_type = 'SALE') >= 1 and new.movement_type = 'SALE'");
        try {
            var summary = work();
            assertThat(summary.failed()).isEqualTo(1);
        } finally {
            stopFailing("stock_movements");
        }
        assertThat(saleMovements()).isEmpty();
        assertThat(count("pos_fulfilment_lines")).isZero();
        assertThat(jdbc.queryForObject("select status from stock_reservations", String.class)).isEqualTo("ACTIVE");
        assertThat(onHand(rice)).isEqualByComparingTo("10000");
        assertThat(onHand(soda)).isEqualByComparingTo("100");
        assertThat(reserved(rice)).isEqualByComparingTo("2000");
        // The failure is counted and backed off: it is NOT retried at once.
        assertThat(fulfilmentStatus()).isEqualTo("PENDING");
        assertThat(jdbc.queryForObject("select attempts from pos_fulfilments", Integer.class)).isEqualTo(1);
        assertThat(jdbc.queryForObject("select next_attempt_at > now() from pos_fulfilments", Boolean.class)).isTrue();
        assertThat(jdbc.queryForObject("select last_error from pos_fulfilments", String.class)).contains("injected failure");
        assertThat(work().posted()).isZero();
        // When it is due, with the fault gone, it posts, once (this is also what a crashed worker looks like after a restart).
        dueNow();
        assertThat(work().posted()).isEqualTo(1);
        assertThat(saleMovements()).hasSize(2);
        assertThat(onHand(rice)).isEqualByComparingTo("8000");
        assertThat(onHand(soda)).isEqualByComparingTo("97");
        assertThat(fulfilmentStatus()).isEqualTo("POSTED");
        assertThat(jdbc.queryForObject("select count(*) from pos_fulfilment_events where kind = 'ATTEMPT_FAILED'", Integer.class)).isEqualTo(1);
    }

    @Test
    void aPermanentFailureStopsRetryingAndBecomesAnExceptionThatNeedsAttention() {
        JsonNode sale = billedMixed();
        pay(sale, total(sale));
        failOn("pos_fulfilment_lines", "true");
        try {
            for (int i = 0; i < 3; i++) {
                assertThat(work().failed()).isEqualTo(1);
                dueNow();
            }
            // The last attempt made it an exception: no more automatic attempts, however often the worker runs.
            assertThat(fulfilmentStatus()).isEqualTo("EXCEPTION");
            assertThat(work().failed()).isZero();
            assertThat(work().posted()).isZero();
        } finally {
            stopFailing("pos_fulfilment_lines");
        }
        assertThat(jdbc.queryForObject("select attempts from pos_fulfilments", Integer.class)).isEqualTo(3);
        assertThat(jdbc.queryForObject("select kind from pos_fulfilment_exceptions", String.class)).isEqualTo("PROCESSING_FAILED");
        assertThat(saleMovements()).isEmpty();
        assertThat(jdbc.queryForObject("select status from stock_reservations", String.class)).isEqualTo("ACTIVE");
        // The verified payment is untouched, and an owner can see what needs attention.
        assertThat(paymentStatusOf(sale)).isEqualTo("PAID");
        var list = w.owner.get(pos() + "/fulfilment/exceptions");
        assertThat(list.status()).as(list.body()).isEqualTo(200);
        assertThat(list.json().size()).isEqualTo(1);
        assertThat(list.json().get(0).path("kind").asString()).isEqualTo("PROCESSING_FAILED");
        assertThat(list.json().get(0).path("saleReference").asString()).isEqualTo(reference(sale));
        assertThat(list.json().get(0).path("history").size()).isGreaterThanOrEqualTo(3);
    }

    @Test
    void theDatabaseItselfRefusesAnyDeductionThatIsNotAWholePostingOfItsReservation() {
        JsonNode sale = billedMixed();
        pay(sale, total(sale));
        // A SALE movement with no posting, a reservation fulfilled by hand, and a posting that is not its reservation line: all refused at commit.
        assertThatThrownBy(() -> jdbc.update("insert into stock_movements (id, merchant_id, branch_id, item_id, movement_type, quantity_delta, balance_after, reason, reference, "
                + "operation_id, request_sha256, created_at) values (gen_random_uuid(), ?, ?, ?::uuid, 'SALE', -1, 9999, 'by hand', 'X', gen_random_uuid(), repeat('a', 64), now())",
                w.merchantId, w.branchId, rice.path("id").asString())).hasMessageContaining("fulfilment posting");
        assertThat(onHand(rice)).isEqualByComparingTo("10000");
        assertThatThrownBy(() -> jdbc.update("update stock_reservations set status = 'FULFILLED', fulfilled_at = now()")).hasMessageContaining("posted fulfilment");
        assertThat(jdbc.queryForObject("select status from stock_reservations", String.class)).isEqualTo("ACTIVE");
        assertThat(work().posted()).isEqualTo(1);
        // A posted fulfilment, its postings, its movements and its history are final.
        assertThatThrownBy(() -> jdbc.update("update pos_fulfilments set status = 'PENDING'")).hasMessageContaining("final");
        assertThatThrownBy(() -> jdbc.update("delete from pos_fulfilments")).hasMessageContaining("never deleted");
        assertThatThrownBy(() -> jdbc.update("update pos_fulfilment_lines set quantity = 1")).hasMessageContaining("append-only");
        assertThatThrownBy(() -> jdbc.update("delete from pos_fulfilment_lines")).hasMessageContaining("append-only");
        assertThatThrownBy(() -> jdbc.update("delete from pos_fulfilment_events")).hasMessageContaining("append-only");
        assertThatThrownBy(() -> jdbc.update("delete from stock_movements where movement_type = 'SALE'")).hasMessageContaining("immutable");
        assertThatThrownBy(() -> jdbc.update("update stock_reservations set status = 'RELEASED', released_at = now(), released_by_user_id = ?, release_reason = 'trying to undo it'",
                w.ownerPerson.userId())).isNotNull();
    }

    // ---- late payment after release, reversal after posting ---------------------------------------------------------------------

    @Test
    void aPaymentAfterTheReservationWasReleasedNeverDeductsNeverReReservesAndBecomesAnException() {
        live();
        JsonNode sale = billed(saveDraft(line(rice, "4", "kg")));
        jdbc.update("update payment_requests set expires_at = now() - interval '2 hours'");
        makeReviewable();
        assertThat(w.owner.post(pos() + "/sales/" + saleId(sale) + "/release-reservation", Map.of("reason", "Customer abandoned the sale")).status()).isEqualTo(200);
        assertThat(reserved(rice)).isEqualByComparingTo("0");
        // The bank confirms the money after the release: R6d-B applies it to the sale. Fulfilment must NOT quietly deduct or re-reserve.
        pay(sale, total(sale));
        var summary = work();
        assertThat(summary.exceptions()).isEqualTo(1);
        assertThat(summary.posted()).isZero();
        assertThat(saleMovements()).isEmpty();
        assertThat(count("stock_reservations")).isEqualTo(1);
        assertThat(jdbc.queryForObject("select status from stock_reservations", String.class)).isEqualTo("RELEASED");
        assertThat(onHand(rice)).isEqualByComparingTo("10000");
        assertThat(reserved(rice)).isEqualByComparingTo("0");
        assertThat(fulfilmentStatus()).isEqualTo("EXCEPTION");
        // The verified payment and its allocation are preserved, and the sale says what happened.
        assertThat(paymentStatusOf(sale)).isEqualTo("PAID");
        assertThat(count("payment_allocations")).isEqualTo(1);
        JsonNode f = view(sale).path("fulfilment");
        assertThat(f.path("paymentState").asString()).isEqualTo("PAID");
        assertThat(f.path("inventoryState").asString()).isEqualTo("EXCEPTION");
        assertThat(f.path("exceptions").get(0).path("kind").asString()).isEqualTo("RESERVATION_RELEASED");
        // It is not retried by itself, and the exception is not opened twice.
        assertThat(work().exceptions()).isZero();
        assertThat(count("pos_fulfilment_exceptions")).isEqualTo(1);
        // Only the owner reads the list; it is read-only and keeps its history.
        JsonNode list = w.owner.get(pos() + "/fulfilment/exceptions").json();
        assertThat(list.size()).isEqualTo(1);
        assertThat(list.get(0).path("kind").asString()).isEqualTo("RESERVATION_RELEASED");
        assertThat(list.get(0).path("status").asString()).isEqualTo("OPEN");
        assertThat(w.manager.get(pos() + "/fulfilment/exceptions").status()).isEqualTo(403);
        assertThat(w.cashier.get(pos() + "/fulfilment/exceptions").status()).isEqualTo(403);
        assertThat(w.cafeOwner.get(pos() + "/fulfilment/exceptions").status()).isIn(403, 404);
        assertThat(w.cafeOwner.get("/api/v1/merchants/" + w.cafeMerchantId + "/pos/fulfilment/exceptions").json().size()).isZero();
        assertThat(jdbc.queryForObject("select count(*) from audit_log where kind = 'POS_FULFILMENT_EXCEPTION'", Integer.class)).isEqualTo(1);
    }

    @Test
    void aReversalAfterTheStockWasDeductedKeepsTheMovementsRestoresNothingAndRecordsAnException() {
        JsonNode sale = billedMixed();
        var delivery = w.bank.payWithCode("POSTED", total(sale), reference(sale), "EQ-LIVE-77");
        assertThat(work().posted()).isEqualTo(1);
        List<Map<String, Object>> before = saleMovements();
        assertThat(w.bank.updateWithCode(delivery.transactionId(), "REVERSED", total(sale), reference(sale), "EQ-LIVE-77").outcome()).isEqualTo("APPLIED");
        // The invoice is unpaid again (existing reversal accounting), but the SALE movements remain and stock is NOT put back.
        assertThat(paymentStatusOf(sale)).isEqualTo("UNPAID");
        var summary = work();
        assertThat(summary.reversals()).isEqualTo(1);
        assertThat(saleMovements()).isEqualTo(before);
        assertThat(onHand(rice)).isEqualByComparingTo("8000");
        assertThat(onHand(soda)).isEqualByComparingTo("97");
        assertThat(jdbc.queryForObject("select count(*) from stock_movements where quantity_delta > 0 and movement_type not in ('OPENING')", Integer.class)).isZero();
        assertThat(jdbc.queryForObject("select status from stock_reservations", String.class)).isEqualTo("FULFILLED");
        assertThat(fulfilmentStatus()).isEqualTo("POSTED");
        assertThat(jdbc.queryForObject("select kind from pos_fulfilment_exceptions", String.class)).isEqualTo("PAYMENT_REVERSED_AFTER_POSTING");
        JsonNode f = view(sale).path("fulfilment");
        assertThat(f.path("paymentState").asString()).isEqualTo("REVERSED");
        assertThat(f.path("inventoryState").asString()).isEqualTo("POSTED");
        assertThat(f.path("exceptions").get(0).path("kind").asString()).isEqualTo("PAYMENT_REVERSED_AFTER_POSTING");
        // Once only, however often it is looked at.
        assertThat(work().reversals()).isZero();
        assertThat(count("pos_fulfilment_exceptions")).isEqualTo(1);
        assertThat(w.owner.get(pos() + "/fulfilment/exceptions").json().get(0).path("kind").asString()).isEqualTo("PAYMENT_REVERSED_AFTER_POSTING");
    }

    @Test
    void paidAndReleaseRacingFulfilmentNeverCorruptsStockOrReservations() throws Exception {
        live();
        JsonNode sale = billed(saveDraft(line(rice, "4", "kg")));
        jdbc.update("update payment_requests set expires_at = now() - interval '2 hours'");
        makeReviewable();
        pay(sale, total(sale));
        // Once the payment is applied a release is refused; racing it with the worker still posts exactly once.
        List<Callable<Object>> race = new ArrayList<>();
        for (int i = 0; i < 3; i++) {
            race.add(() -> w.owner.post(pos() + "/sales/" + saleId(sale) + "/release-reservation", Map.of("reason", "Customer abandoned the sale")));
            race.add(this::work);
        }
        List<Object> results = concurrently(race);
        for (Object r : results) {
            if (r instanceof TestApi.Response response) {
                assertThat(response.status()).isEqualTo(409);
                assertThat(response.code()).isIn("release_blocked_payment_evidence", "reservation_not_active");
            }
        }
        assertThat(saleMovements()).hasSize(1);
        assertThat(onHand(rice)).isEqualByComparingTo("6000");
        assertThat(jdbc.queryForObject("select status from stock_reservations", String.class)).isEqualTo("FULFILLED");
        assertThat(jdbc.queryForObject("select count(*) from audit_log where kind = 'POS_RESERVATION_RELEASED'", Integer.class)).isZero();
    }

    @Test
    void aStockAdjustmentRacingTheFulfilmentNeverBreaksTheLedger() throws Exception {
        live();
        JsonNode sale = billed(saveDraft(line(rice, "4", "kg")));
        pay(sale, total(sale));
        List<Callable<Object>> race = new ArrayList<>();
        race.add(this::work);
        race.add(() -> adjustOut(rice, "6", "kg"));
        race.add(() -> adjustOut(rice, "1", "kg"));
        concurrently(race);
        // 10 kg, 4 kg reserved and then fulfilled: at most 6 kg could ever be adjusted away. Whatever order they ran in, nothing is negative.
        assertThat(onHand(rice)).isGreaterThanOrEqualTo(BigDecimal.ZERO);
        assertThat(onHand(rice).subtract(reserved(rice))).isGreaterThanOrEqualTo(BigDecimal.ZERO);
        assertThat(saleMovements()).hasSize(1);
        assertThat(jdbc.queryForList("select b.id from inventory_balances b where b.quantity_on_hand <> coalesce((select sum(m.quantity_delta) from stock_movements m "
                + "where m.merchant_id = b.merchant_id and m.branch_id = b.branch_id and m.item_id = b.item_id), 0)", UUID.class)).isEmpty();
    }

    @Test
    void physicalStockThatCanNoLongerCoverAPaidSaleBecomesAnExceptionAndNothingIsDeducted() {
        live();
        JsonNode sale = billed(saveDraft(line(rice, "4", "kg")));
        pay(sale, total(sale));
        // The database makes this impossible through every normal path; force it by switching one guard off for one raw movement.
        jdbc.execute("alter table inventory_balances disable trigger trg_inventory_balances_reserved");
        try {
            jdbc.update("insert into stock_movements (id, merchant_id, branch_id, item_id, movement_type, quantity_delta, balance_after, reason, operation_id, request_sha256, actor_user_id, created_at) "
                    + "values (gen_random_uuid(), ?, ?, ?::uuid, 'ADJUST_OUT', -7000, 3000, 'Forced for the test', gen_random_uuid(), repeat('b', 64), ?, now())",
                    w.merchantId, w.branchId, rice.path("id").asString(), w.ownerPerson.userId());
        } finally {
            jdbc.execute("alter table inventory_balances enable trigger trg_inventory_balances_reserved");
        }
        assertThat(work().exceptions()).isEqualTo(1);
        assertThat(saleMovements()).isEmpty();
        assertThat(jdbc.queryForObject("select kind from pos_fulfilment_exceptions", String.class)).isEqualTo("INSUFFICIENT_STOCK");
        assertThat(jdbc.queryForObject("select status from stock_reservations", String.class)).isEqualTo("ACTIVE");
        assertThat(onHand(rice)).isEqualByComparingTo("3000");
    }

    // ---- demonstration and isolation --------------------------------------------------------------------------------------------

    @Test
    void aDemonstrationSaleNeverCreatesAFulfilmentAMovementOrAReservation() {
        demo();
        JsonNode sale = billed(saveDraft(line(rice, "2", "kg"), line(repair, "1", "pc")));
        // Even real bank money naming a demonstration is refused by the ledger, and the worker has nothing to do.
        w.bank.pay("POSTED", total(sale), reference(sale));
        assertThat(count("payment_allocations")).isZero();
        assertThat(work().posted()).isZero();
        assertThat(count("pos_fulfilments")).isZero();
        assertThat(count("stock_reservations")).isZero();
        assertThat(saleMovements()).isEmpty();
        assertThat(onHand(rice)).isEqualByComparingTo("10000");
        JsonNode f = view(sale).path("fulfilment");
        assertThat(f.path("paymentState").asString()).isEqualTo("NOT_APPLICABLE");
        assertThat(f.path("inventoryState").asString()).isEqualTo("NOT_APPLICABLE");
        assertThat(f.path("note").asString()).contains("DEMONSTRATION");
    }

    @Test
    void salesOfOtherBusinessesAndBranchesAreNeverPostedOrShown() {
        JsonNode sale = billedMixed();
        pay(sale, total(sale));
        assertThat(work().posted()).isEqualTo(1);
        // Every movement is at the sale's own branch and business; another cashier or another business can not read the sale or its fulfilment.
        assertThat(jdbc.queryForObject("select count(*) from stock_movements where movement_type = 'SALE' and (merchant_id <> ? or branch_id <> ?)", Integer.class,
                w.merchantId, w.branchId)).isZero();
        assertThat(w.otherCashier.get(pos() + "/sales/" + saleId(sale)).status()).isEqualTo(404);
        assertThat(w.cafeOwner.get(pos() + "/sales/" + saleId(sale)).status()).isIn(403, 404);
        assertThat(w.cafeOwner.get("/api/v1/merchants/" + w.cafeMerchantId + "/pos/sales/" + saleId(sale)).status()).isEqualTo(404);
    }
}
