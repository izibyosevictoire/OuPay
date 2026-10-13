package rw.oupay.payment;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import rw.oupay.support.IntegrationTest;
import rw.oupay.support.TestApi;
import rw.oupay.support.World;

/** Merchant-side payment links and invoice payment requests. */
class PaymentLinksIT extends IntegrationTest {

    World w;
    UUID destinationId;

    @BeforeEach
    void world() {
        w = World.create(this);
        destinationId = jdbc.queryForObject("select id from payment_destinations where merchant_id = ?", UUID.class, w.merchantId);
    }

    private String m(String path) {
        return "/api/v1/merchants/" + w.merchantId + path;
    }

    private Map<String, Object> profileBody(String label, UUID branch, UUID cashier) {
        Map<String, Object> body = new HashMap<>();
        body.put("label", label);
        body.put("paymentDestinationId", destinationId.toString());
        if (branch != null) body.put("branchId", branch.toString());
        if (cashier != null) body.put("assignedCashierId", cashier.toString());
        return body;
    }

    private UUID createProfile(String label, UUID branch, UUID cashier) {
        var response = w.owner.post(m("/payment-profiles"), profileBody(label, branch, cashier));
        assertThat(response.status()).as(response.body()).isEqualTo(201);
        return UUID.fromString(response.json().path("id").asString());
    }

    // ---- profiles ------------------------------------------------------------------------------

    @Test
    void tokensAreUnpredictableUniqueAndRevealNoInternalId() {
        Set<String> tokens = new HashSet<>();
        for (int i = 0; i < 25; i++) {
            var response = w.owner.post(m("/payment-profiles"), profileBody("Counter " + i, null, null));
            String token = response.json().path("paymentProfileId").asString();
            assertThat(token).matches("^[0-9A-Za-z]{12}$");
            assertThat(token).doesNotContain(response.json().path("id").asString().substring(0, 8));
            tokens.add(token);
        }
        assertThat(tokens).hasSize(25);
    }

    @Test
    void creationValidatesDestinationBranchAndCashierAtTheServiceBoundary() {
        assertThat(w.owner.post(m("/payment-profiles"), profileBody("x", null, null)).status()).isEqualTo(422);
        // Another business's destination (the cafe links one).
        rw.oupay.support.Bank.link(mvc, w.cafeOwner, w.cafeMerchantId);
        UUID cafeDestination = jdbc.queryForObject("select id from payment_destinations where merchant_id = ?", UUID.class, w.cafeMerchantId);
        Map<String, Object> foreign = new HashMap<>(profileBody("Foreign", null, null));
        foreign.put("paymentDestinationId", cafeDestination.toString());
        assertThat(w.owner.post(m("/payment-profiles"), foreign).status()).isEqualTo(422);
        assertThat(w.owner.post(m("/payment-profiles"), profileBody("Inactive branch", w.inactiveBranchId, null)).status()).isEqualTo(422);
        assertThat(w.owner.post(m("/payment-profiles"), profileBody("Foreign branch", w.cafeBranchId, null)).status()).isEqualTo(422);
        // The manager is not a cashier.
        assertThat(w.owner.post(m("/payment-profiles"), profileBody("Bad cashier", null, w.managerPerson.userId())).status()).isEqualTo(422);
        assertThat(w.owner.post(m("/payment-profiles"), profileBody("Good", w.branchId, w.cashierPerson.userId())).status()).isEqualTo(201);
        // A disconnected destination cannot back a new link.
        String connection = jdbc.queryForObject("select id from bank_connections where merchant_id = ?", String.class, w.merchantId);
        w.owner.post(m("/bank-connections/" + connection + "/disable"), null);
        assertThat(w.owner.post(m("/payment-profiles"), profileBody("After disable", null, null)).status()).isEqualTo(422);
    }

    @Test
    void managersManageLinksAndCashiersSeeOnlyTheirOwn() {
        UUID shared = createProfile("Shop counter", null, null);
        UUID alines = createProfile("Aline's till", w.branchId, w.cashierPerson.userId());
        assertThat(w.manager.get(m("/payment-profiles")).json().size()).isEqualTo(2);
        var cashierList = w.cashier.get(m("/payment-profiles")).json();
        assertThat(cashierList.size()).isEqualTo(1);
        assertThat(cashierList.get(0).path("id").asString()).isEqualTo(alines.toString());
        assertThat(w.cashier.get(m("/payment-profiles/" + shared)).status()).isEqualTo(404);
        assertThat(w.cashier.post(m("/payment-profiles"), profileBody("Mine", null, null)).status()).isEqualTo(403);
        assertThat(w.cashier.put(m("/payment-profiles/" + alines + "/active"), Map.of("isActive", false)).status()).isEqualTo(403);
        assertThat(w.cashier.post(m("/payment-profiles/" + alines + "/reissue"), null).status()).isEqualTo(403);
        assertThat(w.cashier.get(m("/payment-profiles/form-options")).status()).isEqualTo(403);
        assertThat(w.otherCashier.get(m("/payment-profiles")).json().size()).isZero();
    }

