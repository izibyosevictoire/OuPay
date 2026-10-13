package rw.oupay.staff;

import static org.assertj.core.api.Assertions.assertThat;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.Executors;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import rw.oupay.support.Fixtures;
import rw.oupay.support.IntegrationTest;
import rw.oupay.support.TestApi;
import rw.oupay.support.World;

/** Staff invitations: the workflow, the privilege rules, expiry, single use and races. */
class InvitationIT extends IntegrationTest {

    World w;

    @BeforeEach
    void world() {
        w = World.create(this);
    }

    private String m(String path) {
        return "/api/v1/merchants/" + w.merchantId + path;
    }

    private Map<String, Object> body(String email, String role, List<UUID> branches) {
        return Map.of("email", email, "role", role, "branchIds", branches, "note", "Welcome aboard");
    }

    private TestApi.Response invite(TestApi api, String email, String role, List<UUID> branches) {
        return api.post(m("/invitations"), body(email, role, branches));
    }

    private TestApi anonymous() {
        return new TestApi(mvc);
    }

    private String membershipStatus(String email) {
        return jdbc.queryForObject("select m.status from memberships m join users u on u.id = m.user_id where lower(u.email) = lower(?) and m.merchant_id = ?",
                String.class, email, w.merchantId);
    }

    private String roleOf(String email) {
        return jdbc.queryForObject("select m.role from memberships m join users u on u.id = m.user_id where lower(u.email) = lower(?) and m.merchant_id = ?",
                String.class, email, w.merchantId);
    }

    // ---- the happy paths -----------------------------------------------------------------------

    @Test
    void aNewPersonIsInvitedByEmailRegistersThroughTheLinkAndJoinsWithTheInvitedRoleAndBranches() {
        var created = invite(w.owner, "Fresh.Hire@Example.rw", "CASHIER", List.of(w.branchId));
        assertThat(created.status()).isEqualTo(201);
        var dto = created.json();
        assertThat(dto.path("email").asString()).isEqualTo("fresh.hire@example.rw");
        assertThat(dto.path("status").asString()).isEqualTo("PENDING");
        assertThat(dto.path("role").asString()).isEqualTo("CASHIER");
        // The link token is never handed back to the inviter's browser; it only travels by e-mail.
        assertThat(created.body()).doesNotContainIgnoringCase("token").doesNotContain("demoToken");
        assertThat(membershipStatus("fresh.hire@example.rw")).isEqualTo("INVITED");
        assertThat(jdbc.queryForObject("select status from users where lower(email) = 'fresh.hire@example.rw'", String.class)).isEqualTo("PENDING");
        assertThat(jdbc.queryForObject("select count(*) from branch_assignments where membership_id = (select id from memberships where role = 'CASHIER' and status = 'INVITED')", Integer.class)).isZero();

        String token = tokenFrom("fresh.hire@example.rw", "/accept-invitation/");

        var preview = anonymous().get("/api/v1/public/invitations/" + token);
        assertThat(preview.status()).isEqualTo(200);
        assertThat(preview.json().path("email").asString()).isEqualTo("fresh.hire@example.rw");
        assertThat(preview.json().path("businessName").asString()).isEqualTo("Sample Shop Ltd");
        assertThat(preview.json().path("status").asString()).isEqualTo("PENDING");
        assertThat(preview.json().path("inviteeHasActiveAccount").asBoolean()).isFalse();
        assertThat(preview.body()).doesNotContain("merchantId").doesNotContain("invitedBy");

        // Before accepting, they cannot sign in with anything.
        assertThat(anonymous().post("/api/v1/auth/login", Map.of("email", "fresh.hire@example.rw", "password", Fixtures.PASSWORD)).status()).isEqualTo(401);

        TestApi newcomer = anonymous();
        var registered = newcomer.post("/api/v1/auth/register", Map.of("fullName", "Fresh Hire", "email", "fresh.hire@example.rw",
                "password", "Welcome-aboard-5", "invitationToken", token));
        assertThat(registered.status()).isEqualTo(200);
        assertThat(registered.json().path("user").path("emailVerified").asBoolean()).isTrue();
        assertThat(registered.json().path("memberships").get(0).path("role").asString()).isEqualTo("CASHIER");
        assertThat(registered.json().path("memberships").get(0).path("status").asString()).isEqualTo("ACTIVE");
        assertThat(membershipStatus("fresh.hire@example.rw")).isEqualTo("ACTIVE");
        assertThat(jdbc.queryForObject("select count(*) from branch_assignments where status = 'ACTIVE' and branch_id = ? and membership_id = "
                + "(select m.id from memberships m join users u on u.id = m.user_id where lower(u.email) = 'fresh.hire@example.rw')", Integer.class, w.branchId)).isEqualTo(1);
        assertThat(newcomer.get(m("/invoices")).status()).isEqualTo(200);

        // The link is spent.
        assertThat(anonymous().get("/api/v1/public/invitations/" + token).json().path("status").asString()).isEqualTo("ACCEPTED");
        var reuse = anonymous().post("/api/v1/auth/register", Map.of("fullName", "Someone Else", "email", "fresh.hire@example.rw",
                "password", "Welcome-aboard-5", "invitationToken", token));
        assertThat(reuse.status()).isEqualTo(400);
        assertThat(reuse.code()).isEqualTo("invalid_invitation");
    }

