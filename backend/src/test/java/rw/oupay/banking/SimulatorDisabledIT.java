package rw.oupay.banking;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Instant;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpMethod;
import org.springframework.test.context.TestPropertySource;
import rw.oupay.support.Bank;
import rw.oupay.support.IntegrationTest;
import rw.oupay.support.TestApi;

/** In any environment where the simulator is not explicitly enabled, it does not exist. */
@TestPropertySource(properties = "oupay.integrations.simulated.enabled=false")
class SimulatorDisabledIT extends IntegrationTest {

    @Test
    void theSimulatedProviderEndpointIsNotFoundEvenWithAValidSignature() {
        String raw = Bank.body("bacc-1", "POSTED", 1_000, null, "t", "e", Instant.parse("2026-10-12T10:00:00Z"));
        var response = TestApi.anonymous(mvc, HttpMethod.POST, "/api/v1/integrations/equity-mock/events", raw,
                Map.of(SimulatedProviderAdapter.SIGNATURE_HEADER, SimulatedProviderAdapter.sign(Bank.SECRET, raw)));
        assertThat(response.status()).isEqualTo(404);
        assertThat(jdbc.queryForObject("select count(*) from bank_events", Integer.class)).isZero();
    }
}