    @Test
    void anotherBusinessCannotSeeOrChangeTheseLinks() {
        UUID profile = createProfile("Shop counter", null, null);
        assertThat(w.cafeOwner.get(m("/payment-profiles")).status()).isEqualTo(404);
        String cafe = "/api/v1/merchants/" + w.cafeMerchantId;
        assertThat(w.cafeOwner.get(cafe + "/payment-profiles/" + profile).status()).isEqualTo(404);
        assertThat(w.cafeOwner.put(cafe + "/payment-profiles/" + profile + "/active", Map.of("isActive", false)).status()).isEqualTo(404);
        assertThat(w.cafeOwner.post(cafe + "/payment-profiles/" + profile + "/reissue", null).status()).isEqualTo(404);
        assertThat(jdbc.queryForObject("select status from payment_profiles where id = ?", String.class, profile)).isEqualTo("ACTIVE");
    }

    @Test
    void switchingOffAndReissuingWorkAndRevokedLinksStayRevoked() {
        UUID profile = createProfile("Shop counter", null, null);
        String token = jdbc.queryForObject("select public_token from payment_profiles where id = ?", String.class, profile);
        assertThat(w.manager.put(m("/payment-profiles/" + profile + "/active"), Map.of("isActive", false)).json().path("status").asString()).isEqualTo("INACTIVE");
        assertThat(w.manager.put(m("/payment-profiles/" + profile + "/active"), Map.of("isActive", true)).json().path("status").asString()).isEqualTo("ACTIVE");

        var replacement = w.owner.post(m("/payment-profiles/" + profile + "/reissue"), null);
        assertThat(replacement.status()).isEqualTo(200);
        assertThat(replacement.json().path("paymentProfileId").asString()).isNotEqualTo(token);
        assertThat(jdbc.queryForObject("select status from payment_profiles where id = ?", String.class, profile)).isEqualTo("REVOKED");
        assertThat(jdbc.queryForObject("select replaced_by_profile_id from payment_profiles where id = ?", UUID.class, profile))
                .isEqualTo(UUID.fromString(replacement.json().path("id").asString()));
        var revive = w.owner.put(m("/payment-profiles/" + profile + "/active"), Map.of("isActive", true));
        assertThat(revive.status()).isEqualTo(409);
        assertThat(revive.code()).isEqualTo("invalid_state");
        assertThat(w.owner.post(m("/payment-profiles/" + profile + "/reissue"), null).status()).isEqualTo(409);
    }

    // ---- invoice payment requests --------------------------------------------------------------

    @Test
    void anInvoiceRequestAsksForExactlyTheOutstandingBalanceAndIsReused() {
        createProfile("Shop counter", null, null);
        UUID invoice = w.issuedInvoice(50_000);
        w.bank.pay("POSTED", 20_000, jdbc.queryForObject("select invoice_number from invoices where id = ?", String.class, invoice));
        var first = w.owner.post(m("/invoices/" + invoice + "/payment-requests"), null);
        assertThat(first.status()).isEqualTo(200);
        assertThat(first.json().path("requestedAmount").asLong()).isEqualTo(30_000);
        assertThat(first.json().path("publicReference").asString()).matches("^OP-[2-9A-HJKMNP-Z]{12}$");
        assertThat(first.json().path("profileToken").asString()).hasSize(12);
        var again = w.owner.post(m("/invoices/" + invoice + "/payment-requests"), null);
        assertThat(again.json().path("id").asString()).isEqualTo(first.json().path("id").asString());
        assertThat(w.owner.get(m("/invoices/" + invoice + "/payment-requests")).json().size()).isEqualTo(1);
    }

    @Test
    void theBestMatchingLinkIsChosen() {
        createProfile("Shop-wide", null, null);
        UUID branchLink = createProfile("Remera till", w.branchId, null);
        UUID alines = createProfile("Aline's till", w.branchId, w.cashierPerson.userId());
        UUID invoice = w.issuedInvoice(10_000);   // branch RM01, assigned to Aline
        var request = w.owner.post(m("/invoices/" + invoice + "/payment-requests"), null).json();
        assertThat(UUID.fromString(request.path("paymentProfileId").asString())).isEqualTo(alines);
        assertThat(branchLink).isNotNull();
    }

