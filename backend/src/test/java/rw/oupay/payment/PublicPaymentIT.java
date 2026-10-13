package rw.oupay.payment;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Pattern;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpMethod;
import rw.oupay.support.IntegrationTest;
import rw.oupay.support.TestApi;
import rw.oupay.support.World;

/** The anonymous customer API: minimal exposure, no false confirmations, no merchant-wide data. */
class PublicPaymentIT extends IntegrationTest {

    World w;
    String shopToken;
    String alineToken;
    String base;

    @BeforeEach
    void world() {
        w = World.create(this);
        UUID destination = jdbc.queryForObject("select id from payment_destinations where merchant_id = ?", UUID.class, w.merchantId);
        shopToken = token(Map.of("label", "Shop counter", "paymentDestinationId", destination.toString()));
        alineToken = token(Map.of("label", "Aline", "paymentDestinationId", destination.toString(), "branchId", w.branchId.toString(),
                "assignedCashierId", w.cashierPerson.userId().toString()));
        base = "/api/v1/public/payment-profiles/";
    }

    private String token(Map<String, Object> body) {
        return w.owner.post("/api/v1/merchants/" + w.merchantId + "/payment-profiles", body).json().path("paymentProfileId").asString();
    }

    private TestApi.Response get(String path) {
        return TestApi.anonymous(mvc, HttpMethod.GET, base + path, null, Map.of());
    }

    private TestApi.Response post(String path, Object body) {
        return TestApi.anonymous(mvc, HttpMethod.POST, base + path, body, Map.of());
    }

    private String open(String token, long amount) {
        var created = post(token + "/requests", Map.of("amount", amount));
        assertThat(created.status()).as(created.body()).isEqualTo(201);
        return created.json().path("publicReference").asString();
    }

    private String stage(String token, String reference) {
        return get(token + "/requests/" + reference).json().path("stage").asString();
    }

    // ---- minimal exposure ----------------------------------------------------------------------

    @Test
    void anAnonymousCustomerSeesOnlyPublicInformation() {
        var response = get(alineToken);
        assertThat(response.status()).isEqualTo(200);
        var json = response.json();
        assertThat(json.path("merchantDisplayName").asString()).isEqualTo("Sample Shop Ltd");
        assertThat(json.path("branchName").asString()).isEqualTo("Branch RM01");
        assertThat(json.path("cashierDisplayName").asString()).isEqualTo("Aline C.");
        assertThat(json.path("isMerchantVerified").asBoolean()).isFalse();   // still pending verification
        assertThat(json.path("status").asString()).isEqualTo("ACTIVE");
        // Not a single private identifier or contact detail anywhere in the body.
        String body = response.body();
        for (String secret : new String[] {w.merchantId.toString(), w.bank.accountId, "bacc-", "••••", "@shop.rw", "@cafe.rw", "+250", "Cashier",
                w.cashierPerson.userId().toString(), w.branchId.toString(), "123456789", "RC-1001", "KG 11", "Argon"}) {
            assertThat(body).as("leaked: " + secret).doesNotContain(secret);
        }
        assertThat(response.raw().getHeader("Cache-Control")).isEqualTo("no-store");
    }

    @Test
    void methodsAreUsableOnlyWhenTheProviderAndConfigurationSupportThem() {
        var methods = get(shopToken).json().path("paymentMethods");
        var equity = methods.get(0);
        assertThat(equity.path("id").asString()).isEqualTo("EQUITY_MERCHANT");
        assertThat(equity.path("isUsable").asBoolean()).isTrue();
        assertThat(equity.path("isSimulated").asBoolean()).isTrue();
        String instructions = equity.path("instructions").toString();
        // Never an invented USSD code, deep link, endpoint or credential request.
        assertThat(Pattern.compile("\\*\\d+[*#]|#\\d+|https?:|tel:|momo:", Pattern.CASE_INSENSITIVE).matcher(instructions).find()).isFalse();
        assertThat(instructions.toLowerCase()).contains("never share a pin");
        for (int i = 1; i <= 2; i++) {
            assertThat(methods.get(i).path("isUsable").asBoolean()).isFalse();
            assertThat(methods.get(i).path("instructions").size()).isZero();
        }
    }

