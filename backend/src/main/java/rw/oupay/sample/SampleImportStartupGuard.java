package rw.oupay.sample;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.env.Environment;
import org.springframework.core.env.Profiles;
import org.springframework.stereotype.Component;

/**
 * The sample-data importer can be switched on ONLY under the dedicated {@code sample-import} profile, and never together with {@code prod} or
 * {@code demo-seed}. The deployed service runs {@code prod}: with the switch set there (by an environment variable, a stray property or a copied
 * configuration) the application REFUSES TO START, so the deployed service can never run an import, and there is no HTTP endpoint for it at all. The
 * importer is an operator command, run on an operator's machine against an explicitly named merchant.
 */
@Component
public final class SampleImportStartupGuard {

    public SampleImportStartupGuard(Environment environment, @Value("${oupay.sample-import.enabled:false}") boolean enabled,
                                    @Value("${oupay.sample-import.run-on-startup:false}") boolean runOnStartup) {
        if (!enabled && !runOnStartup) {
            return;
        }
        boolean importProfile = environment.acceptsProfiles(Profiles.of("sample-import"));
        boolean excluded = environment.acceptsProfiles(Profiles.of("prod", "demo-seed"));
        if (!importProfile || excluded) {
            throw new IllegalStateException("Unsafe configuration, refusing to start: the sample-data importer (oupay.sample-import.enabled / run-on-startup) "
                    + "may only be switched on under the sample-import profile, and never together with prod or demo-seed");
        }
        if (runOnStartup && !enabled) {
            throw new IllegalStateException("Unsafe configuration, refusing to start: oupay.sample-import.run-on-startup needs "
                    + "oupay.sample-import.enabled=true, which must be set explicitly and is never defaulted by a profile file");
        }
    }
}
