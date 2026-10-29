package rw.oupay.kyc;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.env.Environment;
import org.springframework.core.env.Profiles;
import org.springframework.stereotype.Component;

/**
 * Recording what the bank did with a KYC application can be enabled ONLY under the {@code test} profile, and never together with {@code prod}.
 * Under any other profile (production, staging, dev, none) the application refuses to start with
 * {@code oupay.kyc.evidence-recording-enabled=true}. An allow-list, like {@code CollectionCodeApprovalStartupGuard}: until OuPay can verify bank
 * evidence or authenticate operators, no public deployment can switch this on by configuration or an environment variable by accident.
 */
@Component
public final class KycEvidenceStartupGuard {

    public KycEvidenceStartupGuard(Environment environment, @Value("${oupay.kyc.evidence-recording-enabled:false}") boolean enabled,
                                   @Value("${oupay.kyc.reveal-enabled:false}") boolean revealEnabled) {
        boolean testOnly = environment.acceptsProfiles(Profiles.of("test")) && !environment.acceptsProfiles(Profiles.of("prod"));
        // Showing a saved protected value in full has no separately secured workflow yet (no step-up authentication): same rule.
        if (revealEnabled && !testOnly) {
            throw new IllegalStateException("Unsafe configuration, refusing to start: oupay.kyc.reveal-enabled may only be true under the test "
                    + "profile (and never together with prod), until a separately secured reveal workflow exists");
        }
        if (enabled && !testOnly) {
            throw new IllegalStateException("Unsafe configuration, refusing to start: oupay.kyc.evidence-recording-enabled may only be true under the test "
                    + "profile (and never together with prod), until bank evidence is verified by a real integration or an authenticated operator process exists");
        }
    }
}