    @Test
    void anExistingUserAcceptsWhileSignedInAndGetsExactlyTheInvitedRole() {
        // The owner of the café is an existing user of OuPay.
        assertThat(invite(w.owner, "owner@cafe.rw", "MANAGER", List.of(w.branchId)).status()).isEqualTo(201);
        assertThat(membershipStatus("owner@cafe.rw")).isEqualTo("INVITED");
        // An INVITED membership grants nothing: the shop is still invisible to them.
        assertThat(w.cafeOwner.get(m("/branches")).status()).isEqualTo(404);

        String token = tokenFrom("owner@cafe.rw", "/accept-invitation/");
        assertThat(anonymous().get("/api/v1/public/invitations/" + token).json().path("inviteeHasActiveAccount").asBoolean()).isTrue();

        var accepted = w.cafeOwner.post("/api/v1/invitations/" + token + "/accept", null);
        assertThat(accepted.status()).isEqualTo(200);
        assertThat(accepted.json().path("role").asString()).isEqualTo("MANAGER");
        assertThat(accepted.json().path("status").asString()).isEqualTo("ACTIVE");
        assertThat(roleOf("owner@cafe.rw")).isEqualTo("MANAGER");
        assertThat(w.cafeOwner.get(m("/branches")).status()).isEqualTo(200);
        // Their own business is untouched.
        assertThat(w.cafeOwner.get("/api/v1/merchants/" + w.cafeMerchantId + "/branches").status()).isEqualTo(200);
        assertThat(jdbc.queryForObject("select email_verified_at is not null from users where lower(email) = 'owner@cafe.rw'", Boolean.class)).isTrue();
    }

    @Test
    void theStaffListShowsInvitedPeopleWithTheirPlannedBranchesAndNoToken() {
        invite(w.owner, "listed@example.rw", "CASHIER", List.of(w.branchId));
        var list = w.owner.get(m("/staff"));
        assertThat(list.status()).isEqualTo(200);
        var row = list.json().valueStream().filter(n -> "listed@example.rw".equals(n.path("email").asString())).findFirst().orElseThrow();
        assertThat(row.path("status").asString()).isEqualTo("INVITED");
        assertThat(row.path("branchIds").get(0).asString()).isEqualTo(w.branchId.toString());
        assertThat(row.path("pendingInvitation").path("note").asString()).isEqualTo("Welcome aboard");
        assertThat(list.body()).doesNotContainIgnoringCase("token");
    }

    // ---- privilege rules -----------------------------------------------------------------------

