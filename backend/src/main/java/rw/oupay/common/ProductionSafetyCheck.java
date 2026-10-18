package rw.oupay.common;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;
import org.springframework.core.env.Environment;
import org.springframework.core.env.Profiles;
import org.springframework.stereotype.Component;
import rw.oupay.auth.SecurityProperties;
import rw.oupay.banking.SimulatedProviderProperties;
import rw.oupay.email.EmailProperties;

/**
 * Refuses to start with an unsafe configuration, instead of starting and quietly being insecure.
 * Some rules hold everywhere (a simulator without a secret, a {@code __Host-} cookie that is not Secure);
 * the rest apply when the {@code prod} profile is active.
 */
@Component
public final class ProductionSafetyCheck {

    public ProductionSafetyCheck(Environment environment, SecurityProperties security, EmailProperties email,
                                 SimulatedProviderProperties simulator, AppProperties app) {
        boolean prod = environment.acceptsProfiles(Profiles.of("prod"));
        List<String> problems = new ArrayList<>(violations(prod, security, email, simulator, app, environment.getProperty("spring.mail.host", "")));
        if (prod) {
            if ("resend".equalsIgnoreCase(email.provider())
                    && environment.getProperty("OUPAY_RESEND_API_KEY", "").isBlank()) {
                problems.add("Resend requires OUPAY_RESEND_API_KEY");
            }

            problems.addAll(databaseViolations(environment.getProperty("spring.datasource.url", ""), environment.getProperty("spring.flyway.url", "")));
            if (environment.acceptsProfiles(Profiles.of("dev"))) {
                problems.add("the dev profile (public simulator secret, plain cookies) must never be combined with prod");
            }
        }
        if (!problems.isEmpty()) {
            throw new IllegalStateException("Unsafe configuration, refusing to start: " + String.join("; ", problems));
        }
    }

    private static final Pattern SSL_MODE = Pattern.compile("[?&]sslmode=(require|verify-ca|verify-full)(&|$)");
    private static final Pattern LOOPBACK_HOST = Pattern.compile("^jdbc:postgresql://(localhost|127\\.0\\.0\\.1|\\[::1\\])([:/?]|$)");

    /**
     * In production the database connection must be encrypted: the URL must say {@code sslmode=require} (or stricter),
     * unless the database is on this machine. An empty Flyway URL means "same as the application". Never echoes the URL,
     * which may carry credentials.
     */
    public static List<String> databaseViolations(String jdbcUrl, String flywayUrl) {
        List<String> problems = new ArrayList<>();
        if (!encrypted(jdbcUrl)) {
            problems.add("the database URL must enable TLS (add sslmode=require or stricter) unless the database is local");
        }
        if (flywayUrl != null && !flywayUrl.isBlank() && !encrypted(flywayUrl)) {
            problems.add("the Flyway database URL must enable TLS (add sslmode=require or stricter) unless the database is local");
        }
        return problems;
    }

    private static boolean encrypted(String url) {
        return url != null && (SSL_MODE.matcher(url).find() || LOOPBACK_HOST.matcher(url).find());
    }

    public static List<String> violations(boolean prod, SecurityProperties security, EmailProperties email,
                                          SimulatedProviderProperties simulator, AppProperties app, String smtpHost) {
        List<String> problems = new ArrayList<>();
        var session = security.session();
        if (session.cookieName().startsWith("__Host-") && !session.secureCookie()) {
            problems.add("a __Host- session cookie must be Secure");
        }
        if ("None".equalsIgnoreCase(session.sameSite())) {
            problems.add("the session cookie must not be SameSite=None");
        }
        if (security.origins().allowed().stream().anyMatch(o -> o.contains("*"))) {
            problems.add("oupay.security.origins.allowed must not contain wildcards");
        }
        if (simulator.enabled() && simulator.sharedSecret().isBlank()) {
            problems.add("the simulated provider is enabled without a shared secret");
        }
        if (prod) {
            if (!session.secureCookie()) {
                problems.add("the session cookie must be Secure in production");
            }
            if (simulator.enabled()) {
                problems.add("the simulated bank provider must be disabled in production");
            }
            String provider = email.provider().toLowerCase(java.util.Locale.ROOT);

            if ("smtp".equals(provider)) {
                if (smtpHost == null || smtpHost.isBlank()) {
                    problems.add("SMTP requires spring.mail.host");
                }
            } else if (!"resend".equals(provider)) {
                problems.add("Production requires smtp or resend email provider");
            }
            if (email.sinkEndpointEnabled()) {
                problems.add("the dev mail endpoint must be disabled in production");
            }
            if (!app.baseUrl().startsWith("https://")) {
                problems.add("oupay.app.base-url must be https:// in production (links in e-mails)");
            }
        }
        return problems;
    }
}
