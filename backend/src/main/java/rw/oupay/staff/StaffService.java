package rw.oupay.staff;

import java.time.Clock;
import java.time.Instant;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Collectors;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import rw.oupay.audit.AuditService;
import rw.oupay.branch.BranchAssignment;
import rw.oupay.branch.BranchAssignmentRepository;
import rw.oupay.common.ApiException;
import rw.oupay.membership.Actor;
import rw.oupay.membership.Membership;
import rw.oupay.membership.MembershipRepository;
import rw.oupay.membership.MembershipStatus;
import rw.oupay.membership.MerchantAccess;
import rw.oupay.membership.Permission;
import rw.oupay.membership.Role;
import rw.oupay.membership.StaffPolicy;
import rw.oupay.user.User;
import rw.oupay.user.UserRepository;

/** Staff are existing Users plus memberships; there is no separate cashier account. */
@Service
public class StaffService {

    private final MembershipRepository memberships;
    private final UserRepository users;
    private final BranchAssignmentRepository assignments;
    private final MerchantAccess access;
    private final AuditService audit;
    private final Clock clock;

    public StaffService(MembershipRepository memberships, UserRepository users, BranchAssignmentRepository assignments,
                        MerchantAccess access, AuditService audit, Clock clock) {
        this.memberships = memberships;
        this.users = users;
        this.assignments = assignments;
        this.access = access;
        this.audit = audit;
        this.clock = clock;
    }

    /**
     * Invitations are not implemented (they need an email channel and single-use tokens). The caller is
     * still authorised first, so even this stub reveals nothing to someone outside the business.
     */
    @Transactional(readOnly = true)
    public void invitationsNotImplemented(UUID merchantId) {
        access.require(merchantId, Permission.CASHIERS_MANAGE);
        throw ApiException.notImplemented("Staff invitations are not implemented yet (needs an email channel).");
    }

    @Transactional(readOnly = true)
    public List<StaffDtos.StaffMemberDto> list(UUID merchantId) {
        access.require(merchantId, Permission.CASHIERS_MANAGE);
        Map<UUID, List<UUID>> branchesByMembership = assignments.findByMerchantIdAndStatus(merchantId, "ACTIVE").stream()
                .collect(Collectors.groupingBy(BranchAssignment::getMembershipId,
                        Collectors.mapping(BranchAssignment::getBranchId, Collectors.toList())));
        return memberships.findByMerchantId(merchantId).stream()
                .sorted(Comparator.comparing(Membership::getCreatedAt))
                .map(m -> {
                    User u = users.findById(m.getUserId()).orElseThrow();
                    return new StaffDtos.StaffMemberDto(merchantId, m.getId(), u.getId(), u.getFullName(), u.getEmail(),
                            u.getPhoneNumber(), m.getRole(), m.getStatus(),
                            branchesByMembership.getOrDefault(m.getId(), List.of()), m.getCreatedAt());
                })
                .toList();
    }

    @Transactional
    public rw.oupay.auth.AuthDtos.MembershipDto changeRole(UUID merchantId, UUID membershipId, Role newRole) {
        Actor actor = access.require(merchantId, Permission.CASHIERS_MANAGE);
        List<Membership> all = memberships.lockAllOfMerchant(merchantId);
        Membership target = find(all, membershipId);
        if (!StaffPolicy.canPerform(actor, StaffPolicy.Action.CHANGE_ROLE, target.getRole())) {
            throw ApiException.forbidden("You cannot change this person's role.");
        }
        if (target.getId().equals(actor.membership().getId()) && StaffPolicy.isEscalation(target.getRole(), newRole)) {
            throw new ApiException(HttpStatus.CONFLICT, "self_escalation", "You cannot raise your own role.");
        }
        if (target.getStatus() == MembershipStatus.REVOKED || target.getStatus() == MembershipStatus.INVITED) {
            throw new ApiException(HttpStatus.CONFLICT, "membership_not_active", "Only active or suspended staff can change role.");
        }
        if (target.getRole() == Role.OWNER && newRole != Role.OWNER) {
            requireAnotherActiveOwner(all, target);
        }
        target.change(newRole, target.getStatus(), clock.instant());
        audit.record(merchantId, actor.userId(), "MEMBERSHIP_ROLE_CHANGED", "membership", membershipId, "Role changed to " + newRole + ".");
        return rw.oupay.auth.AuthDtos.MembershipDto.of(target);
    }

