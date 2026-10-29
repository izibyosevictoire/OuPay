package rw.oupay.kyc;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import rw.oupay.common.ApiException;
import rw.oupay.kyc.KycRequirements.AppliesWhen;
import rw.oupay.kyc.KycRequirements.Field;
import rw.oupay.kyc.KycRequirements.Option;

class KycRequirementsTest {

    private static Field field(String type, Integer max, String pattern, List<Option> options) {
        return new Field("f.key", "S", "Test field", type, true, true, max, pattern, "Use digits.", null, options, null);
    }

    @Test
    void validatesEachTypeAndNeverEchoesTheValue() {
        assertThat(KycRequirements.validate(field("TEXT", 10, null, null), "  hello  ")).isEqualTo("hello");
        assertThat(KycRequirements.validate(field("EMAIL", null, null, null), "a@b.rw")).isEqualTo("a@b.rw");
        assertThat(KycRequirements.validate(field("PHONE", null, null, null), "+250 788 123 456")).isEqualTo("+250 788 123 456");
        assertThat(KycRequirements.validate(field("CHOICE", null, null, List.of(new Option("YES", "Yes"))), "YES")).isEqualTo("YES");
        for (var bad : List.of(
                field("TEXT", 3, null, null), field("EMAIL", null, null, null), field("PHONE", null, null, null),
                field("CHOICE", null, null, List.of(new Option("YES", "Yes"))), field("TEXT", 50, "^[0-9]+$", null))) {
            assertThatThrownBy(() -> KycRequirements.validate(bad, "SECRET-VALUE-9")).isInstanceOf(ApiException.class).hasMessageNotContaining("SECRET-VALUE-9");
        }
        assertThatThrownBy(() -> KycRequirements.validate(field("TEXT", 10, null, null), "   ")).isInstanceOf(ApiException.class);
        assertThatThrownBy(() -> KycRequirements.validate(field("TEXT", 10, null, null), "a\nb")).isInstanceOf(ApiException.class);
    }

    @Test
    void aConditionHidesAFieldUntilItsAnswerMatches() {
        AppliesWhen when = new AppliesWhen("bank.hasEquityAccount", List.of("YES"));
        assertThat(KycRequirements.applies(null, Map.of())).isTrue();
        assertThat(KycRequirements.applies(when, Map.of())).isFalse();
        assertThat(KycRequirements.applies(when, Map.of("bank.hasEquityAccount", "NO"))).isFalse();
        assertThat(KycRequirements.applies(when, Map.of("bank.hasEquityAccount", "YES"))).isTrue();
    }
}
