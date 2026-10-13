package rw.oupay.common;

import static org.assertj.core.api.Assertions.assertThat;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import rw.oupay.support.IntegrationTest;
import rw.oupay.support.TestApi;
import rw.oupay.support.World;
import tools.jackson.databind.JsonNode;

/** Deterministic keyset pagination: no row is skipped or repeated, ties are broken by id, scope and tenancy are kept. */
class PaginationIT extends IntegrationTest {

    World w;

    @BeforeEach
    void world() {
        w = World.create(this);
    }

    private String m(String path) {
        return "/api/v1/merchants/" + w.merchantId + path;
    }

    /** Follows nextCursor until it runs out; returns the ids in the order they were delivered. */
    private List<String> walk(TestApi api, String url, int limit, String idField) {
        List<String> ids = new ArrayList<>();
        String cursor = null;
        int pages = 0;
        do {
            String separator = url.contains("?") ? "&" : "?";
            var response = api.get(url + separator + "limit=" + limit + (cursor == null ? "" : "&cursor=" + cursor));
            assertThat(response.status()).isEqualTo(200);
            JsonNode items = response.json().path("items");
            assertThat(items.size()).isLessThanOrEqualTo(limit);
            items.forEach(item -> ids.add(item.path(idField).asString()));
            JsonNode next = response.json().path("nextCursor");
            cursor = next.isMissingNode() || next.isNull() ? null : next.asString();
            if (cursor != null) {
                assertThat(items.size()).as("a page with a successor is full").isEqualTo(limit);
            }
            assertThat(++pages).as("terminates").isLessThan(100);
        } while (cursor != null);
        return ids;
    }

    private void createDraft(int n) {
        for (int i = 0; i < n; i++) {
            assertThat(w.owner.post(m("/invoices"), w.draft(w.cashierPerson.userId(), 1_000 + i)).status()).isEqualTo(201);
        }
    }

    // ---- invoices ------------------------------------------------------------------------------

    @Test
    void invoicesArePagedWithoutGapsOrRepeatsInNewestFirstOrder() {
        createDraft(7);
        var all = jdbc.queryForList("select id::text from invoices where merchant_id = ? order by created_at desc, id desc", String.class, w.merchantId);
        assertThat(all).hasSize(7);
        for (int size : new int[] {1, 2, 3, 7, 50}) {
            assertThat(walk(w.owner, m("/invoices"), size, "id")).as("page size " + size).containsExactlyElementsOf(all);
        }
        var first = w.owner.get(m("/invoices?limit=3")).json();
        assertThat(first.path("totalCount").asLong()).isEqualTo(7);
        assertThat(first.path("items").size()).isEqualTo(3);
        assertThat(first.path("nextCursor").asString()).isNotBlank();
    }

    @Test
    void theDefaultLimitAppliesAndExcessiveLimitsAreCapped() {
        createDraft(3);
        var byDefault = w.owner.get(m("/invoices")).json();
        assertThat(byDefault.path("items").size()).isEqualTo(3);
        assertThat(byDefault.path("nextCursor").isMissingNode() || byDefault.path("nextCursor").isNull()).isTrue();
        assertThat(w.owner.get(m("/invoices?limit=0")).json().path("items").size()).isEqualTo(3);
        assertThat(w.owner.get(m("/invoices?limit=-5")).json().path("items").size()).isEqualTo(3);
        assertThat(w.owner.get(m("/invoices?limit=100000")).status()).isEqualTo(200);
        assertThat(Pagination.limit(100_000)).isEqualTo(Pagination.MAX_LIMIT);
        assertThat(Pagination.limit(null)).isEqualTo(Pagination.DEFAULT_LIMIT);
    }