    @Transactional
    public rw.oupay.auth.AuthDtos.MembershipDto suspend(UUID merchantId, UUID membershipId) {
        return transition(merchantId, membershipId, StaffPolicy.Action.SUSPEND, MembershipStatus.SUSPENDED, "MEMBERSHIP_SUSPENDED");
    }

    @Transactional
    public rw.oupay.auth.AuthDtos.MembershipDto reactivate(UUID merchantId, UUID membershipId) {
        return transition(merchantId, membershipId, StaffPolicy.Action.REACTIVATE, MembershipStatus.ACTIVE, "MEMBERSHIP_REACTIVATED");
    }

    /** Terminal: a revoked membership is never reactivated; it ends every branch assignment. */
    @Transactional
    public rw.oupay.auth.AuthDtos.MembershipDto revoke(UUID merchantId, UUID membershipId) {
        return transition(merchantId, membershipId, StaffPolicy.Action.REVOKE, MembershipStatus.REVOKED, "MEMBERSHIP_REVOKED");
    }

    private rw.oupay.auth.AuthDtos.MembershipDto transition(UUID merchantId, UUID membershipId, StaffPolicy.Action action,
                                                            MembershipStatus to, String auditKind) {
        Actor actor = access.require(merchantId, Permission.CASHIERS_MANAGE);
        List<Membership> all = memberships.lockAllOfMerchant(merchantId);
        Membership target = find(all, membershipId);
        if (!StaffPolicy.canPerform(actor, action, target.getRole())) {
            throw ApiException.forbidden("You cannot do that to this person.");
        }
        MembershipStatus from = target.getStatus();
        boolean legal = switch (to) {
            case SUSPENDED -> from == MembershipStatus.ACTIVE;
            case ACTIVE -> from == MembershipStatus.SUSPENDED;
            case REVOKED -> from != MembershipStatus.REVOKED;
            case INVITED -> false;
        };
        if (!legal) {
            throw new ApiException(HttpStatus.CONFLICT, "invalid_transition", "That change is not possible from the current status.");
        }
        if (target.getId().equals(actor.membership().getId()) && to != MembershipStatus.ACTIVE) {
            throw new ApiException(HttpStatus.CONFLICT, "self_escalation", "You cannot suspend or revoke yourself.");
        }
        if (target.getRole() == Role.OWNER && to != MembershipStatus.ACTIVE) {
            requireAnotherActiveOwner(all, target);
        }
        Instant now = clock.instant();
        target.change(target.getRole(), to, now);
        if (to == MembershipStatus.REVOKED) {
            assignments.findByMembershipIdAndStatus(membershipId, "ACTIVE").forEach(a -> a.end(now));
        }
        audit.record(merchantId, actor.userId(), auditKind, "membership", membershipId, "Membership " + to.name().toLowerCase() + ".");
        return rw.oupay.auth.AuthDtos.MembershipDto.of(target);
    }

    /** A business always keeps at least one ACTIVE owner. */
    private static void requireAnotherActiveOwner(List<Membership> all, Membership leaving) {
        boolean other = all.stream().anyMatch(m -> !m.getId().equals(leaving.getId())
                && m.getRole() == Role.OWNER && m.getStatus() == MembershipStatus.ACTIVE);
        if (!other) {
            throw new ApiException(HttpStatus.CONFLICT, "last_owner", "A business must keep at least one active owner.");
        }
    }

    private static Membership find(List<Membership> all, UUID membershipId) {
        return all.stream().filter(m -> m.getId().equals(membershipId)).findFirst()
                .orElseThrow(() -> ApiException.notFound("This staff member could not be found."));
    }
}
