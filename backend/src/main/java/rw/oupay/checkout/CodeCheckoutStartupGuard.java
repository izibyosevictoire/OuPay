package rw.oupay.checkout;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.env.Environment;
import org.springframework.core.env.Profiles;
import org.springframework.stereotype.Component;

/**
 * Live collection with bank codes can be enabled ONLY under the {@code test} profile, and never together with {@code prod}. Equity has not
 * confirmed that a code can take a payment, that a payment can carry a sale reference, or that notifications return either, and OuPay has no
 * Equity integration: until then no deployment may present a bank code to a customer as a way to pay. An allow-list, like the other R6 guards.
 */
@Component
public final class CodeCheckoutStartupGuard {

    public CodeCheckoutStartupGuard(Environment environment, @Value("${oupay.code-checkout.live-enabled:false}") boolean liveEnabled) {
        boolean testOnly = environment.acceptsProfiles(Profiles.of("test")) && !environment.acceptsProfiles(Profiles.of("prod"));
        if (liveEnabled && !testOnly) {
            throw new IllegalStateException("Unsafe configuration, refusing to start: oupay.code-checkout.live-enabled may only be true under the test "
                    + "profile (and never together with prod), until Equity confirms how a merchant code takes a payment and a real integration exists");
        }
    }
}
