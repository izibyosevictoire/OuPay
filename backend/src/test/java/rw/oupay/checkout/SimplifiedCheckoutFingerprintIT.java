package rw.oupay.checkout;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;
import org.springframework.http.HttpMethod;

/**
 * What makes two checkout requests "the same sale" (R3's durable fingerprint, as the simplified checkout uses it), including a
 * retry across midnight, driven by a clock the test controls.
 */
class SimplifiedCheckoutFingerprintIT extends CheckoutTestSupport {

    private static final ZoneId KIGALI = ZoneId.of("Africa/Kigali");
    private static final AtomicReference<Instant> NOW = new AtomicReference<>();

    /** A clock whose time the test moves; every zone view shares the same instant. */
    static final class MovableClock extends Clock {
        private final ZoneId zone;

        MovableClock(ZoneId zone) {
            this.zone = zone;
        }

        @Override
        public ZoneId getZone() {
            return zone;
        }

        @Override
        public Clock withZone(ZoneId other) {
            return new MovableClock(other);
        }

        @Override
        public Instant instant() {
            return NOW.get();
        }
    }

    @TestConfiguration
    static class Clocks {
        @Bean
        @Primary
        Clock movableClock() {
            return new MovableClock(ZoneId.of("UTC"));
        }
    }

    private LocalDate kigaliToday;

    @Override
    void beforeWorld() {
        // Tomorrow's midnight (a moment in the near future, so sessions and links behave normally), minus ten minutes.
        kigaliToday = LocalDate.now(KIGALI).plusDays(1);
        NOW.set(kigaliToday.plusDays(1).atStartOfDay(KIGALI).toInstant().minus(Duration.ofMinutes(10)));
    }

    private void advance(Duration by) {
        NOW.set(NOW.get().plus(by));
    }

    @Test
    void aRetryAcrossMidnightReturnsTheOriginalSaleWhetherOrNotTheKeyRecordSurvived() {
        ensureProfile();
        UUID clientRequestId = UUID.randomUUID();
        var body = sale(14_000, "Moto ride", clientRequestId);
        var first = bill(w.cashier, "key-midnight-001", body);
        assertThat(first.status()).as(first.body()).isEqualTo(201);
        UUID invoiceId = UUID.fromString(first.json().path("invoiceId").asString());
        assertThat(jdbc.queryForObject("select due_on from invoices where id = ?", LocalDate.class, invoiceId)).isEqualTo(kigaliToday);

        advance(Duration.ofMinutes(20)); // it is now the next day in Kigali, and the request (30 minutes) is still open

        var sameKey = bill(w.cashier, "key-midnight-001", body);
        assertThat(sameKey.status()).isEqualTo(200);
        assertThat(sameKey.json().path("invoiceId").asString()).isEqualTo(invoiceId.toString());

        jdbc.update("delete from idempotency_keys");
        var newKey = bill(w.cashier, "key-midnight-002", body);
        assertThat(newKey.status()).as(newKey.body()).isEqualTo(200);
        assertThat(newKey.json().path("invoiceId").asString()).isEqualTo(invoiceId.toString());
        assertThat(newKey.json().path("paymentRequestId").asString()).isEqualTo(first.json().path("paymentRequestId").asString());

        // The sale keeps its own date; nothing was created or changed by the retries.
        assertThat(jdbc.queryForObject("select due_on from invoices where id = ?", LocalDate.class, invoiceId)).isEqualTo(kigaliToday);
        assertThat(count("invoices")).isEqualTo(1);
        assertThat(count("payment_requests")).isEqualTo(1);
    }

    @Test
    void replayingAfterTheRequestExpiredReturnsTheSameExpiredRequestAndOpensNoReplacement() {
        ensureProfile();
        var body = sale(14_000, null, UUID.randomUUID());
        var first = bill(w.cashier, "key-expired-0001", body);
        assertThat(first.status()).isEqualTo(201);

        advance(Duration.ofMinutes(45)); // past the 30-minute lifetime
        w.cashier = fixtures.signIn(mvc, w.cashierPerson); // the earlier session has lapsed in this much time
        jdbc.update("delete from idempotency_keys");
        for (String key : new String[] {"key-expired-0001", "key-expired-0002"}) {
            var again = bill(w.cashier, key, body);
            assertThat(again.status()).isEqualTo(200);
            assertThat(again.json().path("paymentRequestId").asString()).isEqualTo(first.json().path("paymentRequestId").asString());
            assertThat(again.json().path("status").asString()).isEqualTo("EXPIRED");
        }
        assertThat(count("payment_requests")).isEqualTo(1);
        assertThat(count("invoices")).isEqualTo(1);
    }

