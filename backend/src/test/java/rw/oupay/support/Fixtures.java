package rw.oupay.support;

import java.time.Clock;
import java.util.Map;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.TestComponent;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.test.web.servlet.MockMvc;
import rw.oupay.auth.PasswordService;
import rw.oupay.branch.Branch;
import rw.oupay.branch.BranchAssignment;
import rw.oupay.branch.BranchAssignmentRepository;
import rw.oupay.branch.BranchRepository;
import rw.oupay.membership.Membership;
import rw.oupay.membership.MembershipRepository;
import rw.oupay.membership.MembershipStatus;
import rw.oupay.membership.Role;
import rw.oupay.user.User;
import rw.oupay.user.UserRepository;
import rw.oupay.user.UserStatus;

/**
 * Builds people, businesses and branches for tests. Invitations are not implemented in the
 * backend yet, so memberships are created directly, then each person signs in through the real
 * login endpoint (so every test request goes through real authentication and authorisation).
 */
@TestComponent
public class Fixtures {

    public static final String PASSWORD = "Correct-horse-9";

    @Autowired UserRepository users;
    @Autowired MembershipRepository memberships;
    @Autowired BranchRepository branches;
    @Autowired BranchAssignmentRepository assignments;
    @Autowired PasswordService passwords;
    @Autowired Clock clock;

    public record Person(UUID userId, String email, String fullName) {}

    @Transactional
    public Person user(String email, String fullName) {
        User user = new User(UUID.randomUUID(), email, fullName, "+250788000000", passwords.hash(PASSWORD), UserStatus.ACTIVE, clock.instant());
        users.save(user);
        return new Person(user.getId(), email, fullName);
    }

    @Transactional
    public UUID member(UUID merchantId, Person person, Role role, MembershipStatus status) {
        Membership membership = new Membership(UUID.randomUUID(), person.userId(), merchantId, role, status, clock.instant());
        memberships.save(membership);
        return membership.getId();
    }

    @Transactional
    public UUID branch(UUID merchantId, String code, String status) {
        Branch branch = new Branch(UUID.randomUUID(), merchantId, "Branch " + code, code, "Kigali City", "Gasabo", "Remera",
                "KG 1 Ave", null, status, clock.instant());
        branches.save(branch);
        return branch.getId();
    }

    @Transactional
    public void assign(UUID merchantId, UUID membershipId, UUID branchId) {
        assignments.save(new BranchAssignment(UUID.randomUUID(), merchantId, membershipId, branchId, clock.instant()));
    }

    public TestApi signIn(MockMvc mvc, Person person) {
        TestApi api = new TestApi(mvc);
        var response = api.post("/api/v1/auth/login", Map.of("email", person.email(), "password", PASSWORD));
        if (response.status() != 200) {
            throw new IllegalStateException("login failed: " + response.body());
        }
        return api;
    }
}
