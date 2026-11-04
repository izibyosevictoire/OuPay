package rw.oupay.demo;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.springframework.mock.env.MockEnvironment;

/** R9: production (or any other profile) can never trigger the demonstration seeder, by property, environment variable or copied configuration. */
class DemoSeedGuardTest {

    private static MockEnvironment profiles(String... active) {
        MockEnvironment environment = new MockEnvironment();
        environment.setActiveProfiles(active);
        return environment;
    }

    @Test
    void productionStagingDevAndNoProfileRefuseToStartWithTheSeederSwitchedOn() {
        for (String[] active : new String[][] {{"prod"}, {"staging"}, {"dev"}, {}, {"test"}, {"prod", "demo-seed"}, {"demo-seed", "prod"}}) {
            assertThatThrownBy(() -> new DemoSeedStartupGuard(profiles(active), true, false)).as(String.join(",", active))
                    .isInstanceOf(IllegalStateException.class).hasMessageContaining("Unsafe configuration, refusing to start");
            assertThatThrownBy(() -> new DemoSeedStartupGuard(profiles(active), false, true)).as("startup run, " + String.join(",", active))
                    .isInstanceOf(IllegalStateException.class);
        }
    }

    @Test
    void theStartupRunSwitchNeverWorksWithoutTheExplicitEnableSwitch() {
        assertThatThrownBy(() -> new DemoSeedStartupGuard(profiles("demo-seed"), false, true)).isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("needs oupay.demo-seed.enabled=true");
    }

    @Test
    void onlyTheDedicatedProfileWithTheExplicitSwitchIsAllowedAndOffIsAlwaysFine() {
        assertThatCode(() -> new DemoSeedStartupGuard(profiles("demo-seed"), true, true)).doesNotThrowAnyException();
        assertThatCode(() -> new DemoSeedStartupGuard(profiles("demo-seed"), true, false)).doesNotThrowAnyException();
        for (String[] active : new String[][] {{"prod"}, {}, {"dev"}, {"demo-seed"}}) {
            assertThatCode(() -> new DemoSeedStartupGuard(profiles(active), false, false)).doesNotThrowAnyException();
        }
    }

    @Test
    void noConfigurationFileSwitchesTheSeederOnAndTheProfileFileNeverSetsTheDangerousSettings() throws IOException {
        String profile = Files.readString(Path.of("src/main/resources/application-demo-seed.yml"));
        // The profile file runs the seeder once and exits, but never enables it, confirms a database, allows a host or carries a password.
        assertThat(profile).doesNotContain("enabled: true").doesNotContain("confirm-database").doesNotContain("allowed-db-hosts")
                .doesNotContainPattern("(?im)^\s*[a-z-]*password\s*:");
        for (String file : new String[] {"application.yml", "application-prod.yml", "application-dev.yml"}) {
            String text = Files.readString(Path.of("src/main/resources/" + file));
            assertThat(text).as(file).doesNotContain("demo-seed");
        }
        // The production image removes development-only configuration; nothing in the product ships a seed password.
        assertThat(Files.readString(Path.of("src/main/java/rw/oupay/demo/DemoSeeder.java"))).doesNotContain("Passw0rd").doesNotContain("password = \"");
    }
}