    @Test
    void whoMayInviteWhom() {
        // Managers: cashiers only. Never managers, never owners.
        assertThat(invite(w.manager, "a@example.rw", "CASHIER", List.of()).status()).isEqualTo(201);
        assertThat(invite(w.manager, "b@example.rw", "MANAGER", List.of()).status()).isEqualTo(403);
        assertThat(invite(w.manager, "c@example.rw", "OWNER", List.of()).status()).isIn(403, 422);
        // Owners: managers and cashiers, but nobody becomes an owner through an invitation.
        assertThat(invite(w.owner, "d@example.rw", "MANAGER", List.of()).status()).isEqualTo(201);
        assertThat(invite(w.owner, "e@example.rw", "OWNER", List.of()).status()).isEqualTo(422);
        // Cashiers invite nobody.
        assertThat(invite(w.cashier, "f@example.rw", "CASHIER", List.of()).status()).isEqualTo(403);
        // Another business's owner cannot invite into this one; it looks like the business does not exist.
        assertThat(invite(w.cafeOwner, "g@example.rw", "CASHIER", List.of()).status()).isEqualTo(404);
        assertThat(anonymous().post(m("/invitations"), body("h@example.rw", "CASHIER", List.of())).status()).isIn(401, 403);
        assertThat(jdbc.queryForObject("select count(*) from staff_invitations", Integer.class)).isEqualTo(2);
    }

    @Test
    void anInvitationCannotBeUsedToTakeAHigherRoleOrAnotherMembership() {
        invite(w.manager, "newbie@example.rw", "CASHIER", List.of());
        String token = tokenFrom("newbie@example.rw", "/accept-invitation/");
        // Another signed-in person (even the owner) cannot spend somebody else's link.
        var stolen = w.otherCashier.post("/api/v1/invitations/" + token + "/accept", null);
        assertThat(stolen.status()).isEqualTo(403);
        assertThat(stolen.code()).isEqualTo("invitation_email_mismatch");
        assertThat(w.owner.post("/api/v1/invitations/" + token + "/accept", null).code()).isEqualTo("invitation_email_mismatch");
        assertThat(membershipStatus("newbie@example.rw")).isEqualTo("INVITED");
        // Registering through the link with a different address is refused too.
        var wrongEmail = anonymous().post("/api/v1/auth/register", Map.of("fullName", "Impostor", "email", "impostor@example.rw",
                "password", "Welcome-aboard-5", "invitationToken", token));
        assertThat(wrongEmail.status()).isEqualTo(403);
        assertThat(jdbc.queryForObject("select count(*) from users where lower(email) = 'impostor@example.rw'", Integer.class)).isZero();
        // The rightful invitee still can, and gets CASHIER whatever the request says.
        var ok = anonymous().post("/api/v1/auth/register", Map.of("fullName", "Newbie", "email", "newbie@example.rw",
                "password", "Welcome-aboard-5", "invitationToken", token, "role", "OWNER"));
        assertThat(ok.status()).isEqualTo(200);
        assertThat(roleOf("newbie@example.rw")).isEqualTo("CASHIER");
    }

    @Test
    void aPlainRegistrationCannotClaimAnInvitedPlaceholder() {
        invite(w.owner, "placeholder@example.rw", "MANAGER", List.of());
        var claim = anonymous().post("/api/v1/auth/register", Map.of("fullName", "Squatter", "email", "placeholder@example.rw", "password", "Welcome-aboard-5"));
        assertThat(claim.status()).isEqualTo(409);
        assertThat(claim.code()).isEqualTo("email_taken");
        assertThat(jdbc.queryForObject("select status from users where lower(email) = 'placeholder@example.rw'", String.class)).isEqualTo("PENDING");
        assertThat(membershipStatus("placeholder@example.rw")).isEqualTo("INVITED");
    }

    @Test
    void branchesMustBeActiveBranchesOfThisBusiness() {
        assertThat(invite(w.owner, "x1@example.rw", "CASHIER", List.of(w.cafeBranchId)).status()).isEqualTo(404);
        var inactive = invite(w.owner, "x2@example.rw", "CASHIER", List.of(w.inactiveBranchId));
        assertThat(inactive.status()).isEqualTo(409);
        assertThat(inactive.code()).isEqualTo("branch_inactive");
        var twice = invite(w.owner, "x3@example.rw", "CASHIER", List.of(w.branchId, w.branchId));
        assertThat(twice.status()).isEqualTo(409);
        assertThat(twice.code()).isEqualTo("duplicate_assignment");
        assertThat(invite(w.owner, "x4@example.rw", "CASHIER", List.of(UUID.randomUUID())).status()).isEqualTo(404);
        // Nothing was half-created.
        assertThat(jdbc.queryForObject("select count(*) from staff_invitations", Integer.class)).isZero();
        assertThat(jdbc.queryForObject("select count(*) from users where email like 'x%@example.rw'", Integer.class)).isZero();
    }

