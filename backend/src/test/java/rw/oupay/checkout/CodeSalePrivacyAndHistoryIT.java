package rw.oupay.checkout;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpMethod;
import org.springframework.test.context.TestPropertySource;
import rw.oupay.support.TestApi;
import tools.jackson.databind.JsonNode;

/**
 * R6c: what the anonymous customer page may reveal, and how a sale keeps its own history. The customer page is public BY DESIGN for whoever
 * holds the sale reference, so it must be hard to guess and must carry nothing private. A sale's identity never depends on the CURRENT
 * assignment, code or membership.
 */
@TestPropertySource(properties = {
        "oupay.collection-codes.approval-enabled=true",
        "oupay.code-checkout.live-enabled=true",
        "oupay.code-checkout.instructions=Open the bank app|Pay to the merchant code shown"})
class CodeSalePrivacyAndHistoryIT extends CodeCheckoutTestSupport {

    private static final Pattern UUID_TEXT = Pattern.compile("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}");

    private JsonNode demoSale() {
        ensureProfile();
        JsonNode code = activeCode("Counter", "EQ-DEMO-1");
        assertThat(assign(code, cashierMembership).status()).isEqualTo(201);
        var created = bill(w.cashier, "key-" + UUID.randomUUID(), body(12_000, "Lunch", null, UUID.randomUUID()));
        assertThat(created.status()).as(created.body()).isEqualTo(201);
        return created.json();
    }

    private JsonNode liveSale() {
        makeAccountReal();
        ensureProfile();
        JsonNode code = activeCode("Live", "EQ-LIVE-77");
        assertThat(assign(code, cashierMembership).status()).isEqualTo(201);
        var created = bill(w.cashier, "key-" + UUID.randomUUID(), body(12_000, "Lunch", null, UUID.randomUUID()));
        assertThat(created.status()).as(created.body()).isEqualTo(201);
        return created.json();
    }

    private List<String> keys(JsonNode node) {
        List<String> names = new ArrayList<>();
        node.propertyNames().forEach(names::add);
        return names;
    }

    // ---- the anonymous customer page ------------------------------------------------------------

    @Test
    void theCustomerPageCarriesOnlyWhatACustomerNeedsForADemonstration() {
        JsonNode sale = demoSale();
        var page = publicSale(sale.path("saleReference").asString());
        assertThat(page.status()).isEqualTo(200);
        assertThat(page.raw().getHeader("Cache-Control")).contains("no-store");
        JsonNode json = page.json();
        assertThat(Set.copyOf(keys(json))).isSubsetOf(Set.of("merchantDisplayName", "saleReference", "amountRwf", "currency", "description", "status",
                "confirmedAmount", "amountDue", "expiresAt", "code", "instructions", "statusNote"));
        assertThat(Set.copyOf(keys(json.path("code")))).isSubsetOf(Set.of("mode", "label", "bankCode", "demoReference", "notice"));
        assertThat(json.path("code").path("mode").asString()).isEqualTo("DEMONSTRATION");
        assertThat(json.path("code").path("notice").asString()).contains("DEMONSTRATION ONLY");
        // No bank code, no OuPay internal code reference, no instructions for something that cannot be paid.
        assertThat(json.path("code").path("bankCode").isMissingNode() || json.path("code").path("bankCode").isNull()).isTrue();
        assertThat(json.path("code").path("demoReference").isMissingNode() || json.path("code").path("demoReference").isNull()).isTrue();
        assertThat(json.path("instructions").size()).isZero();
        String internalRef = jdbc.queryForObject("select code_internal_ref from code_sales", String.class);
        assertThat(page.body()).doesNotContain(internalRef);
        assertNoPrivateData(page.body());
    }

    @Test
    void theCustomerPageOfALiveSaleShowsTheBankCodeAndConfirmedInstructionsOnly() {
        JsonNode sale = liveSale();
        var page = publicSale(sale.path("saleReference").asString());
        JsonNode json = page.json();
        assertThat(json.path("code").path("mode").asString()).isEqualTo("LIVE");
        assertThat(json.path("code").path("bankCode").asString()).isEqualTo("EQ-LIVE-77");
        assertThat(json.path("instructions").size()).isEqualTo(2);
        assertThat(Set.copyOf(keys(json))).isSubsetOf(Set.of("merchantDisplayName", "saleReference", "amountRwf", "currency", "description", "status",
                "confirmedAmount", "amountDue", "expiresAt", "code", "instructions", "statusNote"));
        assertNoPrivateData(page.body());
    }

    private void assertNoPrivateData(String body) {
        // No agent, no account, no approval evidence, no staff, no internal identifier of any kind.
        assertThat(body).doesNotContain("Aline").doesNotContain("Cashier").doesNotContain("SIM-").doesNotContain("Equity letter")
                .doesNotContain("EQ-EQ-").doesNotContain("agent").doesNotContain("settlement").doesNotContain("masked");
        assertThat(UUID_TEXT.matcher(body).find()).as("the customer page must not carry any UUID").isFalse();
    }