    @Test
    void malformedCursorsAreBadRequestsNeverServerErrors() {
        for (String cursor : new String[] {"garbage", "!!!", "MTIz", "", "AAAA", "x".repeat(500)}) {
            var response = w.owner.get(m("/invoices?cursor=" + cursor));
            if (!cursor.isEmpty()) {
                assertThat(response.status()).as(cursor).isEqualTo(400);
                assertThat(response.code()).isEqualTo("bad_request");
            }
        }
        assertThat(w.owner.get(m("/audit-log?cursor=abc")).status()).isEqualTo(400);
        assertThat(w.owner.get(m("/bank-transactions?cursor=abc")).status()).isEqualTo(400);
        assertThat(w.owner.get(m("/notifications?cursor=abc")).status()).isEqualTo(400);
        assertThat(w.owner.get(m("/payment-allocations?cursor=abc")).status()).isEqualTo(400);
    }

    @Test
    void aCashierPagesOnlyTheirOwnInvoicesAndTheTotalReflectsThat() {
        createDraft(4);
        assertThat(w.owner.post(m("/invoices"), w.draft(w.otherCashierPerson.userId(), 5_000)).status()).isEqualTo(201);
        var mine = walk(w.cashier, m("/invoices"), 2, "id");
        assertThat(mine).hasSize(4);
        assertThat(w.cashier.get(m("/invoices?limit=2")).json().path("totalCount").asLong()).isEqualTo(4);
        assertThat(walk(w.owner, m("/invoices"), 2, "id")).hasSize(5);
    }

    @Test
    void aCursorFromOneBusinessRevealsNothingOfAnother() {
        createDraft(3);
        String cursor = w.owner.get(m("/invoices?limit=1")).json().path("nextCursor").asString();
        var cafe = w.cafeOwner.get("/api/v1/merchants/" + w.cafeMerchantId + "/invoices?cursor=" + cursor);
        assertThat(cafe.status()).isEqualTo(200);
        assertThat(cafe.json().path("items").size()).isZero();
        // And it cannot be used against the shop by someone who is not a member.
        assertThat(w.cafeOwner.get(m("/invoices?cursor=" + cursor)).status()).isEqualTo(404);
    }

    // ---- ties and concurrent inserts -----------------------------------------------------------

    @Test
    void rowsWithTheSameTimestampAreOrderedByIdSoPagingIsStillExact() {
        Timestamp same = Timestamp.from(Instant.parse("2026-10-12T10:00:00Z"));
        for (int i = 0; i < 7; i++) {
            jdbc.update("insert into notifications (id, merchant_id, recipient_user_id, kind, title, body, dedupe_key, created_at) "
                            + "values (gen_random_uuid(), ?, ?, 'PAYMENT_MATCHED', 't', 'b', ?, ?)",
                    w.merchantId, w.cashierPerson.userId(), "tie-" + i, same);
        }
        var expected = jdbc.queryForList("select id::text from notifications where recipient_user_id = ? order by created_at desc, id desc",
                String.class, w.cashierPerson.userId());
        assertThat(expected).hasSize(7);
        for (int size : new int[] {1, 2, 3, 4}) {
            assertThat(walk(w.cashier, m("/notifications"), size, "id")).as("page size " + size).containsExactlyElementsOf(expected);
        }
    }

    @Test
    void newRowsArrivingWhileSomeoneIsPagingNeverCauseRepeatsOrGaps() {
        for (int i = 0; i < 6; i++) {
            jdbc.update("insert into notifications (id, merchant_id, recipient_user_id, kind, title, body, dedupe_key, created_at) "
                            + "values (gen_random_uuid(), ?, ?, 'PAYMENT_MATCHED', 't', 'b', ?, now() - (? * interval '1 minute'))",
                    w.merchantId, w.cashierPerson.userId(), "old-" + i, i + 1);
        }
        var firstPage = w.cashier.get(m("/notifications?limit=3")).json();
        List<String> seen = new ArrayList<>();
        firstPage.path("items").forEach(i -> seen.add(i.path("id").asString()));
        // Something newer arrives between page one and page two. OFFSET paging would now repeat a row.
        jdbc.update("insert into notifications (id, merchant_id, recipient_user_id, kind, title, body, dedupe_key, created_at) "
                + "values (gen_random_uuid(), ?, ?, 'PAYMENT_MATCHED', 't', 'b', 'late', now())", w.merchantId, w.cashierPerson.userId());
        var second = w.cashier.get(m("/notifications?limit=3&cursor=" + firstPage.path("nextCursor").asString())).json();
        second.path("items").forEach(i -> seen.add(i.path("id").asString()));
        assertThat(seen).hasSize(6).doesNotHaveDuplicates();
        var olderSix = jdbc.queryForList("select id::text from notifications where dedupe_key like 'old-%' order by created_at desc, id desc", String.class);
        assertThat(seen).containsExactlyElementsOf(olderSix);
    }

