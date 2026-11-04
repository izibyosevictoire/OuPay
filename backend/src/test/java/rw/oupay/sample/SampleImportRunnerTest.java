package rw.oupay.sample;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.boot.DefaultApplicationArguments;
import org.springframework.context.ConfigurableApplicationContext;

/** R9b: the command is a DRY RUN unless it is given the fingerprint, and ends through Spring Boot's lifecycle with the right status. */
class SampleImportRunnerTest {

    private static final DefaultApplicationArguments NONE = new DefaultApplicationArguments();

    private static SampleImporter.Preview preview() {
        return new SampleImporter.Preview(UUID.randomUUID(), "Shop", "active", "db", "host",
                List.of(new SampleImporter.Step("branch:X", "branch", "X", SampleImporter.Action.CREATE, null, () -> { })), "0123456789abcdef");
    }

    private static SampleImportSettings settings(String confirm) {
        return new SampleImportSettings(UUID.randomUUID().toString(), "o@x.rw", "pw", confirm, "", "");
    }

    @Test
    void withoutAConfirmationItIsADryRunThatNeverAppliesAndEndsWithStatusZero() {
        SampleImporter importer = mock(SampleImporter.class);
        ConfigurableApplicationContext context = mock(ConfigurableApplicationContext.class);
        when(importer.preview()).thenReturn(preview());
        assertThatCode(() -> new SampleImportRunner(importer, settings(""), context).run(NONE)).doesNotThrowAnyException();
        verify(importer, never()).apply(anyString());
        verify(context).close();
    }

    @Test
    void withTheConfirmationItAppliesExactlyThatAndEndsWithStatusZero() {
        SampleImporter importer = mock(SampleImporter.class);
        ConfigurableApplicationContext context = mock(ConfigurableApplicationContext.class);
        when(importer.preview()).thenReturn(preview());
        when(importer.apply("0123456789abcdef")).thenReturn(new SampleImporter.Result(1, 0, 0, "0123456789abcdef"));
        assertThatCode(() -> new SampleImportRunner(importer, settings("0123456789abcdef"), context).run(NONE)).doesNotThrowAnyException();
        verify(importer).apply("0123456789abcdef");
        verify(context).close();
    }

    @Test
    void aRefusalFailsTheStartUpWithANonZeroExitCodeAndNothingIsApplied() {
        SampleImporter importer = mock(SampleImporter.class);
        ConfigurableApplicationContext context = mock(ConfigurableApplicationContext.class);
        when(importer.preview()).thenThrow(new SampleImportRefusedException("the owner credentials were not accepted"));
        assertThatThrownBy(() -> new SampleImportRunner(importer, settings("0123456789abcdef"), context).run(NONE))
                .isInstanceOfSatisfying(SampleImportRefusedException.class, e -> {
                    assertThat(e.getExitCode()).isNotZero().isEqualTo(SampleImportRefusedException.EXIT_CODE);
                    assertThat(e.getMessage()).contains("owner credentials were not accepted").doesNotContain("pw");
                });
        verify(importer, never()).apply(anyString());
    }

    @Test
    void anUnexpectedFailureAlsoEndsNonZero() {
        SampleImporter importer = mock(SampleImporter.class);
        ConfigurableApplicationContext context = mock(ConfigurableApplicationContext.class);
        when(importer.preview()).thenReturn(preview());
        when(importer.apply(anyString())).thenThrow(new IllegalStateException("database went away"));
        assertThatThrownBy(() -> new SampleImportRunner(importer, settings("0123456789abcdef"), context).run(NONE))
                .isInstanceOfSatisfying(SampleImportRefusedException.class, e -> assertThat(e.getExitCode()).isEqualTo(1));
    }
}
