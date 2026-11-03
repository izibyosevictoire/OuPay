package rw.oupay.checkout;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpMethod;
import org.springframework.test.context.TestPropertySource;
import rw.oupay.support.TestApi;
import tools.jackson.databind.JsonNode;

/**
 * R8a: shared set-up for the payment-entry device tests. A device is only a doorway to an EXISTING code sale, so every scenario builds real
 * LIVE (or demonstration) POS sales through the real billing API, pays them with the authenticated bank simulator, and goes through the real
 * HTTP API for both the merchant and the customer side. Everything is synthetic.
 */
@TestPropertySource(properties = {
        "oupay.collection-codes.approval-enabled=true",
        "oupay.code-checkout.live-enabled=true",
        "oupay.code-checkout.instructions=Open the bank app|Pay to the merchant code shown",
        "oupay.pos.approved-tax-treatments=EXEMPT:0,ZERO_RATED:0,STANDARD:1800,NOT_APPLICABLE:0",
        "oupay.pos.reservation-review-grace=PT0S"})
abstract class PaymentEntryTestSupport extends PosBillingTestSupport {

    String devices() {
        return "/api/v1/merchants/" + w.merchantId + "/entry-devices";
    }

    String publicPath(String token) {
        return "/api/v1/public/entry/" + token;
    }

    // ---- merchant side -----------------------------------------------------------------------

    Map<String, Object> deviceBody(String type, String name, UUID cashier) {
        Map<String, Object> body = new HashMap<>();
        body.put("clientRequestId", UUID.randomUUID().toString());
        body.put("deviceType", type);
        body.put("displayName", name);
        body.put("branchId", w.branchId.toString());
        body.put("assignedCashierUserId", cashier == null ? null : cashier.toString());
        return body;
    }

    TestApi.Response register(TestApi api, String type, String name, UUID cashier) {
        return api.post(devices(), deviceBody(type, name, cashier));
    }

    /** A device registered by the owner. */
    JsonNode device(String type, String name, UUID cashier) {
        var response = register(w.owner, type, name, cashier);
        assertThat(response.status()).as(response.body()).isEqualTo(201);
        return response.json().path("device");
    }

    JsonNode fresh(JsonNode device) {
        var response = w.owner.get(devices() + "/" + device.path("id").asString());
        assertThat(response.status()).as(response.body()).isEqualTo(200);
        return response.json();
    }

    String token(JsonNode device) {
        String path = device.path("entryPath").asString();
        assertThat(path).startsWith("/e/");
        return path.substring(3);
    }

    TestApi.Response bind(TestApi api, JsonNode device, JsonNode sale) {
        return api.post(devices() + "/" + device.path("id").asString() + "/binding",
                Map.of("saleId", saleId(sale), "expectedVersion", fresh(device).path("version").asLong()));
    }

    JsonNode bound(JsonNode device, JsonNode sale) {
        var response = bind(w.owner, device, sale);
        assertThat(response.status()).as(response.body()).isEqualTo(200);
        return response.json();
    }

    TestApi.Response unbind(TestApi api, JsonNode device, boolean confirm) {
        return api.post(devices() + "/" + device.path("id").asString() + "/binding/end", Map.of("reason", "Customer finished", "confirmActiveSession", confirm));
    }

    TestApi.Response lifecycle(TestApi api, JsonNode device, String action, String reason) {
        return api.post(devices() + "/" + device.path("id").asString() + "/" + action, Map.of("expectedVersion", fresh(device).path("version").asLong(), "reason", reason));
    }

    // ---- sales -------------------------------------------------------------------------------

    String saleId(JsonNode sale) {
        return sale.path("sale").path("saleId").asString();
    }

    /** A LIVE POS sale billed by Aline (the cashier who holds the live code). */
    JsonNode liveSale() {
        live();
        return billed(saveDraft(line(rice, "1", "kg")));
    }

    long amount(JsonNode sale) {
        return sale.path("sale").path("amountRwf").asLong();
    }

    void pay(JsonNode sale) {
        assertThat(w.bank.payWithCode("POSTED", amount(sale), reference(sale), "EQ-LIVE-77").outcome()).isEqualTo("APPLIED");
    }

    // ---- customer side -----------------------------------------------------------------------

    TestApi.Response viewAs(String token, String claim) {
        return TestApi.anonymous(mvc, HttpMethod.GET, publicPath(token), null, claim == null ? Map.of() : Map.of("X-Entry-Claim", claim));
    }

    TestApi.Response claimAs(String token, String claim) {
        return TestApi.anonymous(mvc, HttpMethod.POST, publicPath(token) + "/claim", null, claim == null ? Map.of() : Map.of("X-Entry-Claim", claim));
    }

    TestApi.Response releaseAs(String token, String claim) {
        return TestApi.anonymous(mvc, HttpMethod.POST, publicPath(token) + "/release", null, claim == null ? Map.of() : Map.of("X-Entry-Claim", claim));
    }

    /** The server omits null fields from its JSON: a field is "absent" when it is missing or null. */
    static boolean absent(JsonNode node) {
        return node.isMissingNode() || node.isNull();
    }

    String state(TestApi.Response response) {
        assertThat(response.status()).as(response.body()).isEqualTo(200);
        return response.json().path("state").asString();
    }

    /** Takes the device as a new customer and returns the claim token. */
    String claimToken(String token) {
        var response = claimAs(token, null);
        assertThat(state(response)).isEqualTo("CLAIMED");
        String claim = response.json().path("claim").path("claimToken").asString();
        assertThat(claim).hasSize(43);
        return claim;
    }

    // ---- time (claims, sales) ----------------------------------------------------------------

    /** Makes every open claim of the device run out (as time passing would). The guard trigger forbids shortening a claim on purpose. */
    void expireClaims(JsonNode device) {
        jdbc.execute("alter table payment_entry_claims disable trigger trg_entry_claims_guard");
        try {
            jdbc.update("update payment_entry_claims set created_at = now() - interval '10 minutes', expires_at = now() - interval '5 minutes' "
                    + "where device_id = ?::uuid and ended_at is null", device.path("id").asString());
        } finally {
            jdbc.execute("alter table payment_entry_claims enable trigger trg_entry_claims_guard");
        }
    }

    /** The sale's payment request runs out of time. */
    void expireSale(JsonNode sale) {
        jdbc.update("update payment_requests set expires_at = now() - interval '1 minute' where id = ?::uuid", saleId(sale));
    }
}
