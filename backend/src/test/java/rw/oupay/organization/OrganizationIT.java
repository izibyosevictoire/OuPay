package rw.oupay.organization;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import rw.oupay.support.IntegrationTest;
import rw.oupay.support.TestApi;
import rw.oupay.support.World;

class OrganizationIT extends IntegrationTest {

    World w;

    @BeforeEach
    void world() {
        w = World.create(this);
    }

    private String m(String path) {
        return "/api/v1/merchants/" + w.merchantId + path;
    }

    private Map<String, Object> branchBody(String code) {
        return Map.of("name", "Nyamirambo", "code", code,
                "location", Map.of("province", "Kigali City", "district", "Nyarugenge", "sector", "Nyamirambo", "physicalAddress", "KN 5 Rd"),
                "status", "ACTIVE");
    }

    // ---- merchants -----------------------------------------------------------------------------

    @Test
    void registeringABusinessMakesTheCallerOwnerAndStaysPendingVerification() {
        var business = w.owner.get("/api/v1/merchants/" + w.merchantId);
        assertThat(business.status()).isEqualTo(200);
        assertThat(business.json().path("status").asString()).isEqualTo("pending_verification");
        assertThat(jdbc.queryForObject("select role from memberships where merchant_id = ? and user_id = ?", String.class,
                w.merchantId, w.ownerPerson.userId())).isEqualTo("OWNER");
    }

    @Test
    void duplicateTinAndMissingRegistrationNumberAreRejected() {
        var body = Map.of("legalName", "Another Ltd", "businessType", "registered_company",
                "registration", Map.of("tin", "123456789", "registrationNumber", "RC-9"),
                "location", Map.of("province", "Kigali City", "district", "Gasabo", "sector", "Remera", "physicalAddress", "KG 1"),
                "contact", Map.of("fullName", "A B", "email", "a@b.rw", "phoneNumber", "+250788123456"));
        var duplicate = w.cafeOwner.post("/api/v1/merchants", body);
        assertThat(duplicate.status()).isEqualTo(409);
        assertThat(duplicate.code()).isEqualTo("duplicate_tin");

        var noRegistration = Map.of("legalName", "Third Ltd", "businessType", "registered_company",
                "registration", Map.of("tin", "111222333"),
                "location", Map.of("province", "Kigali City", "district", "Gasabo", "sector", "Remera", "physicalAddress", "KG 1"),
                "contact", Map.of("fullName", "A B", "email", "a@b.rw", "phoneNumber", "+250788123456"));
        assertThat(w.cafeOwner.post("/api/v1/merchants", noRegistration).status()).isEqualTo(422);
        var badTin = Map.of("legalName", "Fourth Ltd", "businessType", "informal_vendor", "registration", Map.of("tin", "12"),
                "location", Map.of("province", "Kigali City", "district", "Gasabo", "sector", "Remera", "physicalAddress", "KG 1"),
                "contact", Map.of("fullName", "A B", "email", "a@b.rw", "phoneNumber", "+250788123456"));
        assertThat(w.cafeOwner.post("/api/v1/merchants", badTin).status()).isEqualTo(422);
    }

    @Test
    void eachUserSeesOnlyTheirOwnBusinessesAndOthersLookLikeTheyDoNotExist() {
        assertThat(w.owner.get("/api/v1/merchants").json().size()).isEqualTo(1);
        assertThat(w.cafeOwner.get("/api/v1/merchants").json().get(0).path("id").asString()).isEqualTo(w.cafeMerchantId.toString());
        var peek = w.cafeOwner.get("/api/v1/merchants/" + w.merchantId);
        assertThat(peek.status()).isEqualTo(404);
        // Identical to a business that really does not exist: nothing is revealed.
        assertThat(peek.body()).isEqualTo(w.cafeOwner.get("/api/v1/merchants/" + UUID.randomUUID()).body());
    }