    @Test
    void aBranchThatBecomesInactiveBeforeAcceptanceIsSimplyNotAssigned() {
        UUID branch = fixtures.branch(w.merchantId, "TMP1", "ACTIVE");
        invite(w.owner, "late.branch@example.rw", "CASHIER", List.of(branch));
        String token = tokenFrom("late.branch@example.rw", "/accept-invitation/");
        jdbc.update("update branches set status = 'INACTIVE' where id = ?", branch);
        assertThat(anonymous().post("/api/v1/auth/register", Map.of("fullName", "Late Branch", "email", "late.branch@example.rw",
                "password", "Welcome-aboard-5", "invitationToken", token)).status()).isEqualTo(200);
        assertThat(jdbc.queryForObject("select count(*) from branch_assignments where branch_id = ?", Integer.class, branch)).isZero();
    }

    // ---- duplicates, revocation, expiry --------------------------------------------------------

    @Test
    void membersAndPendingInviteesCannotBeInvitedAgain() {
        for (String email : List.of("aline@shop.rw", "manager@shop.rw", "owner@shop.rw")) {
            var response = invite(w.owner, email, "CASHIER", List.of());
            assertThat(response.status()).as(email).isEqualTo(409);
            assertThat(response.code()).isEqualTo("duplicate_invitation");
        }
        assertThat(invite(w.owner, "once@example.rw", "CASHIER", List.of()).status()).isEqualTo(201);
        assertThat(invite(w.owner, "ONCE@example.rw", "MANAGER", List.of()).code()).isEqualTo("duplicate_invitation");
        // Re-inviting must never be a way to change a member's role.
        assertThat(roleOf("aline@shop.rw")).isEqualTo("CASHIER");
        w.owner.post(m("/memberships/" + w.cashierMembershipId + "/suspend"), null);
        assertThat(invite(w.owner, "aline@shop.rw", "MANAGER", List.of()).code()).isEqualTo("duplicate_invitation");
    }

    @Test
    void revokingAPendingInvitationKillsTheLinkAndAFreshInvitationWorks() {
        var created = invite(w.owner, "revoke.me@example.rw", "CASHIER", List.of());
        String oldToken = tokenFrom("revoke.me@example.rw", "/accept-invitation/");
        UUID membershipId = UUID.fromString(created.json().path("membershipId").asString());
        assertThat(w.manager.post(m("/memberships/" + membershipId + "/revoke"), null).status()).isEqualTo(200);

        assertThat(membershipStatus("revoke.me@example.rw")).isEqualTo("REVOKED");
        assertThat(anonymous().get("/api/v1/public/invitations/" + oldToken).json().path("status").asString()).isEqualTo("REVOKED");
        var dead = anonymous().post("/api/v1/auth/register", Map.of("fullName", "Revoked", "email", "revoke.me@example.rw",
                "password", "Welcome-aboard-5", "invitationToken", oldToken));
        assertThat(dead.code()).isEqualTo("invalid_invitation");

        // A new invitation reuses the membership and has its own link; the old one stays dead.
        assertThat(invite(w.owner, "revoke.me@example.rw", "CASHIER", List.of()).status()).isEqualTo(201);
        String newToken = tokenFrom("revoke.me@example.rw", "/accept-invitation/");
        assertThat(newToken).isNotEqualTo(oldToken);
        assertThat(anonymous().post("/api/v1/auth/register", Map.of("fullName", "Revoked", "email", "revoke.me@example.rw",
                "password", "Welcome-aboard-5", "invitationToken", oldToken)).code()).isEqualTo("invalid_invitation");
        assertThat(anonymous().post("/api/v1/auth/register", Map.of("fullName", "Revoked", "email", "revoke.me@example.rw",
                "password", "Welcome-aboard-5", "invitationToken", newToken)).status()).isEqualTo(200);
        assertThat(jdbc.queryForObject("select count(*) from memberships m join users u on u.id = m.user_id where lower(u.email) = 'revoke.me@example.rw'", Integer.class)).isEqualTo(1);
    }