    @Test
    void everyFinanciallyMeaningfulInputBelongsToTheFingerprint() {
        ensureProfile();
        UUID second = fixtures.branch(w.merchantId, "RM02", "ACTIVE");
        fixtures.assign(w.merchantId, w.cashierMembershipId, second);
        UUID clientRequestId = UUID.randomUUID();
        Map<String, Object> original = sale(9_000, "Moto ride", clientRequestId);
        original.put("branchId", w.branchId.toString());
        assertThat(bill(w.cashier, "key-fp-00000001", original).status()).isEqualTo(201);

        // The amount, the description and the branch.
        var amount = sale(9_001, "Moto ride", clientRequestId);
        amount.put("branchId", w.branchId.toString());
        var description = sale(9_000, "Taxi", clientRequestId);
        description.put("branchId", w.branchId.toString());
        var branch = sale(9_000, "Moto ride", clientRequestId);
        branch.put("branchId", second.toString());
        int n = 2;
        for (Map<String, Object> changed : java.util.List.of(amount, description, branch)) {
            var response = bill(w.cashier, "key-fp-0000000" + n++, changed);
            assertThat(response.status()).as(response.body()).isEqualTo(409);
            assertThat(response.code()).isEqualTo("client_request_id_reuse");
        }

        // The person: another cashier or a manager (who works at the same branch) cannot retrieve the sale by its identifier.
        for (var other : new rw.oupay.support.TestApi[] {w.otherCashier, w.manager}) {
            var response = bill(other, "key-fp-other-" + n++ + "0", original);
            assertThat(response.status()).isEqualTo(409);
            assertThat(response.code()).isEqualTo("client_request_id_reuse");
            assertThat(response.body()).doesNotContain(w.cashierPerson.userId().toString());
        }

        // The business: the same identifier in another business is simply another sale (there it is not even available).
        setMode(w.cafeMerchantId, "SIMPLIFIED");
        var cafe = w.cafeOwner.send(HttpMethod.POST, "/api/v1/merchants/" + w.cafeMerchantId + "/checkout/simple", original,
                Map.of("Idempotency-Key", "key-fp-cafe-0001"));
        assertThat(cafe.status()).isNotEqualTo(200).isNotEqualTo(201);
        assertThat(cafe.body()).doesNotContain("invoiceId");

        // The mode: a business that has gone back to business mode does not hand the sale out either.
        setMode(w.merchantId, "BUSINESS");
        var business = bill(w.cashier, "key-fp-00000009", original);
        assertThat(business.status()).isEqualTo(409);
        assertThat(business.code()).isEqualTo("checkout_not_available");
        setMode(w.merchantId, "SIMPLIFIED");
        assertThat(bill(w.cashier, "key-fp-00000010", original).status()).isEqualTo(200);

        assertThat(count("invoices")).isEqualTo(1);
        assertThat(count("payment_requests")).isEqualTo(1);
    }

    @Test
    void aClientCannotInjectTheFingerprintOrTheFieldsTheServerDerives() {
        ensureProfile();
        UUID clientRequestId = UUID.randomUUID();
        Map<String, Object> body = sale(7_000, "Moto ride", clientRequestId);
        body.put("clientRequestSha256", "b".repeat(64));
        body.put("dueAt", LocalDate.now().plusDays(90).toString());
        body.put("saleChannel", "POS");
        body.put("createdByUserId", w.ownerPerson.userId().toString());
        body.put("assignedToUserId", w.otherCashierPerson.userId().toString());
        var created = bill(w.cashier, "key-inject-00001", body);
        assertThat(created.status()).as(created.body()).isEqualTo(201);

        var row = jdbc.queryForMap("select client_request_sha256, due_on, sale_channel, created_by_user_id, assigned_to_user_id from invoices");
        assertThat(row.get("client_request_sha256")).isNotEqualTo("b".repeat(64)).asString().matches("^[0-9a-f]{64}$");
        assertThat(row.get("due_on").toString()).isEqualTo(kigaliToday.toString());
        assertThat(row.get("sale_channel")).isEqualTo("SIMPLIFIED");
        assertThat(row.get("created_by_user_id")).isEqualTo(w.cashierPerson.userId());
        assertThat(row.get("assigned_to_user_id")).isEqualTo(w.cashierPerson.userId());

        // The fields a client may NOT supply do not change what counts as the same sale: the identical request without them is it.
        var plain = bill(w.cashier, "key-inject-00002", sale(7_000, "Moto ride", clientRequestId));
        assertThat(plain.status()).isEqualTo(200);
        assertThat(plain.json().path("invoiceId").asString()).isEqualTo(created.json().path("invoiceId").asString());
    }
}