    @Test
    void verifiedIsShownOnlyWhenTheBusinessIsActuallyVerified() {
        jdbc.update("update merchants set status = 'active' where id = ?", w.merchantId);
        assertThat(get(shopToken).json().path("isMerchantVerified").asBoolean()).isTrue();
        jdbc.update("update merchants set status = 'suspended' where id = ?", w.merchantId);
        assertThat(get(shopToken).json().path("status").asString()).isEqualTo("UNAVAILABLE");
    }

    @Test
    void deadMalformedAndUnknownLinksRevealNothing() {
        var unknown = get("AAAAAAAAAAAA");
        var malformed = get("short");
        var injection = get("%27%20OR%201%3D1--");
        assertThat(unknown.status()).isEqualTo(404);
        assertThat(malformed.status()).isEqualTo(404);
        assertThat(injection.status()).isIn(400, 404);
        assertThat(malformed.body()).isEqualTo(unknown.body());

        UUID profile = jdbc.queryForObject("select id from payment_profiles where public_token = ?", UUID.class, shopToken);
        w.owner.put("/api/v1/merchants/" + w.merchantId + "/payment-profiles/" + profile + "/active", Map.of("isActive", false));
        var off = get(shopToken);
        assertThat(off.status()).isEqualTo(200);
        assertThat(off.json().path("status").asString()).isEqualTo("UNAVAILABLE");
        assertThat(off.body()).doesNotContain("Sample Shop");
        assertThat(post(shopToken + "/requests", Map.of("amount", 5_000)).code()).isEqualTo("profile_unavailable");

        w.owner.put("/api/v1/merchants/" + w.merchantId + "/payment-profiles/" + profile + "/active", Map.of("isActive", true));
        w.owner.post("/api/v1/merchants/" + w.merchantId + "/payment-profiles/" + profile + "/reissue", null);
        assertThat(get(shopToken).json().path("status").asString()).isEqualTo("UNAVAILABLE");
        // Disabling the bank connection also switches every link that depends on it off.
        String connection = jdbc.queryForObject("select id from bank_connections where merchant_id = ?", String.class, w.merchantId);
        w.owner.post("/api/v1/merchants/" + w.merchantId + "/bank-connections/" + connection + "/disable", null);
        assertThat(get(alineToken).json().path("status").asString()).isEqualTo("UNAVAILABLE");
    }

    @Test
    void thereIsNoPublicWayToListRequestsOrTransactions() {
        open(shopToken, 5_000);
        for (String path : new String[] {shopToken + "/requests", shopToken + "/transactions", "", shopToken + "/payments"}) {
            assertThat(get(path).status()).as(path).isIn(404, 405);
        }
        assertThat(TestApi.anonymous(mvc, HttpMethod.GET, "/api/v1/public/bank-transactions", null, Map.of()).status()).isEqualTo(404);
    }

    // ---- open requests -------------------------------------------------------------------------

    @Test
    void openRequestsValidateTheAmountAndUseUnpredictableReferences() {
        for (long bad : new long[] {0, 99, -500, 10_000_001}) {
            var response = post(shopToken + "/requests", Map.of("amount", bad));
            assertThat(response.status()).as("amount " + bad).isEqualTo(422);
        }
        assertThat(post(shopToken + "/requests", "{\"amount\": 12.5}").status()).isIn(400, 422);
        assertThat(post(shopToken + "/requests", "{\"amount\": \"lots\"}").status()).isEqualTo(400);
        assertThat(post(shopToken + "/requests", "not json").status()).isEqualTo(400);
        assertThat(post("AAAAAAAAAAAA/requests", Map.of("amount", 5_000)).status()).isEqualTo(404);

        java.util.Set<String> references = new java.util.HashSet<>();
        for (int i = 0; i < 20; i++) {
            references.add(open(shopToken, 5_000));
        }
        assertThat(references).hasSize(20).allMatch(r -> r.matches("^OP-[2-9A-HJKMNP-Z]{12}$"));
        var view = post(shopToken + "/requests", Map.of("amount", 12_000)).json();
        assertThat(view.path("requestedAmount").asLong()).isEqualTo(12_000);
        assertThat(view.path("amountDue").asLong()).isEqualTo(12_000);
        assertThat(view.path("currency").asString()).isEqualTo("RWF");
        assertThat(view.path("stage").asString()).isEqualTo("AWAITING_PAYMENT");
        assertThat(view.path("isAmountFixed").asBoolean()).isTrue();
        assertThat(view.path("confirmedAmount").asLong()).isZero();
    }

