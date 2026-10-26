package rw.oupay.kyc;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import rw.oupay.support.IntegrationTest;
import rw.oupay.support.World;

/** With no encryption key configured (the default), protected values are refused rather than stored unprotected, and nothing else breaks. */
class KycWithoutStorageIT extends IntegrationTest {

    World w;

    @BeforeEach
    void world() {
        w = World.create(this);
    }

    @Test
    void aProtectedValueIsRefusedNotStoredInTheClearAndTheRestStillWorks() {
        String base = "/api/v1/merchants/" + w.merchantId + "/kyc";
        var options = w.owner.get(base + "/options").json();
        assertThat(options.path("storage").path("sensitiveStorageAvailable").asBoolean()).isFalse();
        var started = w.owner.post(base + "/applications", Map.of("clientOperationId", UUID.randomUUID().toString()));
        assertThat(started.status()).isEqualTo(201);
        String id = started.json().path("application").path("id").asString();
        long version = started.json().path("application").path("version").asLong();

        var refused = w.owner.put(base + "/applications/" + id + "/answers", Map.of("expectedVersion", version, "answers", Map.of("representative.idNumber", "1199880012345678")));
        assertThat(refused.status()).isEqualTo(409);
        assertThat(refused.code()).isEqualTo("sensitive_storage_unavailable");
        assertThat(refused.body()).doesNotContain("1199880012345678");
        assertThat(jdbc.queryForObject("select count(*) from kyc_answers where sensitive", Integer.class)).isZero();
        assertThat(jdbc.queryForObject("select count(*) from kyc_answers where value_text like '%1199880012345678%'", Integer.class)).isZero();

        // The optional protected field is not required, so the application is still completable without it.
        var saved = w.owner.put(base + "/applications/" + id + "/answers", Map.of("expectedVersion", version, "answers",
                Map.of("representative.role", "OWNER", "representative.idDocumentType", "NATIONAL_ID", "bank.hasEquityAccount", "NO")));
        assertThat(saved.status()).isEqualTo(200);
        assertThat(saved.json().path("readiness").path("missingFields").size()).isZero();
        // Nothing can be revealed: showing a saved value is disabled by default, and nothing was stored.
        assertThat(w.owner.post(base + "/applications/" + id + "/answers/representative.idNumber/reveal", null).status()).isEqualTo(501);
    }

    @Test
    void theBanksSideIsUnavailableWhenNotEnabled() {
        String base = "/api/v1/merchants/" + w.merchantId + "/kyc";
        var started = w.owner.post(base + "/applications", Map.of("clientOperationId", UUID.randomUUID().toString()));
        UUID id = UUID.fromString(started.json().path("application").path("id").asString());
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> evidence.recordHandoff(w.merchantId, id,
                new KycEvidenceService.Evidence(rw.oupay.collection.ApprovalSource.BANK_EVENT, "EV-1", null, null)))
                .isInstanceOf(rw.oupay.common.ApiException.class).hasMessageContaining("not available");
    }

    @org.springframework.beans.factory.annotation.Autowired
    KycEvidenceService evidence;
}
