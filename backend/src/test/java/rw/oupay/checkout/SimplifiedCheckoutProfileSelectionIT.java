package rw.oupay.checkout;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/** Which branch and which payment link a checkout sale uses, who may use them, and that nothing is ever created silently. */
class SimplifiedCheckoutProfileSelectionIT extends CheckoutTestSupport {

    private UUID destination() {
        return jdbc.queryForObject("select id from payment_destinations where merchant_id = ?", UUID.class, w.merchantId);
    }

    private UUID profile(String label, UUID branchId, UUID cashierId) {
        Map<String, Object> body = new java.util.HashMap<>();
        body.put("label", label);
        body.put("paymentDestinationId", destination().toString());
        if (branchId != null) {
            body.put("branchId", branchId.toString());
        }
        if (cashierId != null) {
            body.put("assignedCashierId", cashierId.toString());
        }
        var created = w.owner.post("/api/v1/merchants/" + w.merchantId + "/payment-profiles", body);
        assertThat(created.status()).as(created.body()).isEqualTo(201);
        return UUID.fromString(created.json().path("id").asString());
    }

    private UUID profileOfRequest(String publicReference) {
        return jdbc.queryForObject("select payment_profile_id from payment_requests where public_reference = ?", UUID.class, publicReference);
    }

    @Test
    void theLinkUsedIsTheBestEligibleOneOfThisBusinessAndTraditionalInvoicesPickTheSameWay() {
        UUID businessWide = profile("Counter", null, null);
        UUID branchLink = profile("Remera", w.branchId, null);
        UUID cashierLink = profile("Aline", w.branchId, w.cashierPerson.userId());
        UUID otherBranch = fixtures.branch(w.merchantId, "RM09", "ACTIVE");
        fixtures.assign(w.merchantId, w.cashierMembershipId, otherBranch);

        // Cashier + branch beats branch beats business-wide.
        var sale = bill(w.cashier, "key-sel-0000001", withBranch(sale(1_000, null, UUID.randomUUID()), w.branchId));
        assertThat(sale.status()).as(sale.body()).isEqualTo(201);
        assertThat(profileOfRequest(sale.json().path("publicReference").asString())).isEqualTo(cashierLink);
        // The manager has no link of their own: the branch link.
        var manager = bill(w.manager, 1_000);
        assertThat(profileOfRequest(manager.json().path("publicReference").asString())).isEqualTo(branchLink);
        // A branch with no link of its own falls back to the business-wide one.
        var wide = bill(w.cashier, "key-sel-0000002", withBranch(sale(1_000, null, UUID.randomUUID()), otherBranch));
        assertThat(profileOfRequest(wide.json().path("publicReference").asString())).isEqualTo(businessWide);

        // Traditional invoices follow exactly the same order, and keep their seven days.
        UUID invoice = w.issuedInvoice(3_000); // assigned to the cashier at the main branch
        var request = w.owner.post("/api/v1/merchants/" + w.merchantId + "/invoices/" + invoice + "/payment-requests", null);
        assertThat(request.status()).isEqualTo(200);
        assertThat(profileOfRequest(request.json().path("publicReference").asString())).isEqualTo(cashierLink);
        assertThat(Duration.between(Instant.parse(request.json().path("createdAt").asString()), Instant.parse(request.json().path("expiresAt").asString())))
                .isEqualTo(Duration.ofDays(7));
        // Every request belongs to this business, and its provenance is recorded.
        assertThat(jdbc.queryForObject("select count(*) from payment_requests where merchant_id <> ?", Integer.class, w.merchantId)).isZero();
    }

    private Map<String, Object> withBranch(Map<String, Object> body, UUID branchId) {
        body.put("branchId", branchId.toString());
        return body;
    }

    @Test
    void anotherBusinessesLinkIsNeverUsedAndNothingIsCreatedSilently() {
        // The cafe owner sets up a perfectly good link in THEIR business.
        rw.oupay.support.Bank.link(mvc, w.cafeOwner, w.cafeMerchantId);
        UUID cafeDestination = jdbc.queryForObject("select id from payment_destinations where merchant_id = ?", UUID.class, w.cafeMerchantId);
        var cafeLink = w.cafeOwner.post("/api/v1/merchants/" + w.cafeMerchantId + "/payment-profiles",
                Map.of("label", "Cafe", "paymentDestinationId", cafeDestination.toString()));
        assertThat(cafeLink.status()).isEqualTo(201);

        int branches = count("branches");
        int assignments = count("branch_assignments");
        int profiles = count("payment_profiles");
        int memberships = count("memberships");

        // The shop has no link: the sale fails, it does not borrow the cafe's.
        assertThat(bill(w.cashier, 1_000).code()).isEqualTo("no_active_profile");
        assertThat(w.cashier.get(base() + "/options").json().path("readiness").asString()).isEqualTo("NO_PAYMENT_LINK");
        // The owner is assigned to no branch: no branch is invented or assigned for them.
        assertThat(bill(w.owner, 1_000).code()).isEqualTo("no_eligible_branch");
        // A cashier whose branch is inactive: nothing is reactivated or replaced.
        jdbc.update("update branches set status = 'INACTIVE' where id = ?", w.branchId);
        assertThat(bill(w.cashier, 1_000).code()).isEqualTo("no_eligible_branch");

        assertThat(count("branches")).isEqualTo(branches);
        assertThat(count("branch_assignments")).isEqualTo(assignments);
        assertThat(count("payment_profiles")).isEqualTo(profiles);
        assertThat(count("memberships")).isEqualTo(memberships);
        assertThat(count("invoices")).isZero();
        assertThat(count("payment_requests")).isZero();
    }

    @Test
    void peopleBillOnlyThroughTheBranchesTheyAreAssignedTo() {
        ensureProfile();
        UUID other = fixtures.branch(w.merchantId, "RM07", "ACTIVE");
        // The branch exists and is active, but nobody is assigned to it: not available to the cashier, the manager or the owner.
        for (var person : new rw.oupay.support.TestApi[] {w.cashier, w.manager, w.owner}) {
            var body = withBranch(sale(1_000, null, UUID.randomUUID()), other);
            var response = bill(person, "key-branch-" + UUID.randomUUID().toString().substring(0, 8), body);
            assertThat(response.status()).as(response.body()).isEqualTo(w.owner == person ? 409 : 422);
        }
        // Once the owner assigns themselves (the existing rule), they bill like anyone else, attributed to themselves.
        fixtures.assign(w.merchantId, w.ownerMembershipId, w.branchId);
        var owner = bill(w.owner, 2_000);
        assertThat(owner.status()).as(owner.body()).isEqualTo(201);
        assertThat(jdbc.queryForObject("select assigned_to_user_id from invoices where id = cast(? as uuid)", UUID.class,
                owner.json().path("invoiceId").asString())).isEqualTo(w.ownerPerson.userId());
        assertThat(count("invoices")).isEqualTo(1);
    }
}