    @Test
    void requestsAreBlockedForDraftCancelledVoidedAndPaidInvoicesAndWithoutAnActiveLink() {
        UUID profile = createProfile("Shop counter", null, null);
        // Draft.
        var draft = w.owner.post(m("/invoices"), w.draft(w.cashierPerson.userId(), 5_000)).json();
        var blockedDraft = w.owner.post(m("/invoices/" + draft.path("id").asString() + "/payment-requests"), null);
        assertThat(blockedDraft.status()).isEqualTo(409);
        assertThat(blockedDraft.code()).isEqualTo("invoice_not_payable");
        // Cancelled.
        var cancelled = w.owner.post(m("/invoices"), w.draft(w.cashierPerson.userId(), 5_000)).json();
        w.owner.post(m("/invoices/" + cancelled.path("id").asString() + "/cancel?expectedVersion=" + cancelled.path("version").asLong()), null);
        assertThat(w.owner.post(m("/invoices/" + cancelled.path("id").asString() + "/payment-requests"), null).code()).isEqualTo("invoice_not_payable");
        // Voided.
        UUID voided = w.issuedInvoice(5_000);
        long version = w.owner.get(m("/invoices/" + voided)).json().path("version").asLong();
        w.owner.post(m("/invoices/" + voided + "/void?expectedVersion=" + version), Map.of("reason", "Wrong customer"));
        assertThat(w.owner.post(m("/invoices/" + voided + "/payment-requests"), null).code()).isEqualTo("invoice_not_payable");
        // Paid.
        UUID paid = w.issuedInvoice(5_000);
        w.bank.pay("POSTED", 5_000, jdbc.queryForObject("select invoice_number from invoices where id = ?", String.class, paid));
        assertThat(w.owner.post(m("/invoices/" + paid + "/payment-requests"), null).code()).isEqualTo("invoice_not_payable");
        // No active link.
        UUID open = w.issuedInvoice(5_000);
        w.owner.put(m("/payment-profiles/" + profile + "/active"), Map.of("isActive", false));
        var noLink = w.owner.post(m("/invoices/" + open + "/payment-requests"), null);
        assertThat(noLink.status()).isEqualTo(409);
        assertThat(noLink.code()).isEqualTo("no_active_profile");
    }

    @Test
    void cashiersRequestPaymentOnlyForTheirOwnInvoices() {
        createProfile("Shop counter", null, null);
        UUID mine = w.issuedInvoice(5_000);
        var other = w.owner.post(m("/invoices"), w.draft(w.otherCashierPerson.userId(), 5_000)).json();
        UUID theirs = UUID.fromString(other.path("id").asString());
        w.owner.post(m("/invoices/" + theirs + "/issue?expectedVersion=" + other.path("version").asLong()), null);
        assertThat(w.cashier.post(m("/invoices/" + mine + "/payment-requests"), null).status()).isEqualTo(200);
        assertThat(w.cashier.post(m("/invoices/" + theirs + "/payment-requests"), null).status()).isEqualTo(404);
        assertThat(w.cashier.get(m("/invoices/" + theirs + "/payment-requests")).status()).isEqualTo(404);
        assertThat(w.cafeOwner.post(m("/invoices/" + mine + "/payment-requests"), null).status()).isEqualTo(404);
    }

    @Test
    void managersCancelUnpaidRequestsButNotOnesWithConfirmedMoney() {
        createProfile("Shop counter", null, null);
        UUID invoice = w.issuedInvoice(10_000);
        var first = w.owner.post(m("/invoices/" + invoice + "/payment-requests"), null).json();
        assertThat(w.cashier.post(m("/payment-requests/" + first.path("id").asString() + "/cancel"), null).status()).isEqualTo(403);
        assertThat(w.manager.post(m("/payment-requests/" + first.path("id").asString() + "/cancel"), null).json().path("status").asString()).isEqualTo("CANCELLED");

        var second = w.owner.post(m("/invoices/" + invoice + "/payment-requests"), null).json();
        w.bank.pay("POSTED", 4_000, second.path("publicReference").asString());
        var refused = w.manager.post(m("/payment-requests/" + second.path("id").asString() + "/cancel"), null);
        assertThat(refused.status()).isEqualTo(409);
        assertThat(refused.code()).isEqualTo("invalid_state");
    }

    @SuppressWarnings("unused")
    private TestApi unused() {
        return w.owner;
    }
}
