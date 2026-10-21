package rw.oupay.checkout;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.Callable;
import org.junit.jupiter.api.Test;
import rw.oupay.support.TestApi;

/**
 * The checkout is ONE transaction. Faults are injected with database triggers at every stage after the idempotency claim, and each
 * must leave nothing at all behind: no record of the key, no invoice, no number taken, no payment request, no audit entry.
 */
class SimplifiedCheckoutAtomicityIT extends CheckoutTestSupport {

    private static final String AUDIT_KINDS = "('SIMPLE_CHECKOUT_BILLED', 'INVOICE_ISSUED', 'INVOICE_DRAFT_CREATED', 'PAYMENT_REQUEST_CREATED')";

    /** Runs the work with a trigger that makes the given insert fail. */
    private void withFailureOn(String table, String condition, Runnable work) {
        jdbc.execute("create function r4_inject_failure() returns trigger as $$ begin raise exception 'injected failure'; end $$ language plpgsql");
        jdbc.execute("create trigger r4_inject_failure before insert on " + table + " for each row "
                + (condition == null ? "" : "when (" + condition + ") ") + "execute function r4_inject_failure()");
        try {
            work.run();
        } finally {
            jdbc.execute("drop trigger r4_inject_failure on " + table);
            jdbc.execute("drop function r4_inject_failure()");
        }
    }

    private void assertNothingLeftBehind() {
        assertThat(count("invoices")).isZero();
        assertThat(count("invoice_items")).isZero();
        assertThat(count("payment_requests")).isZero();
        assertThat(count("idempotency_keys")).isZero();
        assertThat(count("invoice_number_sequences")).isZero();
        assertThat(jdbc.queryForObject("select count(*) from audit_log where kind in " + AUDIT_KINDS, Integer.class)).isZero();
    }

    private void assertExactlyOneCompleteSale(String invoiceNumber) {
        assertThat(count("invoices")).isEqualTo(1);
        assertThat(count("payment_requests")).isEqualTo(1);
        assertThat(count("idempotency_keys")).isEqualTo(1);
        assertThat(jdbc.queryForObject("select invoice_number from invoices", String.class)).isEqualTo(invoiceNumber);
        assertThat(jdbc.queryForObject("select status from invoices", String.class)).isEqualTo("ISSUED");
        assertThat(jdbc.queryForObject("select count(*) from audit_log where kind in " + AUDIT_KINDS, Integer.class)).isEqualTo(4);
    }

    @Test
    void aFailureAtAnyStageRollsBackTheWholeSaleAndTheSameRequestThenSucceedsOnce() {
        ensureProfile();
        var body = sale(18_000, "Moto ride", UUID.randomUUID());
        String[][] stages = {
                {"audit_log", "new.kind = 'INVOICE_DRAFT_CREATED'"},
                {"audit_log", "new.kind = 'INVOICE_ISSUED'"},
                {"payment_requests", null},
                {"audit_log", "new.kind = 'PAYMENT_REQUEST_CREATED'"},
                {"audit_log", "new.kind = 'SIMPLE_CHECKOUT_BILLED'"},
        };
        for (String[] stage : stages) {
            withFailureOn(stage[0], stage[1], () -> {
                var failed = bill(w.cashier, "key-atomic-0001", body);
                assertThat(failed.status()).as(stage[0] + " " + stage[1] + ": " + failed.body()).isGreaterThanOrEqualTo(400);
                assertNothingLeftBehind();
            });
        }
        // With the fault gone, the very same request (same key, same sale) succeeds exactly once, with the first invoice number.
        var ok = bill(w.cashier, "key-atomic-0001", body);
        assertThat(ok.status()).as(ok.body()).isEqualTo(201);
        assertThat(ok.json().path("invoiceNumber").asString()).isEqualTo("INV-0001");
        assertExactlyOneCompleteSale("INV-0001");
    }

    @Test
    void aSuccessfulAnswerIsOnlyEverGivenForCommittedData() {
        ensureProfile();
        var response = bill(w.cashier, "key-commit-0001", sale(6_000, null, UUID.randomUUID()));
        assertThat(response.status()).isEqualTo(201);
        // The test's own connection is a different session: it sees exactly what has been COMMITTED.
        UUID invoiceId = UUID.fromString(response.json().path("invoiceId").asString());
        assertThat(jdbc.queryForObject("select status from invoices where id = ?", String.class, invoiceId)).isEqualTo("ISSUED");
        assertThat(jdbc.queryForObject("select count(*) from payment_requests where id = cast(? as uuid)", Integer.class,
                response.json().path("paymentRequestId").asString())).isEqualTo(1);
        assertThat(jdbc.queryForObject("select result_entity_id from idempotency_keys where idem_key = 'key-commit-0001'", UUID.class))
                .isEqualTo(invoiceId);
    }

    @Test
    void aFailedSetupCheckCreatesNoPartialSaleAndFixingItLetsTheSameRequestThrough() {
        var body = sale(5_000, null, UUID.randomUUID());
        // No payment link at all.
        assertThat(bill(w.cashier, "key-setup-00001", body).code()).isEqualTo("no_active_profile");
        assertNothingLeftBehind();
        // A link whose bank connection is not connected.
        ensureProfile();
        jdbc.update("update bank_connections set status = 'DISABLED' where merchant_id = ?", w.merchantId);
        assertThat(bill(w.cashier, "key-setup-00001", body).code()).isEqualTo("no_active_profile");
        assertNothingLeftBehind();
        // A link that is switched off, or replaced.
        jdbc.update("update bank_connections set status = 'CONNECTED' where merchant_id = ?", w.merchantId);
        for (String status : new String[] {"INACTIVE", "REVOKED"}) {
            jdbc.update("update payment_profiles set status = ?", status);
            assertThat(bill(w.cashier, "key-setup-00001", body).code()).as(status).isEqualTo("no_active_profile");
            assertNothingLeftBehind();
        }
        jdbc.update("update payment_profiles set status = 'ACTIVE'");
        assertThat(bill(w.cashier, "key-setup-00001", body).status()).isEqualTo(201);
        assertExactlyOneCompleteSale("INV-0001");
    }

    @Test
    void concurrentRetriesAfterTheKeyRecordsWereDeletedStillMakeOneSale() throws Exception {
        ensureProfile();
        var body = sale(11_000, "Moto ride", UUID.randomUUID());
        var first = bill(w.cashier, "key-race-000000", body);
        assertThat(first.status()).isEqualTo(201);
        jdbc.update("delete from idempotency_keys");
        List<Callable<TestApi.Response>> tasks = new ArrayList<>();
        for (int i = 0; i < 10; i++) {
            TestApi client = fixtures.signIn(mvc, w.cashierPerson);
            String key = "key-race-after-" + i + "-0";
            tasks.add(() -> bill(client, key, body));
        }
        var results = concurrently(tasks);
        assertThat(results).allMatch(r -> r.status() == 200);
        assertThat(results.stream().map(r -> r.json().path("invoiceId").asString()).distinct())
                .containsExactly(first.json().path("invoiceId").asString());
        assertThat(count("invoices")).isEqualTo(1);
        assertThat(count("payment_requests")).isEqualTo(1);
    }
}