    @Test
    void referencesAreLongRandomAndDrawnFromAnUnambiguousAlphabet() {
        demoSale();
        String reference = jdbc.queryForObject("select sale_reference from code_sales", String.class);
        // OP- plus 12 characters of a 30-symbol alphabet: about 59 bits, with no look-alike characters.
        assertThat(reference).matches("^OP-[2-9A-HJKMNP-Z]{12}$");
    }

    @Test
    void unknownMalformedAndForeignReferencesAllLookTheSameAndLeakNothing() {
        JsonNode sale = demoSale();
        String real = sale.path("saleReference").asString();
        UUID ordinaryInvoice = w.issuedInvoice(5_000);
        var ordinaryRequest = w.owner.post("/api/v1/merchants/" + w.merchantId + "/invoices/" + ordinaryInvoice + "/payment-requests", Map.of());
        List<String> probes = new ArrayList<>(List.of("OP-ZZZZZZZZZZZZ", "OP-AAAAAAAAAAAA", "op-" + real.substring(3).toLowerCase(), real.toLowerCase(),
                real + "X", real.substring(0, real.length() - 1), "OP-", "OP-0O1I1LU00000", "undefined"));
        if (ordinaryRequest.status() == 201 || ordinaryRequest.status() == 200) {
            String ordinaryReference = ordinaryRequest.json().path("publicReference").asString();
            if (!ordinaryReference.isBlank()) {
                probes.add(ordinaryReference);
            }
        }
        String first = null;
        for (String probe : probes) {
            var response = publicSale(probe);
            assertThat(response.status()).as(probe).isEqualTo(404);
            first = first == null ? response.body() : first;
            assertThat(response.body()).as(probe).isEqualTo(first);
            assertThat(response.body()).doesNotContain(real).doesNotContain("Sample Shop");
        }
    }

    @Test
    void theOnlyKeyIsTheReferenceSoQueryParametersCannotSteerToAnotherMerchant() {
        JsonNode sale = demoSale();
        String real = sale.path("saleReference").asString();
        var plain = publicSale(real);
        var steered = TestApi.anonymous(mvc, HttpMethod.GET, "/api/v1/public/code-sales/" + real + "?merchantId=" + w.cafeMerchantId + "&saleId="
                + UUID.randomUUID(), null, Map.of());
        assertThat(steered.status()).isEqualTo(200);
        assertThat(steered.json().path("merchantDisplayName").asString()).isEqualTo(plain.json().path("merchantDisplayName").asString());
        assertThat(steered.json().path("saleReference").asString()).isEqualTo(real);
        // Only GET exists: nothing on this path writes.
        assertThat(TestApi.anonymous(mvc, HttpMethod.POST, "/api/v1/public/code-sales/" + real, Map.of("status", "PAID"), Map.of()).status())
                .isGreaterThanOrEqualTo(400);
        assertThat(TestApi.anonymous(mvc, HttpMethod.DELETE, "/api/v1/public/code-sales/" + real, null, Map.of()).status()).isGreaterThanOrEqualTo(400);
        assertThat(count("code_sales")).isEqualTo(1);
    }

    @Test
    void ordinaryPaymentPagesAndTheCodeSalePageNeverServeEachOthersRequests() {
        JsonNode sale = demoSale();
        String reference = sale.path("saleReference").asString();
        String token = jdbc.queryForObject("select pp.public_token from payment_profiles pp join payment_requests pr on pr.payment_profile_id = pp.id "
                + "where pr.public_reference = ?", String.class, reference);
        assertThat(TestApi.anonymous(mvc, HttpMethod.GET, "/api/v1/public/payment-profiles/" + token + "/requests/" + reference, null, Map.of()).status())
                .isEqualTo(404);
        // The ordinary profile page still works for a real link.
        assertThat(TestApi.anonymous(mvc, HttpMethod.GET, "/api/v1/public/payment-profiles/" + token, null, Map.of()).status()).isEqualTo(200);
    }

    // ---- historical identity and authorization --------------------------------------------------

