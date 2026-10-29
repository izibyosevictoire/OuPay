package rw.oupay.kyc;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.test.context.TestPropertySource;
import rw.oupay.support.IntegrationTest;
import rw.oupay.support.World;

/** With encryption configured but the reveal workflow NOT enabled (the default), a protected value can be saved and replaced but never read back. */
@TestPropertySource(properties = "oupay.kyc.encryption-key=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=")
class KycRevealDisabledIT extends IntegrationTest {

    private static final String ID_NUMBER = "1199880012345678";

    World w;

    @BeforeEach
    void world() {
        w = World.create(this);
    }

    private String base(UUID merchantId) {
        return "/api/v1/merchants/" + merchantId + "/kyc";
    }

    @Test
    void aSavedProtectedValueCanNeverBeReadBackAndNothingIsRecordedAsViewed() {
        String base = base(w.merchantId);
        assertThat(w.owner.get(base + "/options").json().path("storage").path("revealAvailable").asBoolean()).isFalse();
        var started = w.owner.post(base + "/applications", Map.of("clientOperationId", UUID.randomUUID().toString()));
        String id = started.json().path("application").path("id").asString();
        long version = started.json().path("application").path("version").asLong();
        var saved = w.owner.put(base + "/applications/" + id + "/answers", Map.of("expectedVersion", version, "answers", Map.of("representative.idNumber", ID_NUMBER)));
        assertThat(saved.status()).isEqualTo(200);
        assertThat(saved.body()).doesNotContain(ID_NUMBER).contains("••••5678");
        assertThat(jdbc.queryForObject("select count(*) from kyc_answers where sensitive and ciphertext is not null", Integer.class)).isEqualTo(1);

        // Not for the owner, whatever they ask for...
        var refused = w.owner.post(base + "/applications/" + id + "/answers/representative.idNumber/reveal", null);
        assertThat(refused.status()).isEqualTo(501);
        assertThat(refused.code()).isEqualTo("not_implemented");
        assertThat(refused.body()).doesNotContain(ID_NUMBER);
        // ...and, as ever, not for anyone else.
        assertThat(w.manager.post(base + "/applications/" + id + "/answers/representative.idNumber/reveal", null).status()).isEqualTo(403);
        assertThat(w.cashier.post(base + "/applications/" + id + "/answers/representative.idNumber/reveal", null).status()).isEqualTo(403);
        assertThat(w.cafeOwner.post(base(w.cafeMerchantId) + "/applications/" + id + "/answers/representative.idNumber/reveal", null).status()).isEqualTo(501); // disabled before any lookup: no hint whether the application exists
        assertThat(jdbc.queryForObject("select count(*) from kyc_events where kind = 'SENSITIVE_VALUE_VIEWED'", Integer.class)).isZero();
        assertThat(jdbc.queryForObject("select count(*) from audit_log where kind = 'KYC_SENSITIVE_VIEWED'", Integer.class)).isZero();

        // The value can still be replaced by typing it again; the old value is simply overwritten by the owner's own act.
        var replaced = w.owner.put(base + "/applications/" + id + "/answers", Map.of("expectedVersion", version + 1, "answers", Map.of("representative.idNumber", "9988 7766 5544")));
        assertThat(replaced.status()).isEqualTo(200);
        assertThat(replaced.body()).contains("••••5544").doesNotContain("9988 7766 5544");
    }
}
