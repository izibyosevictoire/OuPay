package rw.oupay.banking;

import static org.assertj.core.api.Assertions.assertThat;

import io.micrometer.core.instrument.MeterRegistry;
import java.time.Instant;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import rw.oupay.support.Bank;
import rw.oupay.support.IntegrationTest;
import rw.oupay.support.World;

/** Provider-event replay handling and the observability of financial events. */
class WebhookReplayIT extends IntegrationTest {

    @Autowired
    MeterRegistry meters;

    World w;
    Bank bank;

    @BeforeEach
    void world() {
        w = World.create(this);
        bank = w.bank;
    }

    private String event(String eventId, String transactionId, long amount) {
        return Bank.body(bank.accountId, "POSTED", amount, null, transactionId, eventId, Instant.parse("2026-10-12T10:00:00Z"));
    }

    private int transactions() {
        return jdbc.queryForObject("select count(*) from bank_transactions", Integer.class);
    }

    private double count(String name, String... tags) {
        var counter = meters.find(name).tags(tags).counter();
        return counter == null ? 0 : counter.count();
    }

    @Test
    void aSignatureOlderThanTheToleranceIsRefusedEvenThoughItIsGenuine() {
        String raw = event("replay-1", "tx-replay", 5_000);
        String stale = SimulatedProviderAdapter.sign(Bank.SECRET, raw, Instant.now().minusSeconds(3600));
        var response = bank.post(raw, stale);
        assertThat(response.status()).isEqualTo(401);
        assertThat(transactions()).isZero();
        assertThat(jdbc.queryForObject("select count(*) from bank_events", Integer.class)).isZero();
        // Dated in the future is just as suspicious.
        assertThat(bank.post(raw, SimulatedProviderAdapter.sign(Bank.SECRET, raw, Instant.now().plusSeconds(3600))).status()).isEqualTo(401);
        // A fresh signature of the same body is accepted.
        assertThat(bank.post(raw, SimulatedProviderAdapter.sign(Bank.SECRET, raw)).status()).isEqualTo(200);
        assertThat(transactions()).isEqualTo(1);
    }

    @Test
    void aCapturedRequestReplayedInsideTheWindowChangesNothing() {
        String raw = event("replay-2", "tx-replay-2", 5_000);
        String signature = SimulatedProviderAdapter.sign(Bank.SECRET, raw);
        assertThat(bank.post(raw, signature).json().path("outcome").asString()).isEqualTo("APPLIED");
        for (int i = 0; i < 3; i++) {
            var again = bank.post(raw, signature);
            assertThat(again.status()).isEqualTo(200);
            assertThat(again.json().path("outcome").asString()).isEqualTo("DUPLICATE");
        }
        assertThat(transactions()).isEqualTo(1);
        assertThat(jdbc.queryForObject("select count(*) from bank_events", Integer.class)).isEqualTo(1);
        assertThat(jdbc.queryForObject("select amount_rwf from bank_transactions", Long.class)).isEqualTo(5_000L);
    }

    @Test
    void theSameEventIdWithDifferentContentIsIgnoredAndRaisedAsAnAnomaly() {
        String original = event("replay-3", "tx-replay-3", 5_000);
        assertThat(bank.post(original, SimulatedProviderAdapter.sign(Bank.SECRET, original)).json().path("outcome").asString()).isEqualTo("APPLIED");
        // Correctly signed, same event id, but a different amount: a provider bug or a replay with a doctored body.
        String doctored = event("replay-3", "tx-replay-3", 9_000_000);
        var response = bank.post(doctored, SimulatedProviderAdapter.sign(Bank.SECRET, doctored));
        assertThat(response.status()).isEqualTo(200);
        assertThat(response.json().path("outcome").asString()).isEqualTo("DUPLICATE");
        assertThat(jdbc.queryForObject("select amount_rwf from bank_transactions", Long.class)).isEqualTo(5_000L);
        assertThat(jdbc.queryForList("select kind from audit_log where merchant_id = ?", String.class, w.merchantId)).contains("REPLAY_PAYLOAD_MISMATCH");
        assertThat(count("oupay.bank.events.payload_mismatch", "provider", "EQUITY_MOCK")).isEqualTo(1.0);
        // An identical re-delivery is NOT an anomaly.
        bank.post(original, SimulatedProviderAdapter.sign(Bank.SECRET, original));
        assertThat(count("oupay.bank.events.payload_mismatch", "provider", "EQUITY_MOCK")).isEqualTo(1.0);
    }

    @Test
    void storedEventsHoldNoPersonalDataButAreStillVerifiableByHash() {
        String raw = event("redact-1", "tx-redact", 1_000).replace("Test Payer", "Jean Claude Habimana");
        assertThat(bank.post(raw, SimulatedProviderAdapter.sign(Bank.SECRET, raw)).status()).isEqualTo(200);
        String stored = jdbc.queryForObject("select raw_payload from bank_events", String.class);
        assertThat(stored).doesNotContain("Jean").doesNotContain("Habimana").doesNotContain(bank.accountId).contains("J***");
        assertThat(jdbc.queryForObject("select payload_sha256 from bank_events", String.class)).isEqualTo(rw.oupay.common.TokenHashing.sha256Hex(raw));
        // Nothing in the audit trail or notifications repeats the payer name either.
        assertThat(String.join(" ", jdbc.queryForList("select message from audit_log", String.class))).doesNotContain("Habimana");
    }

    @Test
    void financialEventsAreCountedOnlyWhenTheyCommit() {
        var invoice = w.issuedInvoice(10_000);
        String number = jdbc.queryForObject("select invoice_number from invoices where id = ?", String.class, invoice);
        double appliedBefore = count("oupay.bank.events", "provider", "EQUITY_MOCK", "outcome", "APPLIED");
        double allocationsBefore = count("oupay.ledger.allocations", "origin", "AUTO_REFERENCE");
        double rwfBefore = count("oupay.ledger.allocated.rwf", "origin", "AUTO_REFERENCE");
        var first = bank.pay("POSTED", 4_000, number);
        assertThat(first.outcome()).isEqualTo("APPLIED");
        assertThat(count("oupay.bank.events", "provider", "EQUITY_MOCK", "outcome", "APPLIED")).isEqualTo(appliedBefore + 1);
        assertThat(count("oupay.ledger.allocations", "origin", "AUTO_REFERENCE")).isEqualTo(allocationsBefore + 1);
        assertThat(count("oupay.ledger.allocated.rwf", "origin", "AUTO_REFERENCE")).isEqualTo(rwfBefore + 4_000);
        double duplicatesBefore = count("oupay.bank.events", "provider", "EQUITY_MOCK", "outcome", "DUPLICATE");
        bank.update(first.transactionId(), "POSTED", 4_000, number);   // same status again
        assertThat(count("oupay.bank.events", "provider", "EQUITY_MOCK", "outcome", "DUPLICATE")).isEqualTo(duplicatesBefore + 1);
        // Reversal and review flags are visible too.
        double reversalsBefore = count("oupay.ledger.reversals", "kind", "BANK_REVERSAL");
        bank.update(first.transactionId(), "REVERSED", 4_000, number);
        assertThat(count("oupay.ledger.reversals", "kind", "BANK_REVERSAL")).isEqualTo(reversalsBefore + 1);
        double flagsBefore = count("oupay.ledger.review_flags");
        bank.pay("POSTED", 1_000, "NO-SUCH-REFERENCE");
        assertThat(count("oupay.ledger.review_flags")).isEqualTo(flagsBefore + 1);
        assertThat(meters.find("oupay.ledger.transactions.needing_review").gauge().value()).isEqualTo(1.0);
    }
}
