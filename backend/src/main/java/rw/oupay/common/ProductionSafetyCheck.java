package rw.oupay.common;

import java.util.ArrayList;
import java.util.List;
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
public class ProductionSafetyCheck {

    public ProductionSafetyCheck(Environment environment, SecurityProperties security, EmailProperties email,
                                 SimulatedProviderProperties simulator, AppProperties app) {
        boolean prod = environment.acceptsProfiles(Profiles.of("prod"));
        List<String> problems = violations(prod, security, email, simulator, app, environment.getProperty("spring.mail.host", ""));
        if (!problems.isEmpty()) {
            throw new IllegalStateException("Unsafe configuration, refusing to start: " + String.join("; ", problems));
        }
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
            if (!"smtp".equalsIgnoreCase(email.provider()) || smtpHost == null || smtpHost.isBlank()) {
                problems.add("production needs oupay.email.provider=smtp and spring.mail.host (the dev mail sink drops real mail)");
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
