package rw.oupay.kyc;

import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;
import org.springframework.mock.env.MockEnvironment;

class KycEvidenceStartupGuardTest {

    @Test
    void recordingTheBanksHandlingCanOnlyBeEnabledUnderTheTestProfileAndNeverWithProd() {
        for (String profile : new String[] {"prod", "staging", "dev", "production", "default"}) {
            MockEnvironment environment = new MockEnvironment();
            environment.setActiveProfiles(profile);
            assertThatThrownBy(() -> new KycEvidenceStartupGuard(environment, true, false)).as(profile).isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("oupay.kyc.evidence-recording-enabled");
            new KycEvidenceStartupGuard(environment, false, false);
        }
        assertThatThrownBy(() -> new KycEvidenceStartupGuard(new MockEnvironment(), true, false)).isInstanceOf(IllegalStateException.class);
        MockEnvironment test = new MockEnvironment();
        test.setActiveProfiles("test");
        new KycEvidenceStartupGuard(test, true, true);
        MockEnvironment both = new MockEnvironment();
        both.setActiveProfiles("prod", "test");
        assertThatThrownBy(() -> new KycEvidenceStartupGuard(both, true, false)).isInstanceOf(IllegalStateException.class);
    }

    @Test
    void showingAProtectedValueInFullIsRefusedOutsideTheTestProfileToo() {
        for (String profile : new String[] {"prod", "staging", "dev", "default"}) {
            MockEnvironment environment = new MockEnvironment();
            environment.setActiveProfiles(profile);
            assertThatThrownBy(() -> new KycEvidenceStartupGuard(environment, false, true)).as(profile).isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("oupay.kyc.reveal-enabled");
        }
        MockEnvironment both = new MockEnvironment();
        both.setActiveProfiles("prod", "test");
        assertThatThrownBy(() -> new KycEvidenceStartupGuard(both, false, true)).isInstanceOf(IllegalStateException.class);
        new KycEvidenceStartupGuard(new MockEnvironment(), false, false);
    }
}