    @Test
    void anExpiredInvitationCannotBeAcceptedAndCanBeReissued() {
        invite(w.owner, "expiring@example.rw", "CASHIER", List.of());
        String token = tokenFrom("expiring@example.rw", "/accept-invitation/");
        jdbc.update("update staff_invitations set expires_at = ?", Timestamp.from(Instant.now().minusSeconds(60)));
        assertThat(anonymous().get("/api/v1/public/invitations/" + token).json().path("status").asString()).isEqualTo("EXPIRED");
        assertThat(anonymous().post("/api/v1/auth/register", Map.of("fullName", "Too Late", "email", "expiring@example.rw",
                "password", "Welcome-aboard-5", "invitationToken", token)).code()).isEqualTo("invalid_invitation");
        assertThat(membershipStatus("expiring@example.rw")).isEqualTo("INVITED");
        assertThat(w.owner.get(m("/invitations")).json().get(0).path("status").asString()).isEqualTo("EXPIRED");

        assertThat(invite(w.owner, "expiring@example.rw", "CASHIER", List.of()).status()).isEqualTo(201);
        assertThat(jdbc.queryForObject("select count(*) from staff_invitations where status = 'PENDING'", Integer.class)).isEqualTo(1);
        assertThat(jdbc.queryForObject("select count(*) from staff_invitations where status = 'EXPIRED'", Integer.class)).isEqualTo(1);
    }

    @Test
    void unknownAndMalformedTokensLookTheSame() {
        assertThat(anonymous().get("/api/v1/public/invitations/" + "z".repeat(43)).status()).isEqualTo(400);
        assertThat(anonymous().get("/api/v1/public/invitations/" + "z".repeat(43)).code()).isEqualTo("invalid_invitation");
        assertThat(anonymous().get("/api/v1/public/invitations/" + "z".repeat(300)).code()).isEqualTo("invalid_invitation");
        assertThat(w.cashier.post("/api/v1/invitations/" + "z".repeat(43) + "/accept", null).code()).isEqualTo("invalid_invitation");
        assertThat(anonymous().post("/api/v1/invitations/" + "z".repeat(43) + "/accept", null).status()).isIn(401, 403);
    }

    @Test
    void listingInvitationsFollowsThePermissionsOfTheViewer() {
        invite(w.owner, "mgr.invite@example.rw", "MANAGER", List.of());
        invite(w.owner, "cash.invite@example.rw", "CASHIER", List.of());
        assertThat(w.owner.get(m("/invitations")).json().size()).isEqualTo(2);
        // Managers manage cashiers: they never see invitations to the management tier.
        var seen = w.manager.get(m("/invitations")).json();
        assertThat(seen.size()).isEqualTo(1);
        assertThat(seen.get(0).path("email").asString()).isEqualTo("cash.invite@example.rw");
        assertThat(w.cashier.get(m("/invitations")).status()).isEqualTo(403);
        assertThat(w.cafeOwner.get(m("/invitations")).status()).isEqualTo(404);
    }

    @Test
    void invitationsAreAudited() {
        invite(w.owner, "audited@example.rw", "CASHIER", List.of());
        String token = tokenFrom("audited@example.rw", "/accept-invitation/");
        anonymous().post("/api/v1/auth/register", Map.of("fullName", "Audited", "email", "audited@example.rw",
                "password", "Welcome-aboard-5", "invitationToken", token));
        var kinds = jdbc.queryForList("select kind from audit_log where merchant_id = ?", String.class, w.merchantId);
        assertThat(kinds).contains("STAFF_INVITED", "STAFF_INVITATION_ACCEPTED");
        assertThat(String.join(" ", jdbc.queryForList("select message from audit_log", String.class))).doesNotContain(token);
    }

    // ---- last owner ----------------------------------------------------------------------------

    @Test
    void theLastOwnerCannotBeRemovedByAnyRoute() {
        assertThat(w.owner.put(m("/memberships/" + w.ownerMembershipId + "/role"), Map.of("role", "MANAGER")).status()).isEqualTo(409);
        assertThat(w.owner.post(m("/memberships/" + w.ownerMembershipId + "/suspend"), null).status()).isEqualTo(409);
        assertThat(w.owner.post(m("/memberships/" + w.ownerMembershipId + "/revoke"), null).status()).isEqualTo(409);
        assertThat(roleOf("owner@shop.rw")).isEqualTo("OWNER");
    }

