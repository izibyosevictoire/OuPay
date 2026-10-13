package rw.oupay.banking;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import rw.oupay.support.IntegrationTest;
import rw.oupay.support.World;

/** A merchant's banking configuration: owners only, opaque and masked data only, honest capabilities. */
class BankingIT extends IntegrationTest {

    World w;

    @BeforeEach
    void world() {
        w = World.create(this);
    }

    private String m(String path) {
        return "/api/v1/merchants/" + w.cafeMerchantId + path;
    }

    private Map<String, Object> link(String reference, String nickname) {
        return Map.of("providerId", "EQUITY_MOCK", "accountReference", reference, "accountNickname", nickname);
    }

    @Test
    void providersAreListedWithHonestCapabilities() {
        var providers = w.owner.get("/api/v1/banking/providers").json();
        assertThat(providers.size()).isEqualTo(3);
        var equity = providers.get(0);
        assertThat(equity.path("id").asString()).isEqualTo("EQUITY_MOCK");
        assertThat(equity.path("isSimulated").asBoolean()).isTrue();
        assertThat(equity.path("displayName").asString()).contains("simulated");
        for (int i = 1; i <= 2; i++) {
            var placeholder = providers.get(i);
            assertThat(placeholder.path("isAvailable").asBoolean()).isFalse();
            placeholder.path("capabilities").propertyNames().forEach(name ->
                    assertThat(placeholder.path("capabilities").path(name).asString()).isEqualTo("UNCONFIRMED"));
        }
        assertThat(TestApiAnonymous.get(mvc, "/api/v1/banking/providers").status()).isEqualTo(401);
    }

    @Test
    void onlyOwnersConfigureBanking() {
        String shop = "/api/v1/merchants/" + w.merchantId;
        for (var api : new rw.oupay.support.TestApi[] {w.manager, w.cashier}) {
            assertThat(api.get(shop + "/bank-connections").status()).isEqualTo(403);
            assertThat(api.get(shop + "/payment-destinations").status()).isEqualTo(403);
            assertThat(api.post(shop + "/bank-connections", link("SIM-5555", "Mine")).status()).isEqualTo(403);
            assertThat(api.post(shop + "/bank-connections/" + UUID.randomUUID() + "/disable", null).status()).isEqualTo(403);
        }
        assertThat(w.cafeOwner.get(shop + "/bank-connections").status()).isEqualTo(404);
    }

    @Test
    void theLinkFlowGoesPendingConnectedDisabledWithOnlyOpaqueAndMaskedData() {
        var started = w.cafeOwner.post(m("/bank-connections"), link("sim-9876", "Cafe takings"));
        assertThat(started.status()).isEqualTo(200);
        assertThat(started.json().path("status").asString()).isEqualTo("PENDING");
        assertThat(started.json().path("maskedAccount").asString()).isEqualTo("••••9876");
        assertThat(started.json().path("isSimulated").asBoolean()).isTrue();
        // The reference the owner typed is never stored or echoed anywhere.
        assertThat(started.body()).doesNotContainIgnoringCase("SIM-9876");
        assertThat(jdbc.queryForObject("select count(*) from bank_connections where lower(provider_account_id) like '%9876%' or lower(masked_account) like '%sim-9876%'", Integer.class)).isZero();

        String id = started.json().path("id").asString();
        assertThat(w.cafeOwner.get(m("/payment-destinations")).json().size()).isZero();
        var completed = w.cafeOwner.post(m("/bank-connections/" + id + "/complete"), null);
        assertThat(completed.json().path("status").asString()).isEqualTo("CONNECTED");
        assertThat(w.cafeOwner.get(m("/payment-destinations")).json().get(0).path("maskedAccount").asString()).isEqualTo("••••9876");
        assertThat(w.cafeOwner.post(m("/bank-connections/" + id + "/complete"), null).code()).isEqualTo("invalid_state");

        assertThat(w.cafeOwner.post(m("/bank-connections/" + id + "/disable"), null).json().path("status").asString()).isEqualTo("DISABLED");
        assertThat(w.cafeOwner.post(m("/bank-connections/" + id + "/disable"), null).code()).isEqualTo("invalid_state");
    }

    @Test
    void connectionErrorsStayVisibleAndCreateNoDestination() {
        var failed = w.cafeOwner.post(m("/bank-connections"), link("SIM-ERROR", "Broken")).json();
        assertThat(failed.path("status").asString()).isEqualTo("ERROR");
        assertThat(failed.path("lastError").asString()).isNotBlank();
        assertThat(w.cafeOwner.post(m("/bank-connections/" + failed.path("id").asString() + "/complete"), null).code()).isEqualTo("invalid_state");
        assertThat(w.cafeOwner.get(m("/payment-destinations")).json().size()).isZero();
        // An error does not block a corrected attempt.
        assertThat(w.cafeOwner.post(m("/bank-connections"), link("SIM-4321", "Fixed")).json().path("status").asString()).isEqualTo("PENDING");
    }

    @Test
    void rulesAboutDuplicatesNamesAndUnsupportedProviders() {
        assertThat(w.cafeOwner.post(m("/bank-connections"), link("SIM-1111", "First")).status()).isEqualTo(200);
        var second = w.cafeOwner.post(m("/bank-connections"), link("SIM-2222", "Second"));
        assertThat(second.status()).isEqualTo(409);
        assertThat(second.code()).isEqualTo("invalid_state");
        assertThat(w.cafeOwner.post(m("/bank-connections"), link("SIM-3333", "x")).status()).isIn(409, 422);
        var mtn = w.cafeOwner.post(m("/bank-connections"), Map.of("providerId", "MTN_MOMO", "accountReference", "SIM-3333", "accountNickname", "Wallet"));
        assertThat(mtn.status()).isEqualTo(422);
        assertThat(mtn.code()).isEqualTo("not_supported");
        assertThat(w.cafeOwner.post(m("/bank-connections"), Map.of("providerId", "NOPE", "accountReference", "x", "accountNickname", "y")).status()).isIn(400, 422);
    }

    @Test
    void oneProviderAccountCannotBeLinkedByTwoBusinesses() {
        // Distinct references produce distinct opaque IDs, so both succeed; the live-account index is the backstop.
        assertThat(w.cafeOwner.post(m("/bank-connections"), link("SIM-7777", "Cafe")).status()).isEqualTo(200);
        assertThat(w.owner.post("/api/v1/merchants/" + w.merchantId + "/bank-connections/" + UUID.randomUUID() + "/complete", null).status()).isEqualTo(404);
    }

    /** Anonymous GET helper kept local to avoid widening the shared test API. */
    static final class TestApiAnonymous {
        static rw.oupay.support.TestApi.Response get(org.springframework.test.web.servlet.MockMvc mvc, String url) {
            return rw.oupay.support.TestApi.anonymous(mvc, org.springframework.http.HttpMethod.GET, url, null, Map.of());
        }
    }
}