    @Test
    void aSingleLinkCannotBeUsedToFloodTheDatabase() {
        UUID profile = jdbc.queryForObject("select id from payment_profiles where public_token = ?", UUID.class, shopToken);
        String alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
        for (int i = 0; i < 200; i++) {
            StringBuilder reference = new StringBuilder("OP-");
            int n = i;
            for (int k = 0; k < 12; k++) {
                reference.append(alphabet.charAt(n % alphabet.length()));
                n /= alphabet.length();
            }
            jdbc.update("insert into payment_requests (id, merchant_id, payment_profile_id, requested_amount_rwf, public_reference, expires_at, created_at, updated_at) "
                    + "values (?, ?, ?, 100, ?, now() + interval '1 hour', now(), now())", UUID.randomUUID(), w.merchantId, profile, reference.toString());
        }
        var response = post(shopToken + "/requests", Map.of("amount", 5_000));
        assertThat(response.status()).isEqualTo(429);
        assertThat(response.code()).isEqualTo("rate_limited");
    }

    @Test
    void aRequestIsOnlyReachableThroughItsOwnLink() {
        String reference = open(shopToken, 5_000);
        assertThat(get(shopToken + "/requests/" + reference).status()).isEqualTo(200);
        assertThat(get(alineToken + "/requests/" + reference).status()).isEqualTo(404);
        assertThat(get(shopToken + "/requests/OP-AAAAAAAAAAAA").status()).isEqualTo(404);
        assertThat(get(shopToken + "/requests/not-a-reference").status()).isEqualTo(404);
        assertThat(post(alineToken + "/requests/" + reference + "/claim", null).status()).isEqualTo(404);
        // Another business's link never reveals this request either.
        rw.oupay.support.Bank.link(mvc, w.cafeOwner, w.cafeMerchantId);
        UUID cafeDestination = jdbc.queryForObject("select id from payment_destinations where merchant_id = ?", UUID.class, w.cafeMerchantId);
        String cafeToken = w.cafeOwner.post("/api/v1/merchants/" + w.cafeMerchantId + "/payment-profiles",
                Map.of("label", "Cafe", "paymentDestinationId", cafeDestination.toString())).json().path("paymentProfileId").asString();
        assertThat(get(cafeToken + "/requests/" + reference).status()).isEqualTo(404);
    }

    @Test
    void sayingYouPaidIsAClaimAndNeverAConfirmation() {
        String reference = open(shopToken, 5_000);
        assertThat(post(shopToken + "/requests/" + reference + "/instructions-opened", null).status()).isEqualTo(204);
        assertThat(post(shopToken + "/requests/" + reference + "/claim", null).status()).isEqualTo(204);
        var view = get(shopToken + "/requests/" + reference).json();
        assertThat(view.path("instructionsOpened").asBoolean()).isTrue();
        assertThat(view.path("customerClaimedPayment").asBoolean()).isTrue();
        assertThat(view.path("stage").asString()).isEqualTo("AWAITING_PAYMENT");
        assertThat(view.path("confirmedAmount").asLong()).isZero();
        assertThat(jdbc.queryForObject("select count(*) from bank_transactions", Integer.class)).isZero();
        assertThat(jdbc.queryForObject("select count(*) from payment_allocations", Integer.class)).isZero();
    }

    @Test
    void anExpiredRequestShowsExpiredAndRefusesClaims() {
        String reference = open(shopToken, 5_000);
        jdbc.update("update payment_requests set expires_at = now() - interval '1 minute' where public_reference = ?", reference);
        assertThat(stage(shopToken, reference)).isEqualTo("EXPIRED");
        var claim = post(shopToken + "/requests/" + reference + "/claim", null);
        assertThat(claim.status()).isEqualTo(409);
        assertThat(claim.code()).isEqualTo("request_unavailable");
    }

