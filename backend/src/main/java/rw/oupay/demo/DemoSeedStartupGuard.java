package rw.oupay.demo;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.env.Environment;
import org.springframework.core.env.Profiles;
import org.springframework.stereotype.Component;

/**
 * The demonstration seeder can be switched on ONLY under the dedicated {@code demo-seed} profile, and never together with {@code prod}. Under any
 * other profile (production, staging, dev, none) the application REFUSES TO START with {@code oupay.demo-seed.enabled=true} (or the startup-run
 * switch), so no deployment can trigger the seeder by an environment variable, a stray property or a copied configuration.
 *
 * <p>This is the first of three independent locks. The second is the database itself (the seeder refuses a database that an operator has not
 * designated as a demonstration environment by hand, see V20), the third is an explicit allow-list of database hosts plus a confirmation of the
 * database name. Kept in its own final class, like the other startup guards, so that failing fast in the constructor is a deliberate, scoped choice.
 */
@Component
public final class DemoSeedStartupGuard {

    public DemoSeedStartupGuard(Environment environment, @Value("${oupay.demo-seed.enabled:false}") boolean enabled,
                                @Value("${oupay.demo-seed.run-on-startup:false}") boolean runOnStartup) {
        if (!enabled && !runOnStartup) {
            return;
        }
        boolean seedProfile = environment.acceptsProfiles(Profiles.of("demo-seed"));
        boolean prod = environment.acceptsProfiles(Profiles.of("prod"));
        if (!seedProfile || prod) {
            throw new IllegalStateException("Unsafe configuration, refusing to start: the demonstration seeder (oupay.demo-seed.enabled / run-on-startup) "
                    + "may only be switched on under the demo-seed profile, and never together with prod");
        }
        if (runOnStartup && !enabled) {
            throw new IllegalStateException("Unsafe configuration, refusing to start: oupay.demo-seed.run-on-startup needs oupay.demo-seed.enabled=true, "
                    + "which must be set explicitly and is never defaulted by a profile file");
        }
    }
}