    @Test
    void theSnapshotSurvivesReassignmentSuspensionAndAgentChangesUnchanged() {
        ensureProfile();
        JsonNode code = activeCode("Counter", "EQ-DEMO-1");
        assertThat(assign(code, cashierMembership).status()).isEqualTo(201);
        var created = bill(w.cashier, "key-hist-0001", body(12_000, "Lunch", null, UUID.randomUUID()));
        UUID saleId = UUID.fromString(created.json().path("saleId").asString());
        Map<String, Object> before = jdbc.queryForMap("select * from code_sales where payment_request_id = ?", saleId);
        assertThat(before.get("assignee_name")).isEqualTo("Aline Cashier");
        assertThat(before.get("settlement_destination_id")).isEqualTo(destination);

        String open = jdbc.queryForObject("select id::text from collection_code_assignments where code_id = ?::uuid and valid_to is null", String.class, id(code));
        assertThat(reassign(code, open, otherCashierMembership, "Shift change").status()).isEqualTo(200);
        jdbc.update("update collection_codes set status = 'SUSPENDED', status_reason = 'Paused' where id = ?::uuid", id(code));
        jdbc.update("update branches set status = 'INACTIVE' where id = ?", w.branchId);
        jdbc.update("update users set full_name = 'Renamed Person' where id = ?", w.cashierPerson.userId());

        assertThat(jdbc.queryForMap("select * from code_sales where payment_request_id = ?", saleId)).isEqualTo(before);
        var owner = w.owner.get(sale() + "/" + saleId);
        assertThat(owner.status()).as(owner.body()).isEqualTo(200);
        assertThat(owner.json().path("agentName").asString()).isEqualTo("Aline Cashier");
        assertThat(owner.json().path("branchName").asString()).isEqualTo(before.get("branch_name"));
        assertThat(owner.json().path("code").path("label").asString()).isEqualTo("Counter");
    }

    @Test
    void anAgentWhoseMembershipIsSuspendedCannotReadTheirOwnSaleButTheOwnerCan() {
        JsonNode sale = demoSale();
        UUID saleId = UUID.fromString(sale.path("saleId").asString());
        assertThat(w.cashier.get(sale() + "/" + saleId).status()).isEqualTo(200);
        jdbc.update("update memberships set status = 'SUSPENDED' where id = ?", cashierMembership);
        var suspended = w.cashier.get(sale() + "/" + saleId);
        assertThat(suspended.status()).isIn(401, 403, 404);
        assertThat(suspended.body()).doesNotContain("saleReference");
        assertThat(w.cashier.get(sale() + "/options").status()).isIn(401, 403, 404);
        assertThat(w.owner.get(sale() + "/" + saleId).status()).isEqualTo(200);
    }

    @Test
    void anotherAgentCannotReplayOrReadASaleWithTheOriginalClientRequestId() {
        ensureProfile();
        JsonNode code = activeCode("Counter", "EQ-DEMO-1");
        assertThat(assign(code, cashierMembership).status()).isEqualTo(201);
        UUID clientRequestId = UUID.randomUUID();
        var original = bill(w.cashier, "key-orig-0001", body(12_000, "Lunch", null, clientRequestId));
        assertThat(original.status()).isEqualTo(201);

        String open = jdbc.queryForObject("select id::text from collection_code_assignments where code_id = ?::uuid and valid_to is null", String.class, id(code));
        assertThat(reassign(code, open, otherCashierMembership, "Shift change").status()).isEqualTo(200);
        // Same content, same key, same identifier: the new holder gets a refusal, never the first agent's sale.
        var replay = bill(w.otherCashier, "key-orig-0001", body(12_000, "Lunch", null, clientRequestId));
        assertThat(replay.status()).isIn(403, 404, 409, 422);
        assertThat(replay.body()).doesNotContain(original.json().path("saleReference").asString());
        var reused = bill(w.otherCashier, "key-orig-0002", body(12_000, "Lunch", null, clientRequestId));
        assertThat(reused.status()).isEqualTo(409);
        assertThat(reused.body()).doesNotContain(original.json().path("saleReference").asString());
        assertThat(w.otherCashier.get(sale() + "/" + original.json().path("saleId").asString()).status()).isIn(403, 404);
        assertThat(count("code_sales")).isEqualTo(1);
    }

    @Test
    void anotherBusinessCannotReachTheSaleByAnyPath() {
        JsonNode sale = demoSale();
        UUID saleId = UUID.fromString(sale.path("saleId").asString());
        assertThat(w.cafeOwner.get("/api/v1/merchants/" + w.cafeMerchantId + "/checkout/code-sale/" + saleId).status()).isEqualTo(404);
        assertThat(w.cafeOwner.get(sale() + "/" + saleId).status()).isIn(403, 404);
        var replay = w.cafeOwner.send(HttpMethod.POST, "/api/v1/merchants/" + w.cafeMerchantId + "/checkout/code-sale",
                body(12_000, "Lunch", null, UUID.fromString(jdbc.queryForObject("select client_request_id::text from invoices where id = ?::uuid", String.class,
                        sale.path("invoiceId").asString()))), Map.of("Idempotency-Key", "key-cafe-0001"));
        assertThat(replay.status()).isIn(403, 404, 409, 422);
        assertThat(replay.body()).doesNotContain(sale.path("saleReference").asString());
    }
}
