package rw.oupay.pos;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.lang.reflect.Method;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;

/** The worker: on by default, every 15 seconds, one batch per run, never throws into the scheduler, and does nothing at all when switched off. */
class PosFulfilmentWorkerTest {

    @Test
    void itRunsOneBatchPerPollWhenEnabledAndNothingWhenSwitchedOff() {
        PosFulfilmentService service = mock(PosFulfilmentService.class);
        when(service.processDue(anyInt())).thenReturn(new PosFulfilmentService.Summary(1, 0, 0, 0));
        new PosFulfilmentWorker(service, true, 7).poll();
        verify(service).processDue(7);
        PosFulfilmentService off = mock(PosFulfilmentService.class);
        new PosFulfilmentWorker(off, false, 7).poll();
        verify(off, never()).processDue(anyInt());
    }

    @Test
    void aFailingRunNeverEscapesIntoTheSchedulerAndTheNextRunStillHappens() {
        PosFulfilmentService service = mock(PosFulfilmentService.class);
        when(service.processDue(anyInt())).thenThrow(new IllegalStateException("database is down")).thenReturn(new PosFulfilmentService.Summary(0, 0, 0, 0));
        PosFulfilmentWorker worker = new PosFulfilmentWorker(service, true, 25);
        worker.poll();
        worker.poll();
        verify(service, org.mockito.Mockito.times(2)).processDue(25);
    }

    @Test
    void itIsScheduledEveryFifteenSecondsAndEnabledByDefaultInEveryConfigurationThatDoesNotSwitchItOff() throws Exception {
        Method poll = PosFulfilmentWorker.class.getDeclaredMethod("poll");
        assertThat(poll.getAnnotation(Scheduled.class).fixedDelayString()).isEqualTo("${oupay.pos.fulfilment.poll-interval:15s}");
        var constructor = PosFulfilmentWorker.class.getConstructors()[0];
        Value enabled = constructor.getParameters()[1].getAnnotation(Value.class);
        assertThat(enabled.value()).isEqualTo("${oupay.pos.fulfilment.enabled:true}");
        // Only the test profile switches it off (so tests can call the service themselves); dev and prod leave the default.
        assertThat(java.nio.file.Files.readString(java.nio.file.Path.of("src/test/resources/application-test.yml"))).contains("oupay.pos.fulfilment.enabled: false");
        assertThat(java.nio.file.Files.readString(java.nio.file.Path.of("src/main/resources/application-dev.yml"))).doesNotContain("fulfilment");
        assertThat(java.nio.file.Files.readString(java.nio.file.Path.of("src/main/resources/application-prod.yml"))).doesNotContain("fulfilment");
        assertThat(java.nio.file.Files.readString(java.nio.file.Path.of("src/main/resources/application.yml"))).doesNotContain("fulfilment");
    }
}