    // ---- ledger lists --------------------------------------------------------------------------

    @Test
    void bankTransactionsArePagedAndCashiersSeeOnlyMoneyAppliedToTheirInvoices() {
        UUID mine = w.issuedInvoice(10_000);
        String number = jdbc.queryForObject("select invoice_number from invoices where id = ?", String.class, mine);
        w.bank.pay("POSTED", 2_000, number);
        w.bank.pay("POSTED", 3_000, number);
        for (int i = 0; i < 4; i++) {
            w.bank.pay("POSTED", 1_000 + i, "UNKNOWN-REF-" + i);
        }
        var expectedAll = jdbc.queryForList("select id::text from bank_transactions where merchant_id = ? order by provider_occurred_at desc, id desc",
                String.class, w.merchantId);
        assertThat(expectedAll).hasSize(6);
        assertThat(walk(w.owner, m("/bank-transactions"), 2, "id")).containsExactlyElementsOf(expectedAll);
        assertThat(walk(w.manager, m("/bank-transactions"), 4, "id")).containsExactlyElementsOf(expectedAll);
        // The cashier's pages contain exactly the two matched payments, in order, whatever the page size.
        var expectedMine = jdbc.queryForList("select id::text from bank_transactions where merchant_id = ? and payment_reference = ? "
                + "order by provider_occurred_at desc, id desc", String.class, w.merchantId, number);
        assertThat(expectedMine).hasSize(2);
        assertThat(walk(w.cashier, m("/bank-transactions"), 1, "id")).containsExactlyElementsOf(expectedMine);
        assertThat(walk(w.otherCashier, m("/bank-transactions"), 1, "id")).isEmpty();
    }

    @Test
    void allocationsArePagedInTheSameWay() {
        for (int i = 0; i < 5; i++) {
            UUID invoice = w.issuedInvoice(5_000 + i);
            w.bank.pay("POSTED", 5_000 + i, jdbc.queryForObject("select invoice_number from invoices where id = ?", String.class, invoice));
        }
        var expected = jdbc.queryForList("select id::text from payment_allocations where merchant_id = ? order by created_at desc, id desc",
                String.class, w.merchantId);
        assertThat(expected).hasSize(5);
        assertThat(walk(w.owner, m("/payment-allocations"), 2, "id")).containsExactlyElementsOf(expected);
        assertThat(walk(w.cashier, m("/payment-allocations"), 2, "id")).containsExactlyElementsOf(expected);
        assertThat(walk(w.otherCashier, m("/payment-allocations"), 2, "id")).isEmpty();
    }

    @Test
    void theAuditLogIsPagedNewestFirstByItsSequenceNumber() {
        createDraft(6);
        var expected = jdbc.queryForList("select id from audit_log where merchant_id = ? order by id desc", Long.class, w.merchantId).stream().map(String::valueOf).toList();
        assertThat(expected.size()).isGreaterThan(6);
        assertThat(walk(w.owner, m("/audit-log"), 4, "id")).containsExactlyElementsOf(expected);
        assertThat(walk(w.manager, m("/audit-log"), 200, "id")).containsExactlyElementsOf(expected);
        assertThat(w.cashier.get(m("/audit-log")).status()).isEqualTo(403);
    }
}
