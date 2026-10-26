package rw.oupay.collection;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.env.Environment;
import org.springframework.core.env.Profiles;
import org.springframework.stereotype.Component;

/**
 * Bank approval of collection codes can be enabled ONLY under the {@code test} profile; under any other profile (production, staging, dev,
 * none) the application refuses to start with {@code oupay.collection-codes.approval-enabled=true}. It is an allow-list, not a deny-list of
 * {@code prod}, so no public deployment, whatever it is called, can switch approval on by configuration or environment variable by accident.
 *
 * <p>Why: OuPay cannot yet verify bank evidence or authenticate operators, so two user ids are not proof of an independent decision and a
 * caller naming a bank event is not proof the bank said anything (see {@link CollectionCodeApprovalService}). When a verifiable bank path or an
 * authenticated operator process exists, this guard is replaced by that mechanism in a reviewed change. Kept in its own final class (like
 * {@code ProductionSafetyCheck}) so that failing fast in the constructor is a deliberate, scoped choice.
 */
@Component
public final class CollectionCodeApprovalStartupGuard {

    public CollectionCodeApprovalStartupGuard(Environment environment,
                                              @Value("${oupay.collection-codes.approval-enabled:false}") boolean approvalEnabled) {
        // The test profile alone is not enough: a deployment that lists prod next to test (by mistake or by design) is still refused.
        boolean testOnly = environment.acceptsProfiles(Profiles.of("test")) && !environment.acceptsProfiles(Profiles.of("prod"));
        if (approvalEnabled && !testOnly) {
            throw new IllegalStateException("Unsafe configuration, refusing to start: oupay.collection-codes.approval-enabled may only be true under "
                    + "the test profile (and never together with prod), until bank evidence is verified by a real integration or an authenticated operator process exists");
        }
    }
}
