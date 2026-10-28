package rw.oupay.checkout;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;
import org.springframework.mock.env.MockEnvironment;
import org.springframework.test.context.TestPropertySource;
import tools.jackson.databind.JsonNode;

/** The default: live collection is OFF. A bank-approved real code is refused, honestly, and nothing is created. */
@TestPropertySource(properties = "oupay.collection-codes.approval-enabled=true")
class CodeCheckoutLiveDisabledIT extends CodeCheckoutTestSupport {

    @Test
    void anApprovedRealCodeIsNotBillableWhileLiveCollectionIsOff() {
        makeAccountReal();
        ensureProfile();
        JsonNode code = activeCode("Live", "EQ-LIVE-77");
        assertThat(assign(code, cashierMembership).status()).isEqualTo(201);

        var options = w.cashier.get(sale() + "/options").json();
        assertThat(options.path("liveCollectionEnabled").asBoolean()).isFalse();
        assertThat(options.path("codes").get(0).path("mode").asString()).isEqualTo("UNAVAILABLE");
        assertThat(options.path("readiness").asString()).isEqualTo("CODE_NOT_AVAILABLE");

        var response = bill(w.cashier, 5_000);
        assertThat(response.status()).isEqualTo(409);
        assertThat(response.code()).isEqualTo("live_collection_unavailable");
        assertThat(count("code_sales")).isZero();
        assertThat(count("invoices")).isZero();
        assertThat(count("payment_requests")).isZero();
        assertThat(count("idempotency_keys")).isZero();
    }

    @Test
    void aSimulatedCodeStillBillsADemonstrationWhileLiveCollectionIsOff() {
        ensureProfile();
        JsonNode code = activeCode("Counter", "EQ-DEMO-1");
        assertThat(assign(code, cashierMembership).status()).isEqualTo(201);
        var response = bill(w.cashier, 5_000);
        assertThat(response.status()).as(response.body()).isEqualTo(201);
        assertThat(response.json().path("code").path("mode").asString()).isEqualTo("DEMONSTRATION");
    }

    @Test
    void liveCollectionCanBeEnabledOnlyUnderTheTestProfile() {
        MockEnvironment prod = new MockEnvironment();
        prod.setActiveProfiles("prod");
        assertThatThrownBy(() -> new CodeCheckoutStartupGuard(prod, true)).isInstanceOf(IllegalStateException.class).hasMessageContaining("live-enabled");
        assertThatThrownBy(() -> new CodeCheckoutStartupGuard(new MockEnvironment(), true)).isInstanceOf(IllegalStateException.class);
        MockEnvironment both = new MockEnvironment();
        both.setActiveProfiles("test", "prod");
        assertThatThrownBy(() -> new CodeCheckoutStartupGuard(both, true)).isInstanceOf(IllegalStateException.class);
        MockEnvironment test = new MockEnvironment();
        test.setActiveProfiles("test");
        new CodeCheckoutStartupGuard(test, true);
        new CodeCheckoutStartupGuard(prod, false);
    }
}
