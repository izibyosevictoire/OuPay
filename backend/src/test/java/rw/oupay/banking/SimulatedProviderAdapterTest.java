package rw.oupay.banking;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.Map;
import org.junit.jupiter.api.Test;
import rw.oupay.banking.BankingProviderAdapter.EventStatus;
import rw.oupay.banking.BankingProviderAdapter.InvalidProviderEventException;
import tools.jackson.databind.json.JsonMapper;

class SimulatedProviderAdapterTest {

    private final SimulatedProviderAdapter adapter =
            new SimulatedProviderAdapter(JsonMapper.builder().build(), new SimulatedProviderProperties(true, "unit-secret"));

    private static final String VALID = "{\"simulated\":true,\"eventId\":\"e1\",\"transactionId\":\"t1\",\"state\":\"POSTED\",\"amount\":1000,"
            + "\"currency\":\"RWF\",\"reference\":\" INV-0001 \",\"payerName\":\"Someone\",\"occurredAt\":\"2026-10-12T10:00:00Z\",\"accountRef\":\"bacc-1\"}";

    @Test
    void normalisesAnEventKeepingTheReferenceExactlyApartFromEdgeWhitespace() {
        var event = adapter.normalizeTransactionEvent(VALID);
        assertThat(event.status()).isEqualTo(EventStatus.CONFIRMED);
        assertThat(event.amountRwf()).isEqualTo(1000);
        assertThat(event.paymentReference()).isEqualTo("INV-0001");
        assertThat(event.simulated()).isTrue();
        assertThat(event.providerAccountId()).isEqualTo("bacc-1");
        assertThat(adapter.normalizeTransactionEvent(VALID.replace("POSTED", "REJECTED")).status()).isEqualTo(EventStatus.FAILED);
        assertThat(adapter.normalizeTransactionEvent(VALID.replace("POSTED", "PENDING")).status()).isEqualTo(EventStatus.PENDING);
        assertThat(adapter.normalizeTransactionEvent(VALID.replace("POSTED", "REVERSED")).status()).isEqualTo(EventStatus.REVERSED);
        assertThat(adapter.normalizeTransactionEvent(VALID.replace("\" INV-0001 \"", "\"\"")).paymentReference()).isNull();
    }

    @Test
    void refusesAnythingUntrustworthy() {
        for (String bad : new String[] {"", "text", "[]", "{}", VALID.replace("\"simulated\":true", "\"simulated\":false"),
                VALID.replace("\"simulated\":true,", ""), VALID.replace("POSTED", "APPROVED"), VALID.replace("1000", "-5"),
                VALID.replace("1000", "0"), VALID.replace("1000", "10.5"), VALID.replace("1000", "\"1000\""),
                VALID.replace("RWF", "USD"), VALID.replace("2026-10-12T10:00:00Z", "yesterday"), VALID.replace("\"e1\"", "\"\""),
                VALID.replace("\"accountRef\":\"bacc-1\"", "\"accountRef\":null"), VALID.replace("1000", "99999999999")}) {
            assertThatThrownBy(() -> adapter.normalizeTransactionEvent(bad)).as(bad).isInstanceOf(InvalidProviderEventException.class);
        }
    }

    @Test
    void authenticatesWithAConstantTimeHmacAndRefusesEverythingElse() {
        String good = SimulatedProviderAdapter.sign("unit-secret", VALID);
        var header = SimulatedProviderAdapter.SIGNATURE_HEADER;
        assertThat(adapter.isAuthentic(Map.of(header, good), VALID)).isTrue();
        assertThat(adapter.isAuthentic(Map.of(header, good.toUpperCase()), VALID)).isTrue();   // hex is case-insensitive
        assertThat(adapter.isAuthentic(Map.of(), VALID)).isFalse();
        assertThat(adapter.isAuthentic(Map.of(header, "zz"), VALID)).isFalse();
        assertThat(adapter.isAuthentic(Map.of(header, good), VALID + " ")).isFalse();
        assertThat(adapter.isAuthentic(Map.of(header, SimulatedProviderAdapter.sign("other", VALID)), VALID)).isFalse();
    }

    @Test
    void withoutAConfiguredSecretNothingIsEverAuthentic() {
        var noSecret = new SimulatedProviderAdapter(JsonMapper.builder().build(), new SimulatedProviderProperties(true, ""));
        assertThat(noSecret.isAuthentic(Map.of(SimulatedProviderAdapter.SIGNATURE_HEADER, "abcd"), VALID)).isFalse();
    }

    @Test
    void demoLinkValidationRejectsRealLookingBankingDetails() {
        var ok = adapter.validateAccountLink("sim-1234");
        assertThat(ok.valid()).isTrue();
        assertThat(ok.maskedAccount()).isEqualTo("••••1234");
        assertThat(ok.providerAccountId()).startsWith("bacc-");
        for (String bad : new String[] {"SIM-ERROR", "0123456789012", "my-password", "", "4111111111111111", "SIM-1"}) {
            var result = adapter.validateAccountLink(bad);
            assertThat(result.valid()).as(bad).isFalse();
            assertThat(result.failureReason()).isNotBlank();
        }
    }

    @Test
    void capabilitiesAreHonestAndRealProvidersAreAllUnconfirmed() {
        assertThat(adapter.isSimulated()).isTrue();
        assertThat(adapter.capabilities().merchantVerification()).isEqualTo(Capability.NOT_SUPPORTED);
        assertThat(adapter.capabilities().ussdMerchantResolution()).isEqualTo(Capability.NOT_SUPPORTED);
        var registry = new ProviderRegistry(java.util.List.of(adapter));
        assertThat(registry.adapter(ProviderId.MTN_MOMO)).isEmpty();
        for (ProviderId id : new ProviderId[] {ProviderId.MTN_MOMO, ProviderId.AIRTEL_MONEY}) {
            var caps = registry.capabilities(id);
            assertThat(java.util.stream.Stream.of(caps.transactionWebhooks(), caps.webhookSignatureVerification(), caps.merchantVerification(),
                    caps.accountLinking(), caps.paymentInitiation(), caps.realtimeNotifications(), caps.ussdMerchantResolution(),
                    caps.paymentReferenceEcho())).containsOnly(Capability.UNCONFIRMED);
        }
        assertThat(registry.descriptions()).extracting(ProviderRegistry.Description::available).containsExactly(true, false, false);
    }
}