    @Test
    void thePublicCallerCannotForgeABankConfirmation() {
        String reference = open(shopToken, 5_000);
        for (String path : new String[] {shopToken + "/requests/" + reference + "/confirm", shopToken + "/requests/" + reference + "/paid",
                shopToken + "/requests/" + reference + "/status"}) {
            var response = post(path, Map.of("status", "CONFIRMED", "amount", 5_000));
            assertThat(response.status()).as(path).isIn(404, 405);
        }
        Map<String, Object> forged = new HashMap<>();
        forged.put("amount", 5_000);
        forged.put("status", "CONFIRMED");
        assertThat(post(shopToken + "/requests", forged).status()).isEqualTo(201);   // extra fields are ignored...
        assertThat(jdbc.queryForObject("select count(*) from bank_transactions", Integer.class)).isZero();   // ...and create nothing
        assertThat(stage(shopToken, reference)).isEqualTo("AWAITING_PAYMENT");
    }

    // ---- the customer journey follows the bank ------------------------------------------------

    @Test
    void theCustomerStageFollowsOnlyWhatTheBankReports() {
        String pendingRef = open(shopToken, 12_000);
        var pending = w.bank.pay("PENDING", 12_000, pendingRef);
        assertThat(stage(shopToken, pendingRef)).isEqualTo("BANK_CONFIRMATION_PENDING");
        w.bank.update(pending.transactionId(), "POSTED", 12_000, pendingRef);
        // Confirmed against an OPEN request: it is a merchant collection, not yet applied to an invoice.
        assertThat(stage(shopToken, pendingRef)).isEqualTo("CONFIRMED_UNMATCHED");
        assertThat(get(shopToken + "/requests/" + pendingRef).json().path("confirmedAmount").asLong()).isEqualTo(12_000);

        String failedRef = open(shopToken, 5_000);
        w.bank.pay("REJECTED", 5_000, failedRef);
        assertThat(stage(shopToken, failedRef)).isEqualTo("FAILED");

        String reversedRef = open(shopToken, 5_000);
        var confirmed = w.bank.pay("POSTED", 5_000, reversedRef);
        w.bank.update(confirmed.transactionId(), "REVERSED", 5_000, reversedRef);
        assertThat(stage(shopToken, reversedRef)).isEqualTo("REVERSED");

        String partialRef = open(shopToken, 10_000);
        w.bank.pay("POSTED", 4_000, partialRef);
        var partial = get(shopToken + "/requests/" + partialRef).json();
        assertThat(partial.path("stage").asString()).isEqualTo("PARTIALLY_SETTLED");
        assertThat(partial.path("amountDue").asLong()).isEqualTo(6_000);
        assertThat(partial.path("confirmedAmount").asLong()).isEqualTo(4_000);
    }

    @Test
    void anInvoicePaymentRequestSettlesTheInvoiceAndTheCustomerPage() {
        UUID invoice = w.issuedInvoice(50_000);
        var request = w.owner.post("/api/v1/merchants/" + w.merchantId + "/invoices/" + invoice + "/payment-requests", null).json();
        String token = request.path("profileToken").asString();
        String reference = request.path("publicReference").asString();
        var view = get(token + "/requests/" + reference).json();
        assertThat(view.path("invoiceReference").asString()).startsWith("INV-");
        assertThat(view.path("amountDue").asLong()).isEqualTo(50_000);

        w.bank.pay("POSTED", 20_000, reference);
        var partial = get(token + "/requests/" + reference).json();
        assertThat(partial.path("stage").asString()).isEqualTo("PARTIALLY_SETTLED");
        assertThat(partial.path("amountDue").asLong()).isEqualTo(30_000);

        w.bank.pay("POSTED", 30_000, reference);
        assertThat(stage(token, reference)).isEqualTo("CONFIRMED_AND_RECONCILED");
        assertThat(w.owner.get("/api/v1/merchants/" + w.merchantId + "/invoices/" + invoice).json().path("paymentStatus").asString()).isEqualTo("PAID");
    }

    @Test
    void aVoidedInvoiceRequestShowsCancelledToTheCustomer() {
        UUID invoice = w.issuedInvoice(5_000);
        var request = w.owner.post("/api/v1/merchants/" + w.merchantId + "/invoices/" + invoice + "/payment-requests", null).json();
        long version = w.owner.get("/api/v1/merchants/" + w.merchantId + "/invoices/" + invoice).json().path("version").asLong();
        w.owner.post("/api/v1/merchants/" + w.merchantId + "/invoices/" + invoice + "/void?expectedVersion=" + version, Map.of("reason", "Wrong customer"));
        assertThat(stage(request.path("profileToken").asString(), request.path("publicReference").asString())).isEqualTo("CANCELLED");
    }
}
