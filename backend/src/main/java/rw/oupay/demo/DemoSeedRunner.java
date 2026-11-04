package rw.oupay.demo;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.stereotype.Component;

/**
 * Runs the seeder once at start-up and then exits, when started as {@code mvn spring-boot:run -Dspring-boot.run.profiles=demo-seed} (the profile
 * file sets {@code run-on-startup} and {@code exit-after-run}; {@code enabled} is never set by a file and must be given explicitly). The exit code
 * is non-zero when the seeder refuses or fails. It exists only when {@code run-on-startup} is true, which {@link DemoSeedStartupGuard} allows only
 * under the demo-seed profile and never with prod.
 */
@Component
@ConditionalOnProperty(prefix = "oupay.demo-seed", name = "run-on-startup", havingValue = "true")
class DemoSeedRunner implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(DemoSeedRunner.class);

    private final DemoSeeder seeder;
    private final ConfigurableApplicationContext context;
    private final boolean exitAfterRun;

    DemoSeedRunner(DemoSeeder seeder, ConfigurableApplicationContext context, @Value("${oupay.demo-seed.exit-after-run:false}") boolean exitAfterRun) {
        this.seeder = seeder;
        this.context = context;
        this.exitAfterRun = exitAfterRun;
    }

    @Override
    public void run(ApplicationArguments args) {
        int code = 0;
        try {
            SeedReport report = seeder.seed();
            log.info("demonstration seed report:{}{}", System.lineSeparator(), report);
        } catch (RuntimeException e) {
            log.error("demonstration seed did not run: {}", e.getMessage());
            code = 1;
        }
        if (exitAfterRun) {
            int exit = code;
            System.exit(SpringApplication.exit(context, () -> exit));
        }
    }
}
