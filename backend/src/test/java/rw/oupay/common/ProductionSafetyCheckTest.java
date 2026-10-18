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
                .anyMatch(p -> p.contains("email provider")).anyMatch(p -> p.contains("dev mail endpoint")).anyMatch(p -> p.contains("https"));
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

    @Test
    void productionRequiresAnEncryptedDatabaseConnectionUnlessItIsLocal() {
        String neon = "jdbc:postgresql://ep-example-123.eu-central-1.aws.neon.tech/oupay";
        assertThat(ProductionSafetyCheck.databaseViolations(neon + "?sslmode=require", "")).isEmpty();
        assertThat(ProductionSafetyCheck.databaseViolations(neon + "?channel_binding=require&sslmode=verify-full", "")).isEmpty();
        assertThat(ProductionSafetyCheck.databaseViolations(neon, "")).hasSize(1);
        for (String weak : new String[] {"?sslmode=disable", "?sslmode=allow", "?sslmode=prefer", "?foo=sslmode=require", "?sslmode=requirex"}) {
            assertThat(ProductionSafetyCheck.databaseViolations(neon + weak, "")).as(weak).hasSize(1);
        }
        // The Flyway URL is held to the same rule when it is set separately.
        assertThat(ProductionSafetyCheck.databaseViolations(neon + "?sslmode=require", neon)).hasSize(1);
        assertThat(ProductionSafetyCheck.databaseViolations(neon + "?sslmode=require", neon + "?sslmode=require")).isEmpty();
        // A database on this machine needs no TLS; a look-alike host does.
        assertThat(ProductionSafetyCheck.databaseViolations("jdbc:postgresql://localhost:5432/oupay", "")).isEmpty();
        assertThat(ProductionSafetyCheck.databaseViolations("jdbc:postgresql://127.0.0.1/oupay", "")).isEmpty();
        assertThat(ProductionSafetyCheck.databaseViolations("jdbc:postgresql://localhost.evil.example/oupay", "")).hasSize(1);
        assertThat(ProductionSafetyCheck.databaseViolations("", "")).hasSize(1);
        // The message never contains the URL (it can carry credentials).
        assertThat(String.join(" ", ProductionSafetyCheck.databaseViolations("jdbc:postgresql://user:secretpw@db.example/x", ""))).doesNotContain("secretpw");
    }

    @Test
    void theDevProfileCanNeverRunTogetherWithProd() {
        var env = new org.springframework.mock.env.MockEnvironment().withProperty("spring.datasource.url", "jdbc:postgresql://localhost/x");
        env.setActiveProfiles("prod", "dev");
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> new ProductionSafetyCheck(env,
                security(true, "__Host-oupay_session", "Lax", List.of()), email("smtp", false), new SimulatedProviderProperties(false, ""),
                new AppProperties("https://app.example.rw")))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("dev profile");
    }

    @Test
    void resendProviderIsAllowedInProduction() {
        var problems = check(
                true,
                security(true, "__Host-oupay_session", "Lax", List.of()),
                email("resend", false),
                new SimulatedProviderProperties(false, ""),
                "https://oupay-chi.vercel.app",
                ""
        );

        assertThat(problems).isEmpty();
    }

    @Test
    void smtpStillRequiresHostInProduction() {
        var problems = check(
                true,
                security(true, "__Host-oupay_session", "Lax", List.of()),
                email("smtp", false),
                new SimulatedProviderProperties(false, ""),
                "https://oupay-chi.vercel.app",
                ""
        );

        assertThat(problems)
                .anyMatch(problem -> problem.contains("SMTP requires"));
    }

    @Test
    void productionRejectsMissingResendApiKey() {
        var environment = new org.springframework.mock.env.MockEnvironment()
                .withProperty(
                        "spring.datasource.url",
                        "jdbc:postgresql://localhost/oupay"
                );

        environment.setActiveProfiles("prod");

        org.assertj.core.api.Assertions.assertThatThrownBy(
                () -> new ProductionSafetyCheck(
                        environment,
                        security(true, "__Host-oupay_session", "Lax", List.of()),
                        email("resend", false),
                        new SimulatedProviderProperties(false, ""),
                        new AppProperties("https://oupay-chi.vercel.app")
                )
        ).isInstanceOf(IllegalStateException.class)
         .hasMessageContaining("OUPAY_RESEND_API_KEY");
    }

}
