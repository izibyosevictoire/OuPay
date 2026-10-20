package rw.oupay.idempotency;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class RequestFingerprintTest {

    private static final Map<String, Object> ROUTE = Map.of("merchantId", "m-1");

    private static String of(Object body) {
        return RequestFingerprint.of("POS_BILL", ROUTE, body);
    }

    @Test
    void isALowerCaseSha256Digest() {
        assertThat(of(Map.of("a", 1))).matches("^[0-9a-f]{64}$");
    }

    @Test
    void ignoresTheOrderOfObjectFields() {
        var first = new LinkedHashMap<String, Object>();
        first.put("branchId", "b-1");
        first.put("customer", Map.of("name", "Imena", "phone", "0788"));
        var second = new LinkedHashMap<String, Object>();
        second.put("customer", Map.of("phone", "0788", "name", "Imena"));
        second.put("branchId", "b-1");
        assertThat(of(first)).isEqualTo(of(second));
    }

    @Test
    void treatsNumbersWithTheSameValueAsTheSame() {
        assertThat(of(Map.of("quantity", 2))).isEqualTo(of(Map.of("quantity", 2.0)));
        assertThat(of(Map.of("quantity", 2))).isEqualTo(of(Map.of("quantity", new java.math.BigDecimal("2.000"))));
        assertThat(of(Map.of("quantity", 2))).isNotEqualTo(of(Map.of("quantity", 2.001)));
        assertThat(of(Map.of("quantity", 0))).isEqualTo(of(Map.of("quantity", new java.math.BigDecimal("0.00"))));
    }

    @Test
    void keepsTheOrderOfArrays() {
        assertThat(of(Map.of("items", List.of("a", "b")))).isNotEqualTo(of(Map.of("items", List.of("b", "a"))));
    }

    @Test
    void differentDataGivesADifferentFingerprint() {
        assertThat(of(Map.of("amount", 1000))).isNotEqualTo(of(Map.of("amount", 1001)));
        assertThat(of(Map.of("note", "a"))).isNotEqualTo(of(Map.of("note", "b")));
        assertThat(of(Map.of("flag", true))).isNotEqualTo(of(Map.of("flag", false)));
        assertThat(of(null)).isNotEqualTo(of(Map.of()));
    }

    @Test
    void aNumberAndItsTextAreDifferentValues() {
        assertThat(of(Map.of("code", 7))).isNotEqualTo(of(Map.of("code", "7")));
    }

    @Test
    void theOperationAndTheRouteAreParts() {
        Map<String, Object> body = Map.of("amount", 1);
        String billed = RequestFingerprint.of("POS_BILL", ROUTE, body);
        assertThat(RequestFingerprint.of("POS_CANCEL", ROUTE, body)).isNotEqualTo(billed);
        assertThat(RequestFingerprint.of("POS_BILL", Map.of("merchantId", "m-2"), body)).isNotEqualTo(billed);
        assertThat(RequestFingerprint.of("POS_BILL", Map.of("merchantId", "m-1", "invoiceId", UUID.randomUUID()), body)).isNotEqualTo(billed);
    }

    @Test
    void stringsCannotImpersonateStructure() {
        // A value that merely looks like JSON must not collide with a real nested structure.
        assertThat(of(Map.of("a", "{\"b\":1}"))).isNotEqualTo(of(Map.of("a", Map.of("b", 1))));
        assertThat(of(Map.of("a", "x\"y"))).isNotEqualTo(of(Map.of("a", "x", "y", "")));
    }

    @Test
    void producesTheSameFingerprintEveryTime() {
        assertThat(RequestFingerprint.canonical(Map.of("b", List.of(1, 2), "a", "x"))).isEqualTo("{\"a\":\"x\",\"b\":[1,2]}");
        assertThat(of(Map.of("a", 1))).isEqualTo(of(Map.of("a", 1)));
    }
}
