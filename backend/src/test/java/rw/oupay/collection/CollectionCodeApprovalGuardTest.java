package rw.oupay.collection;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Clock;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.mock.env.MockEnvironment;
import rw.oupay.common.ApiException;

/**
 * Bank approval of a collection code is OFF unless explicitly enabled, and the application refuses to start with it enabled in production:
 * OuPay cannot yet verify bank evidence or authenticate operators, so two user ids are not proof of an independent decision.
 */
class CollectionCodeApprovalGuardTest {

    private static CollectionCodeApprovalService service(MockEnvironment environment, boolean enabled) {
        return new CollectionCodeApprovalService(null, null, null, null, null, Clock.systemUTC(), environment, enabled);
    }

    @Test
    void approvalAndResumeAreUnavailableByDefault() {
        CollectionCodeApprovalService service = service(new MockEnvironment(), false);
        var evidence = new CollectionCodeApprovalService.Evidence(ApprovalSource.OPERATOR, "EV-1", UUID.randomUUID(), UUID.randomUUID());
        assertThatThrownBy(() -> service.approve(UUID.randomUUID(), UUID.randomUUID(), "TILL-1", evidence))
                .isInstanceOfSatisfying(ApiException.class, e -> assertThat(e.code()).isEqualTo("not_implemented"));
        assertThatThrownBy(() -> service.approve(UUID.randomUUID(), UUID.randomUUID(), "TILL-1",
                new CollectionCodeApprovalService.Evidence(ApprovalSource.BANK_EVENT, "EVT-1", null, null)))
                .isInstanceOfSatisfying(ApiException.class, e -> assertThat(e.code()).isEqualTo("not_implemented"));
        assertThatThrownBy(() -> service.resume(UUID.randomUUID(), UUID.randomUUID(), "EV-2", UUID.randomUUID()))
                .isInstanceOfSatisfying(ApiException.class, e -> assertThat(e.code()).isEqualTo("not_implemented"));
    }

    @Test
    void theApplicationRefusesToStartWithApprovalEnabledInProduction() {
        MockEnvironment production = new MockEnvironment();
        production.setActiveProfiles("prod");
        assertThatThrownBy(() -> service(production, true)).isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("oupay.collection-codes.approval-enabled");
        // Disabled in production is the normal, safe configuration; enabled outside production is for tests.
        service(production, false);
        service(new MockEnvironment(), true);
    }
}
