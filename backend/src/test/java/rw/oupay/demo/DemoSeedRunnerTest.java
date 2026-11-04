package rw.oupay.demo;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ExitCodeEvent;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.DefaultApplicationArguments;
import org.springframework.context.ApplicationListener;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * R9: the one-shot seed command ends through Spring Boot's own lifecycle, with the right status, and nothing in the application halts the virtual
 * machine itself. A successful seed ends the command with status 0; a refused or failed seed fails the start-up with an exit-code-carrying
 * exception, which Spring Boot maps to a NON-ZERO status.
 */
class DemoSeedRunnerTest {

    private static final ApplicationArguments NO_ARGUMENTS = new DefaultApplicationArguments();

    // ---- the runner on its own ----------------------------------------------------------------------------------

    @Test
    void aSuccessfulSeedCompletesNormallyAndLeavesTheApplicationRunningWhenNoExitWasAsked() {
        DemoSeeder seeder = mock(DemoSeeder.class);
        ConfigurableApplicationContext context = mock(ConfigurableApplicationContext.class);
        when(seeder.seed()).thenReturn(new SeedReport());
        assertThatCode(() -> new DemoSeedRunner(seeder, context, false).run(NO_ARGUMENTS)).doesNotThrowAnyException();
        verify(context, never()).close();
    }

    @Test
    void aSuccessfulOneShotClosesTheApplicationContextSoTheProcessEndsNormally() {
        DemoSeeder seeder = mock(DemoSeeder.class);
        ConfigurableApplicationContext context = mock(ConfigurableApplicationContext.class);
        when(seeder.seed()).thenReturn(new SeedReport());
        assertThatCode(() -> new DemoSeedRunner(seeder, context, true).run(NO_ARGUMENTS)).doesNotThrowAnyException();
        verify(context).close();
    }

    @Test
    void aRefusedOrFailedSeedFailsTheStartUpWithANonZeroExitCodeAndKeepsTheReason() {
        DemoSeeder seeder = mock(DemoSeeder.class);
        ConfigurableApplicationContext context = mock(ConfigurableApplicationContext.class);
        IllegalStateException refusal = new IllegalStateException("Refusing to seed: this database is not designated as a demonstration environment");
        when(seeder.seed()).thenThrow(refusal);
        for (boolean exitAfterRun : new boolean[] {true, false}) {
            assertThatThrownBy(() -> new DemoSeedRunner(seeder, context, exitAfterRun).run(NO_ARGUMENTS))
                    .isInstanceOfSatisfying(DemoSeedFailedException.class, e -> {
                        assertThat(e.getExitCode()).isNotZero().isEqualTo(DemoSeedFailedException.EXIT_CODE);
                        assertThat(e).hasCause(refusal).hasMessageContaining("not designated as a demonstration environment");
                    });
        }
        // The runner does not tear the context down itself on failure: Spring Boot's failure handling does, and reports the exit code.
        verify(context, never()).close();
    }

    // ---- through a real SpringApplication: the exit semantics Spring Boot actually applies ---------------------------

    @Configuration(proxyBeanMethods = false)
    static class Refusing {
        @Bean
        DemoSeeder seeder() {
            DemoSeeder seeder = mock(DemoSeeder.class);
            when(seeder.seed()).thenThrow(new IllegalStateException("Refusing to seed: test refusal"));
            return seeder;
        }

        @Bean
        DemoSeedRunner runner(DemoSeeder seeder, ConfigurableApplicationContext context) {
            return new DemoSeedRunner(seeder, context, true);
        }
    }

    @Configuration(proxyBeanMethods = false)
    static class Succeeding {
        @Bean
        DemoSeeder seeder() {
            DemoSeeder seeder = mock(DemoSeeder.class);
            when(seeder.seed()).thenReturn(new SeedReport());
            return seeder;
        }

        @Bean
        DemoSeedRunner runner(DemoSeeder seeder, ConfigurableApplicationContext context) {
            return new DemoSeedRunner(seeder, context, true);
        }
    }

    @Test
    void springBootResolvesAFailedSeedToExitStatusOneAndEndsTheContext() {
        List<Integer> exitCodes = new ArrayList<>();
        ApplicationListener<ExitCodeEvent> listener = event -> exitCodes.add(event.getExitCode());
        SpringApplicationBuilder builder = new SpringApplicationBuilder(Refusing.class).web(WebApplicationType.NONE).listeners(listener)
                .properties("spring.main.banner-mode=off", "logging.level.root=OFF");
        assertThatThrownBy(builder::run).hasRootCauseInstanceOf(IllegalStateException.class).hasStackTraceContaining("DemoSeedFailedException");
        // Exactly the status the one-shot command ends with: non-zero, and it is the one the exception carries.
        assertThat(exitCodes).containsExactly(1);
    }

    @Test
    void springBootEndsASuccessfulOneShotWithStatusZeroAfterClosingTheContext() {
        List<Integer> exitCodes = new ArrayList<>();
        ApplicationListener<ExitCodeEvent> listener = event -> exitCodes.add(event.getExitCode());
        SpringApplicationBuilder builder = new SpringApplicationBuilder(Succeeding.class).web(WebApplicationType.NONE).listeners(listener)
                .properties("spring.main.banner-mode=off", "logging.level.root=OFF");
        ConfigurableApplicationContext context = builder.run();
        // The runner closed it: nothing is left running, so the JVM of the command ends on its own, and no failure status was ever raised.
        assertThat(context.isActive()).isFalse();
        assertThat(exitCodes).isEmpty();
    }

    // ---- nothing halts the JVM ----------------------------------------------------------------------------------

    @Test
    void noSeederSourceCallsSystemExitOrHaltsTheVirtualMachine() throws IOException {
        try (Stream<Path> sources = Files.walk(Path.of("src/main/java/rw/oupay/demo"))) {
            for (Path file : sources.filter(p -> p.toString().endsWith(".java")).toList()) {
                String text = Files.readString(file);
                assertThat(text).as(file.toString()).doesNotContain("System.exit(").doesNotContain("Runtime.getRuntime().halt").doesNotContain(".halt(");
            }
        }
    }
}