    // ---- races ---------------------------------------------------------------------------------

    @Test
    void twoOwnersDemotingEachOtherAtTheSameTimeLeaveOneOwner() throws Exception {
        // A second owner (promoted by the first).
        assertThat(w.owner.put(m("/memberships/" + w.managerMembershipId + "/role"), Map.of("role", "OWNER")).status()).isEqualTo(200);
        TestApi second = fixtures.signIn(mvc, w.managerPerson);
        var pool = Executors.newFixedThreadPool(2);
        try {
            for (int round = 0; round < 40; round++) {
                jdbc.update("update memberships set role = 'OWNER' where id in (?, ?)", w.ownerMembershipId, w.managerMembershipId);
                List<Callable<Integer>> calls = List.of(
                        () -> w.owner.put(m("/memberships/" + w.managerMembershipId + "/role"), Map.of("role", "CASHIER")).status(),
                        () -> second.put(m("/memberships/" + w.ownerMembershipId + "/role"), Map.of("role", "CASHIER")).status());
                for (var f : pool.invokeAll(calls)) {
                    f.get();
                }
                assertThat(jdbc.queryForObject("select count(*) from memberships where merchant_id = ? and role = 'OWNER' and status = 'ACTIVE'",
                        Integer.class, w.merchantId)).as("round " + round).isGreaterThanOrEqualTo(1);
            }
        } finally {
            pool.shutdownNow();
        }
    }

    @Test
    void twoBrowsersAcceptingOneInvitationAtOnceActivateItOnce() throws Exception {
        invite(w.owner, "owner@cafe.rw", "CASHIER", List.of(w.branchId));
        String token = tokenFrom("owner@cafe.rw", "/accept-invitation/");
        TestApi second = fixtures.signIn(mvc, new Fixtures.Person(w.cafePerson.userId(), w.cafePerson.email(), w.cafePerson.fullName()));
        var pool = Executors.newFixedThreadPool(2);
        try {
            List<Callable<Integer>> calls = List.of(
                    () -> w.cafeOwner.post("/api/v1/invitations/" + token + "/accept", null).status(),
                    () -> second.post("/api/v1/invitations/" + token + "/accept", null).status());
            List<Integer> statuses = new ArrayList<>();
            for (var f : pool.invokeAll(calls)) {
                statuses.add(f.get());
            }
            assertThat(statuses).containsExactlyInAnyOrder(200, 400);
            assertThat(jdbc.queryForObject("select count(*) from branch_assignments where membership_id = (select m.id from memberships m join users u on u.id = m.user_id where lower(u.email) = 'owner@cafe.rw' and m.merchant_id = ?)",
                    Integer.class, w.merchantId)).isEqualTo(1);
        } finally {
            pool.shutdownNow();
        }
    }

    @Test
    void twoSimultaneousInvitationsForOneAddressCreateOne() throws Exception {
        var pool = Executors.newFixedThreadPool(4);
        try {
            List<Callable<Integer>> calls = new ArrayList<>();
            for (int i = 0; i < 4; i++) {
                TestApi api = i % 2 == 0 ? w.owner : fixtures.signIn(mvc, w.ownerPerson);
                calls.add(() -> invite(api, "dup.race@example.rw", "CASHIER", List.of()).status());
            }
            List<Integer> statuses = new ArrayList<>();
            for (var f : pool.invokeAll(calls)) {
                statuses.add(f.get());
            }
            assertThat(statuses.stream().filter(s -> s == 201).count()).isEqualTo(1);
            assertThat(statuses.stream().filter(s -> s == 409).count()).isEqualTo(3);
            assertThat(jdbc.queryForObject("select count(*) from users where lower(email) = 'dup.race@example.rw'", Integer.class)).isEqualTo(1);
            assertThat(jdbc.queryForObject("select count(*) from staff_invitations where status = 'PENDING'", Integer.class)).isEqualTo(1);
            assertThat(outbox("dup.race@example.rw", "STAFF_INVITATION")).isEqualTo(1);
        } finally {
            pool.shutdownNow();
        }
    }
}