    @Test
    void cashiersGetALimitedProfileAndOnlyOwnersMayEdit() {
        var asCashier = w.cashier.get("/api/v1/merchants/" + w.merchantId);
        assertThat(asCashier.status()).isEqualTo(200);
        assertThat(asCashier.json().path("registration").path("tin").isMissingNode()).isTrue();
        assertThat(asCashier.json().path("contact").path("email").asString()).isEmpty();

        var update = Map.of("tradingName", "Shop", "physicalAddress", "KG 99",
                "contact", Map.of("fullName", "New Contact", "email", "new@shop.rw", "phoneNumber", "+250788999999"));
        assertThat(w.cashier.put("/api/v1/merchants/" + w.merchantId, update).status()).isEqualTo(403);
        assertThat(w.manager.put("/api/v1/merchants/" + w.merchantId, update).status()).isEqualTo(403);
        assertThat(w.owner.put("/api/v1/merchants/" + w.merchantId, update).status()).isEqualTo(200);
        assertThat(w.cafeOwner.put("/api/v1/merchants/" + w.merchantId, update).status()).isEqualTo(404);
    }

    // ---- branches ------------------------------------------------------------------------------

    @Test
    void managersManageBranchesCashiersCannot() {
        assertThat(w.manager.post(m("/branches"), branchBody("ny01")).status()).isEqualTo(201);
        // Codes are stored upper-case and unique per business, ignoring case.
        assertThat(jdbc.queryForObject("select code from branches where name = 'Nyamirambo'", String.class)).isEqualTo("NY01");
        var duplicate = w.owner.post(m("/branches"), branchBody("NY01"));
        assertThat(duplicate.status()).isEqualTo(409);
        assertThat(duplicate.code()).isEqualTo("duplicate_branch_code");
        assertThat(w.cashier.get(m("/branches")).status()).isEqualTo(403);
        assertThat(w.cashier.post(m("/branches"), branchBody("ZZ99")).status()).isEqualTo(403);
        // The same code is fine in another business.
        assertThat(w.cafeOwner.post("/api/v1/merchants/" + w.cafeMerchantId + "/branches", branchBody("NY01")).status()).isEqualTo(201);
    }

    @Test
    void branchesOfAnotherBusinessAreNotReachableEvenWithTheirIds() {
        assertThat(w.cafeOwner.get("/api/v1/merchants/" + w.cafeMerchantId + "/branches/" + w.branchId).status()).isEqualTo(404);
        assertThat(w.cafeOwner.get(m("/branches")).status()).isEqualTo(404);
        var update = Map.of("name", "Hijack", "code", "HJ01",
                "location", Map.of("province", "p", "district", "d", "sector", "s", "physicalAddress", "a"));
        assertThat(w.cafeOwner.put("/api/v1/merchants/" + w.cafeMerchantId + "/branches/" + w.branchId, update).status()).isEqualTo(404);
        assertThat(jdbc.queryForObject("select name from branches where id = ?", String.class, w.branchId)).isEqualTo("Branch RM01");
    }

    @Test
    void deactivatingABranchKeepsItsHistory() {
        var response = w.owner.put(m("/branches/" + w.branchId + "/status"), Map.of("status", "INACTIVE"));
        assertThat(response.status()).isEqualTo(200);
        assertThat(jdbc.queryForObject("select count(*) from branch_assignments where branch_id = ? and status = 'ACTIVE'",
                Integer.class, w.branchId)).isEqualTo(3);
    }

    @Test
    void assignmentsFollowTheRulesAboutStatusRolesAndTenants() {
        String path = m("/memberships/" + w.cashierMembershipId + "/branch-assignments");
        var newBranch = UUID.fromString(w.manager.post(m("/branches"), branchBody("NY02")).json().path("id").asString());

        assertThat(w.manager.put(path, Map.of("branchIds", List.of(w.branchId, newBranch))).status()).isEqualTo(200);
        assertThat(jdbc.queryForObject("select count(*) from branch_assignments where membership_id = ? and status = 'ACTIVE'",
                Integer.class, w.cashierMembershipId)).isEqualTo(2);
        // Removing ends the assignment (history kept) rather than deleting it.
        assertThat(w.manager.put(path, Map.of("branchIds", List.of(w.branchId))).status()).isEqualTo(200);
        assertThat(jdbc.queryForObject("select count(*) from branch_assignments where membership_id = ? and status = 'ENDED'",
                Integer.class, w.cashierMembershipId)).isEqualTo(1);

        var inactive = w.manager.put(path, Map.of("branchIds", List.of(w.branchId, w.inactiveBranchId)));
        assertThat(inactive.status()).isEqualTo(409);
        assertThat(inactive.code()).isEqualTo("branch_inactive");
        var foreign = w.manager.put(path, Map.of("branchIds", List.of(w.cafeBranchId)));
        assertThat(foreign.status()).isEqualTo(404);
        assertThat(w.manager.put(path, Map.of("branchIds", List.of(w.branchId, w.branchId))).code()).isEqualTo("duplicate_assignment");
        // A manager cannot manage another manager; a cashier cannot manage anyone.
        assertThat(w.manager.put(m("/memberships/" + w.managerMembershipId + "/branch-assignments"), Map.of("branchIds", List.of())).status()).isEqualTo(403);
        assertThat(w.cashier.put(path, Map.of("branchIds", List.of())).status()).isEqualTo(403);
    }

