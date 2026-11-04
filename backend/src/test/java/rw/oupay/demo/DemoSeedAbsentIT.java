package rw.oupay.demo;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.ApplicationContext;
import rw.oupay.support.IntegrationTest;

/** R9: in an ordinary application (every profile but demo-seed) the seeder does not exist at all, and the marker table is empty. */
class DemoSeedAbsentIT extends IntegrationTest {

    @Autowired
    ApplicationContext context;

    @Test
    void theSeederAndItsRunnerAreNotEvenBeansInAnOrdinaryApplication() {
        assertThat(context.getBeanNamesForType(DemoSeeder.class)).isEmpty();
        assertThat(context.getBeanNamesForType(DemoSeedRunner.class)).isEmpty();
        // The guard is always present, so an attempt to enable it elsewhere is refused at start-up.
        assertThat(context.getBeanNamesForType(DemoSeedStartupGuard.class)).hasSize(1);
    }

    @Test
    void aFreshDatabaseIsNotADemonstrationEnvironmentAndMigrationsNeverMakeItOne() {
        assertThat(count("demo_environment")).isZero();
        assertThat(count("demo_seed_registry")).isZero();
    }

    private int count(String table) {
        return jdbc.queryForObject("select count(*) from " + table, Integer.class);
    }
}
