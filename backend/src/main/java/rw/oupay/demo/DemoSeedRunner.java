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
 * Runs the seeder once at start-up and then ends, when started as {@code mvn spring-boot:run -Dspring-boot.run.profiles=demo-seed} (the profile
 * file sets {@code run-on-startup} and {@code exit-after-run}; {@code enabled} is never set by a file and must be given explicitly). It exists only
 * when {@code run-on-startup} is true, which {@link DemoSeedStartupGuard} allows only under the demo-seed profile and never with prod.
 *
 * <h2>Exit status, through Spring Boot's own lifecycle (no {@code System.exit})</h2>
 * <ul>
 *   <li><b>Seeded (or nothing left to seed): status 0.</b> With {@code exit-after-run}, the runner closes the application context through
 *       {@link SpringApplication#exit}. Once the context is closed nothing keeps the JVM alive (the web server and the schedulers stop), so the
 *       process ends normally with status 0.</li>
 *   <li><b>Refused or failed: status 1.</b> The runner fails the start-up with a {@link DemoSeedFailedException}, which is an
 *       {@link org.springframework.boot.ExitCodeGenerator}: Spring Boot's failure handling resolves its code and ends the process with it. Nothing
 *       in the application halts the virtual machine itself.</li>
 * </ul>
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
        SeedReport report;
        try {
            report = seeder.seed();
        } catch (RuntimeException e) {
            log.error("demonstration seed did not run: {}", e.getMessage());
            throw new DemoSeedFailedException(e);
        }
        log.info("demonstration seed report:{}{}", System.lineSeparator(), report);
        if (exitAfterRun) {
            SpringApplication.exit(context, () -> 0);
        }
    }
}