    // ---- staff ---------------------------------------------------------------------------------

    @Test
    void onlyOwnersChangeRolesAndNobodyRaisesTheirOwn() {
        String rolePath = m("/memberships/" + w.cashierMembershipId + "/role");
        assertThat(w.manager.put(rolePath, Map.of("role", "MANAGER")).status()).isEqualTo(403);
        assertThat(w.cashier.put(rolePath, Map.of("role", "OWNER")).status()).isEqualTo(403);
        assertThat(w.owner.put(rolePath, Map.of("role", "MANAGER")).status()).isEqualTo(200);
    }

    @Test
    void theLastOwnerCannotBeDemotedSuspendedOrRevoked() {
        String base = m("/memberships/" + w.ownerMembershipId);
        var demote = w.owner.put(base + "/role", Map.of("role", "MANAGER"));
        assertThat(demote.status()).isEqualTo(409);
        assertThat(demote.code()).isEqualTo("last_owner");
        assertThat(w.owner.post(base + "/suspend", null).code()).isIn("last_owner", "self_escalation");
        assertThat(w.owner.post(base + "/revoke", null).code()).isIn("last_owner", "self_escalation");
        assertThat(jdbc.queryForObject("select status from memberships where id = ?", String.class, w.ownerMembershipId)).isEqualTo("ACTIVE");
    }

    @Test
    void suspendingACashierCutsOffTheirAccessAtOnce() {
        assertThat(w.cashier.get(m("/invoices")).status()).isEqualTo(200);
        assertThat(w.manager.post(m("/memberships/" + w.cashierMembershipId + "/suspend"), null).status()).isEqualTo(200);
        var after = w.cashier.get(m("/invoices"));
        assertThat(after.status()).isEqualTo(404);
        assertThat(w.manager.post(m("/memberships/" + w.cashierMembershipId + "/reactivate"), null).status()).isEqualTo(200);
        assertThat(w.cashier.get(m("/invoices")).status()).isEqualTo(200);
    }

    @Test
    void revokingIsTerminalAndEndsBranchAssignments() {
        String base = m("/memberships/" + w.cashierMembershipId);
        assertThat(w.manager.post(base + "/revoke", null).status()).isEqualTo(200);
        assertThat(jdbc.queryForObject("select count(*) from branch_assignments where membership_id = ? and status = 'ACTIVE'",
                Integer.class, w.cashierMembershipId)).isZero();
        var back = w.manager.post(base + "/reactivate", null);
        assertThat(back.status()).isEqualTo(409);
        assertThat(back.code()).isEqualTo("invalid_transition");
    }

    @Test
    void managersCannotTouchOtherManagersOrOwners() {
        assertThat(w.manager.post(m("/memberships/" + w.ownerMembershipId + "/suspend"), null).status()).isEqualTo(403);
        assertThat(w.manager.post(m("/memberships/" + w.managerMembershipId + "/revoke"), null).status()).isIn(403, 409);
    }

    @Test
    void staffListIsForManagersAndAboveAndStaysInsideTheBusiness() {
        assertThat(w.manager.get(m("/staff")).json().size()).isEqualTo(4);
        assertThat(w.cashier.get(m("/staff")).status()).isEqualTo(403);
        assertThat(w.cafeOwner.get(m("/staff")).status()).isEqualTo(404);
        assertThat(w.cafeOwner.post(m("/memberships/" + w.cashierMembershipId + "/suspend"), null).status()).isEqualTo(404);
    }

}
