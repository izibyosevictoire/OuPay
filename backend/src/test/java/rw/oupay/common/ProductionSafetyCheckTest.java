package rw.oupay.common;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Duration;
import java.util.List;
import org.junit.jupiter.api.Test;
import rw.oupay.auth.SecurityProperties;
import rw.oupay.banking.SimulatedProviderProperties;
import rw.oupay.email.EmailProperties;

class ProductionSafetyCheckTest {

    private static SecurityProperties security(boolean secure, String cookie, String sameSite, List<String> origins) {
        return new SecurityProperties(
                new SecurityProperties.Session(cookie, secure, sameSite, Duration.ofMinutes(30), Duration.ofHours(12), Duration.ofDays(7), Duration.ofDays(30)),
                new SecurityProperties.Login(5, Duration.ofMinutes(15)),
                new SecurityProperties.Recovery(Duration.ofHours(1), Duration.ofHours(48), Duration.ofDays(7), 3),
                new SecurityProperties.Proxy(List.of()), new SecurityProperties.Origins(origins));
    }

    private static EmailProperties email(String provider, boolean sinkEndpoint) {
        return new EmailProperties(provider, "x", sinkEndpoint,
                new EmailProperties.Dispatcher(true, Duration.ofSeconds(5), 20, 8, Duration.ofSeconds(30), Duration.ofHours(1), Duration.ofMinutes(2)));
    }

    private static List<String> check(boolean prod, SecurityProperties s, EmailProperties e, SimulatedProviderProperties sim, String baseUrl, String smtp) {
        return ProductionSafetyCheck.violations(prod, s, e, sim, new AppProperties(baseUrl), smtp);
    }

    @Test
    void aSafeProductionConfigurationHasNoViolations() {
        assertThat(check(true, security(true, "__Host-oupay_session", "Lax", List.of()), email("smtp", false),
                new SimulatedProviderProperties(false, ""), "https://app.oupay.rw", "smtp.example.rw")).isEmpty();
    }

    @Test
    void developmentSettingsAreAcceptedOutsideProduction() {
        assertThat(check(false, security(false, "oupay_session", "Lax", List.of()), email("sink", true),
                new SimulatedProviderProperties(true, "dev-secret"), "http://localhost:5173", "")).isEmpty();
    }

    @Test
    void everyUnsafeProductionSettingIsReported() {
        var problems = check(true, security(false, "oupay_session", "Lax", List.of()), email("sink", true),
                new SimulatedProviderProperties(true, "s"), "http://app.oupay.rw", "");
        assertThat(problems).hasSize(5)
                .anyMatch(p -> p.contains("Secure")).anyMatch(p -> p.contains("simulated"))
                .anyMatch(p -> p.contains("smtp")).anyMatch(p -> p.contains("dev mail endpoint")).anyMatch(p -> p.contains("https"));
    }

    @Test
    void rulesThatHoldInEveryEnvironment() {
        assertThat(check(false, security(false, "__Host-oupay_session", "Lax", List.of()), email("sink", false),
                new SimulatedProviderProperties(false, ""), "http://x", "")).anyMatch(p -> p.contains("__Host-"));
        assertThat(check(false, security(true, "c", "None", List.of()), email("sink", false),
                new SimulatedProviderProperties(false, ""), "http://x", "")).anyMatch(p -> p.contains("SameSite=None"));
        assertThat(check(false, security(true, "c", "Lax", List.of("https://*.evil.example")), email("sink", false),
                new SimulatedProviderProperties(false, ""), "http://x", "")).anyMatch(p -> p.contains("wildcards"));
        assertThat(check(false, security(true, "c", "Lax", List.of()), email("sink", false),
                new SimulatedProviderProperties(true, ""), "http://x", "")).anyMatch(p -> p.contains("shared secret"));
    }
}
