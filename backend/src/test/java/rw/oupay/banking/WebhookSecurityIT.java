package rw.oupay.banking;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Instant;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpMethod;
import rw.oupay.support.Bank;
import rw.oupay.support.IntegrationTest;
import rw.oupay.support.TestApi;
import rw.oupay.support.World;

/** The provider boundary: who may create bank transactions, and what happens to everyone else. */
class WebhookSecurityIT extends IntegrationTest {

    World w;
    Bank bank;
    static final String PATH = "/api/v1/integrations/equity-mock/events";

    @BeforeEach
    void world() {
        w = World.create(this);
        bank = w.bank;
    }

    private String payload() {
        return Bank.body(bank.accountId, "POSTED", 5_000, null, "tx-sec", "evt-sec", Instant.parse("2026-10-12T10:00:00Z"));
    }

    private int transactions() {
        return jdbc.queryForObject("select count(*) from bank_transactions", Integer.class);
    }

    @Test
    void anEventWithoutASignatureIsRefusedAndNothingIsRecorded() {
        var response = bank.post(payload(), null);
        assertThat(response.status()).isEqualTo(401);
        assertThat(response.code()).isEqualTo("unauthenticated");
        assertThat(transactions()).isZero();
        assertThat(jdbc.queryForObject("select count(*) from bank_events", Integer.class)).isZero();
    }

    @Test
    void wrongTamperedAndMalformedSignaturesAreRefused() {
        String raw = payload();
        String good = SimulatedProviderAdapter.sign(Bank.SECRET, raw);
        assertThat(bank.post(raw, SimulatedProviderAdapter.sign("some-other-secret", raw)).status()).isEqualTo(401);
        assertThat(bank.post(raw.replace("5000", "5000000"), good).status()).isEqualTo(401);   // body tampered after signing
        assertThat(bank.post(raw, "not-hex").status()).isEqualTo(401);
        assertThat(bank.post(raw, "").status()).isEqualTo(401);
        assertThat(bank.post(raw, good.substring(0, good.length() - 2)).status()).isEqualTo(401);
        assertThat(transactions()).isZero();
        assertThat(bank.post(raw, good).status()).isEqualTo(200);
        assertThat(transactions()).isEqualTo(1);
    }

    @Test
    void aSignedButMalformedPayloadIsABadRequestNotAServerError() {
        for (String raw : new String[] {"not json", "[]", "{}",
                "{\"simulated\":false,\"eventId\":\"e\",\"transactionId\":\"t\",\"state\":\"POSTED\",\"amount\":1,\"currency\":\"RWF\",\"occurredAt\":\"2026-10-12T10:00:00Z\",\"accountRef\":\"a\"}",
                Bank.body(bank.accountId, "POSTED", -5, null, "t", "e", Instant.now()).replace("-5", "-5"),
                Bank.body(bank.accountId, "APPROVED", 5, null, "t", "e", Instant.now()),
                Bank.body(bank.accountId, "POSTED", 5, null, "t", "e", Instant.now()).replace("RWF", "USD"),
                Bank.body(bank.accountId, "POSTED", 5, null, "t", "e", Instant.now()).replace("\"amount\":5", "\"amount\":5.5")}) {
            var response = bank.post(raw, SimulatedProviderAdapter.sign(Bank.SECRET, raw));
            assertThat(response.status()).as(raw).isEqualTo(400);
            assertThat(response.code()).isEqualTo("invalid_event");
        }
        assertThat(transactions()).isZero();
    }

    @Test
    void aSignedInUserSessionCannotConfirmAPayment() {
        // Even the owner, with a valid session and CSRF token, is not the provider: no signature, no event.
        for (TestApi api : new TestApi[] {w.owner, w.manager, w.cashier}) {
            var response = api.post(PATH, payload());
            assertThat(response.status()).isEqualTo(401);
        }
        assertThat(transactions()).isZero();
    }

    @Test
    void unknownProvidersAreNotFoundAndUnbuiltProvidersAreNotImplemented() {
        var anonymous = (java.util.function.Function<String, TestApi.Response>) path ->
                TestApi.anonymous(mvc, HttpMethod.POST, path, payload(), Map.of());
        assertThat(anonymous.apply("/api/v1/integrations/nobody/events").status()).isEqualTo(404);
        // The REAL Equity Bank integration does not exist: no endpoint pretends it does.
        var equity = anonymous.apply("/api/v1/integrations/equity/events");
        assertThat(equity.status()).isEqualTo(501);
        assertThat(equity.code()).isEqualTo("not_implemented");
        assertThat(anonymous.apply("/api/v1/integrations/mtn-momo/events").status()).isEqualTo(501);
        assertThat(anonymous.apply("/api/v1/integrations/airtel-money/events").status()).isEqualTo(501);
    }

    @Test
    void oversizedPayloadsAreRefusedBeforeAnyWork() {
        String raw = "{\"pad\":\"" + "x".repeat(70_000) + "\"}";
        var response = bank.post(raw, SimulatedProviderAdapter.sign(Bank.SECRET, raw));
        assertThat(response.status()).isEqualTo(413);
    }

    @Test
    void theEventIsStoredRedactedWithAHashOfTheOriginal() {
        String raw = payload();
        assertThat(bank.post(raw, SimulatedProviderAdapter.sign(Bank.SECRET, raw)).status()).isEqualTo(200);
        String stored = jdbc.queryForObject("select raw_payload from bank_events", String.class);
        // Personal data is redacted before it is stored; the hash of the original is kept for replay detection.
        assertThat(stored).doesNotContain("Test Payer").contains("T***").contains("\"eventId\"");
        assertThat(jdbc.queryForObject("select payload_sha256 from bank_events", String.class)).isEqualTo(rw.oupay.common.TokenHashing.sha256Hex(raw));
        assertThat(jdbc.queryForObject("select outcome from bank_events", String.class)).isEqualTo("APPLIED");
    }

    @Test
    void theWebhookEndpointNeedsNoCsrfTokenBecauseItUsesNoCookies() {
        String raw = payload();
        var response = TestApi.anonymous(mvc, HttpMethod.POST, PATH, raw,
                Map.of(SimulatedProviderAdapter.SIGNATURE_HEADER, SimulatedProviderAdapter.sign(Bank.SECRET, raw)));
        assertThat(response.status()).isEqualTo(200);
    }

    @Test
    void anAdapterWithoutAnAuthenticatorCanNeverBeExposed() {
        BankingProviderAdapter unauthenticated = new BankingProviderAdapter() {
            public ProviderId providerId() { return ProviderId.MTN_MOMO; }
            public String displayName() { return "x"; }
            public boolean isSimulated() { return false; }
            public ProviderCapabilities capabilities() { return ProviderCapabilities.allUnconfirmed(); }
            public NormalizedBankEvent normalizeTransactionEvent(String rawBody) { throw new UnsupportedOperationException(); }
        };
        assertThat(unauthenticated instanceof BankingProviderAdapter.EventAuthenticating).isFalse();
        assertThat(unauthenticated instanceof BankingProviderAdapter.AccountLinkingCapable).isFalse();
    }
}
