package rw.oupay.sample;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.stereotype.Component;

/**
 * Runs the importer once at start-up, as {@code mvn spring-boot:run -Dspring-boot.run.profiles=sample-import}, and then ends. It exists only when
 * {@code run-on-startup} is true, which {@link SampleImportStartupGuard} allows only under the sample-import profile.
 *
 * <p>Without {@code oupay.sample-import.confirm-plan} it is a DRY RUN: it prints the preview and the fingerprint and writes nothing. With the
 * fingerprint of that preview it applies exactly that plan. The exit status follows Spring Boot's own lifecycle, with no {@code System.exit}: 0 when it
 * finished (a dry run, an import, or nothing to do), 1 when it refused or a step failed ({@link SampleImportRefusedException}).
 */
@Component
@ConditionalOnProperty(prefix = "oupay.sample-import", name = "run-on-startup", havingValue = "true")
class SampleImportRunner implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(SampleImportRunner.class);

    private final SampleImporter importer;
    private final SampleImportSettings settings;
    private final ConfigurableApplicationContext context;

    SampleImportRunner(SampleImporter importer, SampleImportSettings settings, ConfigurableApplicationContext context) {
        this.importer = importer;
        this.settings = settings;
        this.context = context;
    }

    @Override
    public void run(ApplicationArguments args) {
        try {
            SampleImporter.Preview preview = importer.preview();
            log.info("sample import preview:{}{}", System.lineSeparator(), preview.render());
            if (settings.confirmPlan().isEmpty()) {
                log.info("DRY RUN: nothing was written. To apply exactly this plan, run again with oupay.sample-import.confirm-plan={}", preview.fingerprint());
            } else {
                SampleImporter.Result result = importer.apply(settings.confirmPlan());
                log.info("sample import finished: {} created, {} already there, {} skipped", result.created(), result.kept(), result.skipped());
            }
        } catch (SampleImportRefusedException e) {
            log.error("{}", e.getMessage());
            throw e;
        } catch (RuntimeException e) {
            log.error("sample import failed: {}", e.getMessage());
            throw new SampleImportRefusedException("unexpected failure", e);
        }
        SpringApplication.exit(context, () -> 0);
    }
}
