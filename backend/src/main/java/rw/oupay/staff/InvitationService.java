package rw.oupay.staff;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.HashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import rw.oupay.audit.AuditService;
import rw.oupay.auth.AuthDtos;
import rw.oupay.auth.AuthService;
import rw.oupay.auth.CurrentUser;
import rw.oupay.auth.PasswordService;
import rw.oupay.auth.SecurityProperties;
import rw.oupay.branch.Branch;
import rw.oupay.branch.BranchAssignment;
import rw.oupay.branch.BranchAssignmentRepository;
import rw.oupay.branch.BranchRepository;
import rw.oupay.common.ApiException;
import rw.oupay.common.SecureTokens;
import rw.oupay.common.TokenHashing;
import rw.oupay.email.EmailOutboxService;
import rw.oupay.email.EmailTemplates;
import rw.oupay.membership.Actor;
import rw.oupay.membership.Membership;
import rw.oupay.membership.MembershipLocks;
import rw.oupay.membership.MembershipRepository;
import rw.oupay.membership.MembershipStatus;
import rw.oupay.membership.MerchantAccess;
import rw.oupay.membership.Permission;
import rw.oupay.membership.Role;
import rw.oupay.membership.StaffPolicy;
import rw.oupay.merchant.MerchantRepository;
import rw.oupay.user.User;
import rw.oupay.user.UserRepository;
import rw.oupay.user.UserStatus;

/**
 * Staff invitations: owners and managers invite people by e-mail; the person accepts with a single-use,
 * expiring link. Existing users accept while signed in; people without an account register through the link.
 *
 * <p>Privilege rules, all enforced here and in the database:
 * <ul>
 *   <li>who may invite which role is {@link StaffPolicy} (managers: cashiers only; nobody: owners);</li>
 *   <li>the role and branches are fixed by the INVITATION, never by the person accepting it;</li>
 *   <li>an invitation can only ever activate the membership it was created for, and only for the user whose
 *       e-mail address it was sent to;</li>
 *   <li>branches must be ACTIVE branches of the same business (composite foreign key);</li>
 *   <li>a link works once (conditional UPDATE) and expires;</li>
 *   <li>membership changes take the business-wide membership lock first, so they serialise with the
 *       last-owner protection, and invitation rows are always locked after it (no deadlock).</li>
 * </ul>
 */
@Service
public class InvitationService {

    private final StaffInvitationStore store;
    private final MembershipRepository memberships;
    private final MembershipLocks locks;
    private final UserRepository users;
    private final BranchRepository branches;
    private final BranchAssignmentRepository assignments;
    private final MerchantRepository merchants;
    private final MerchantAccess access;
    private final PasswordService passwords;
    private final EmailOutboxService outbox;
    private final EmailTemplates templates;
    private final SecurityProperties properties;
    private final AuditService audit;
    private final Clock clock;

    public InvitationService(StaffInvitationStore store, MembershipRepository memberships, MembershipLocks locks, UserRepository users,
                             BranchRepository branches, BranchAssignmentRepository assignments, MerchantRepository merchants,
                             MerchantAccess access, PasswordService passwords, EmailOutboxService outbox, EmailTemplates templates,
                             SecurityProperties properties, AuditService audit, Clock clock) {
        this.store = store;
        this.memberships = memberships;
        this.locks = locks;
        this.users = users;
        this.branches = branches;
        this.assignments = assignments;
        this.merchants = merchants;
        this.access = access;
        this.passwords = passwords;
        this.outbox = outbox;
        this.templates = templates;
        this.properties = properties;
        this.audit = audit;
        this.clock = clock;
    }

    // ---- inviter side --------------------------------------------------------------------------

    @Transactional
    public StaffDtos.InvitationDto invite(UUID merchantId, StaffDtos.InviteRequest request) {
        Actor actor = access.require(merchantId, Permission.CASHIERS_MANAGE);
        Role role = request.role();
        if (role == Role.OWNER) {
            throw ApiException.validation("Owners cannot be invited. Promote an existing member instead.");
        }
        if (!StaffPolicy.canPerform(actor, StaffPolicy.Action.INVITE, role)) {
            throw ApiException.forbidden("You cannot invite someone to this role.");
        }
        List<UUID> branchIds = request.branchIds() == null ? List.of() : request.branchIds();
        assertBranchesAreAssignable(merchantId, branchIds);

        String email = AuthService.normaliseEmail(request.email());
        Instant now = clock.instant();
        List<Membership> all = locks.lockAll(merchantId);
        if (!actor.membership().isActive() || !StaffPolicy.canPerform(actor, StaffPolicy.Action.INVITE, role)) {
            // Suspended or demoted by a concurrent change since the check above.
            throw ApiException.forbidden("You cannot invite someone to this role.");
        }
        Optional<User> existing = users.findByEmailIgnoreCase(email);

        User invitee;
        Membership membership;
        if (existing.isPresent()) {
            invitee = existing.get();
            Optional<Membership> current = all.stream().filter(m -> m.getUserId().equals(invitee.getId())).findFirst();
            if (current.isPresent()) {
                membership = current.get();
                reusable(membership, now);
                membership.change(role, MembershipStatus.INVITED, now);
            } else {
                membership = memberships.save(new Membership(UUID.randomUUID(), invitee.getId(), merchantId, role, MembershipStatus.INVITED, now));
            }
        } else {
            // A placeholder that cannot sign in (no password, PENDING) until the invitation is accepted.
            invitee = new User(UUID.randomUUID(), email, email.length() > 120 ? email.substring(0, 120) : email, "", null, UserStatus.PENDING, now);
            try {
                users.saveAndFlush(invitee);
            } catch (DataIntegrityViolationException race) {
                throw duplicate();
            }
            membership = memberships.save(new Membership(UUID.randomUUID(), invitee.getId(), merchantId, role, MembershipStatus.INVITED, now));
        }

        // The invitation row references the membership with a composite foreign key: make sure it exists in the database first.
        memberships.flush();

        Duration ttl = properties.recovery().invitationTtl();
        String token = SecureTokens.sessionToken();
        String note = request.note() == null || request.note().isBlank() ? null : request.note().strip();
        var row = new StaffInvitationStore.Row(UUID.randomUUID(), merchantId, membership.getId(), email, role, note, actor.userId(),
                "PENDING", now.plus(ttl), now, now);
        store.insert(row, TokenHashing.sha256(token), branchIds);

        String businessName = merchants.findById(merchantId).map(m -> m.displayName()).orElse("a business");
        String inviteeName = invitee.getStatus() == UserStatus.PENDING ? null : invitee.getFullName();
        outbox.enqueue("STAFF_INVITATION", email, invitee.getId(),
                templates.staffInvitation(inviteeName, actor.user().getFullName(), businessName, roleLabel(role), note, token, ttl));
        audit.record(merchantId, actor.userId(), "STAFF_INVITED", "membership", membership.getId(), "Invited a " + roleLabel(role) + ".");
        return toDto(row, branchIds, now);
    }

    @Transactional(readOnly = true)
    public List<StaffDtos.InvitationDto> list(UUID merchantId) {
        Actor actor = access.require(merchantId, Permission.CASHIERS_MANAGE);
        Instant now = clock.instant();
        boolean everything = actor.can(Permission.MEMBERSHIP_MANAGE);
        return store.listForMerchant(merchantId).stream()
                // Managers manage cashiers only: they do not see invitations to the management tier.
                .filter(r -> everything || r.role() == Role.CASHIER)
                .map(r -> toDto(r, store.branchIds(r.id()), now))
                .toList();
    }

    /** Called by {@link StaffService} when an INVITED membership is revoked: its link must stop working. */
    @Transactional
    public void withdrawFor(UUID membershipId) {
        Instant now = clock.instant();
        store.lockPendingForMembership(membershipId).ifPresent(r -> store.transition(r.id(), "PENDING", "REVOKED", now));
    }

    // ---- invitee side --------------------------------------------------------------------------

    /** Open to anyone holding the link; reveals only what the invitee needs. */
    @Transactional(readOnly = true)
    public StaffDtos.InvitationPreviewDto preview(String token) {
        var row = store.findByTokenHash(TokenHashing.sha256(validToken(token))).orElseThrow(InvitationService::invalid);
        String businessName = merchants.findById(row.merchantId()).map(m -> m.displayName()).orElse("a business");
        boolean hasAccount = users.findByEmailIgnoreCase(row.email()).filter(u -> u.getStatus() == UserStatus.ACTIVE).isPresent();
        return new StaffDtos.InvitationPreviewDto(row.email(), row.role(), businessName, row.effectiveStatus(clock.instant()), hasAccount);
    }

    /** Existing user, signed in: the invitation must have been sent to their address. */
    @Transactional
    public AuthDtos.MembershipDto accept(String token) {
        var principal = CurrentUser.require();
        User user = users.findById(principal.userId()).filter(u -> u.getStatus() == UserStatus.ACTIVE).orElseThrow(ApiException::unauthenticated);
        byte[] hash = TokenHashing.sha256(validToken(token));
        var peek = store.findByTokenHash(hash).orElseThrow(InvitationService::invalid);
        locks.lockAll(peek.merchantId());
        var row = store.lockByTokenHash(hash).orElseThrow(InvitationService::invalid);
        requirePending(row);
        if (!row.email().equalsIgnoreCase(user.getEmail())) {
            throw new ApiException(HttpStatus.FORBIDDEN, "invitation_email_mismatch",
                    "This invitation was sent to a different email address.");
        }
        // The link reached this mailbox, which proves control of the address.
        user.markEmailVerified(clock.instant());
        users.save(user);
        return AuthDtos.MembershipDto.of(activate(row, user));
    }

    /**
     * A person without an account registers through the link: the invited address is fixed, the account
     * is created from the placeholder and the membership activated, all or nothing.
     */
    @Transactional
    public User registerFromInvitation(String token, String email, String fullName, String phone, String rawPassword) {
        byte[] hash = TokenHashing.sha256(validToken(token));
        var peek = store.findByTokenHash(hash).orElseThrow(InvitationService::invalid);
        locks.lockAll(peek.merchantId());
        var row = store.lockByTokenHash(hash).orElseThrow(InvitationService::invalid);
        requirePending(row);
        if (!row.email().equalsIgnoreCase(email)) {
            throw new ApiException(HttpStatus.FORBIDDEN, "invitation_email_mismatch", "This invitation was sent to a different email address.");
        }
        User user = users.findByEmailIgnoreCase(row.email()).orElseThrow(InvitationService::invalid);
        if (user.getStatus() != UserStatus.PENDING) {
            throw new ApiException(HttpStatus.CONFLICT, "email_taken", "That email address already has an account. Sign in to accept the invitation.");
        }
        passwords.validatePolicy(rawPassword, row.email());
        user.activateFromInvitation(fullName.strip(), phone, passwords.hash(rawPassword), clock.instant());
        users.save(user);
        activate(row, user);
        return user;
    }

    // ---- shared --------------------------------------------------------------------------------

    private Membership activate(StaffInvitationStore.Row row, User user) {
        Instant now = clock.instant();
        Membership membership = memberships.findByIdAndMerchantId(row.membershipId(), row.merchantId()).orElseThrow(InvitationService::invalid);
        if (!membership.getUserId().equals(user.getId()) || membership.getStatus() != MembershipStatus.INVITED) {
            throw invalid();
        }
        if (!store.transition(row.id(), "PENDING", "ACCEPTED", now)) {
            throw invalid();
        }
        // Role and branches come from the invitation, never from the person accepting it.
        membership.change(row.role(), MembershipStatus.ACTIVE, now);
        for (UUID branchId : store.branchIds(row.id())) {
            Optional<Branch> branch = branches.findByIdAndMerchantId(branchId, row.merchantId()).filter(Branch::isActive);
            if (branch.isPresent() && !assignments.existsByMembershipIdAndBranchIdAndStatus(membership.getId(), branchId, "ACTIVE")) {
                assignments.save(new BranchAssignment(UUID.randomUUID(), row.merchantId(), membership.getId(), branchId, now));
            }
        }
        audit.record(row.merchantId(), user.getId(), "STAFF_INVITATION_ACCEPTED", "membership", membership.getId(),
                "Accepted an invitation as " + roleLabel(row.role()) + ".");
        return membership;
    }

    /** An existing membership may be invited again only if it was revoked, or its invitation lapsed. */
    private void reusable(Membership membership, Instant now) {
        switch (membership.getStatus()) {
            case REVOKED -> { }
            case INVITED -> {
                var pending = store.lockPendingForMembership(membership.getId());
                if (pending.isPresent() && pending.get().expiresAt().isAfter(now)) {
                    throw duplicate();
                }
                pending.ifPresent(r -> store.transition(r.id(), "PENDING", "EXPIRED", now));
            }
            case ACTIVE, SUSPENDED -> throw duplicate();
        }
    }

    private void assertBranchesAreAssignable(UUID merchantId, List<UUID> branchIds) {
        Set<UUID> seen = new HashSet<>();
        for (UUID branchId : branchIds) {
            if (!seen.add(branchId)) {
                throw new ApiException(HttpStatus.CONFLICT, "duplicate_assignment", "A branch was selected more than once.");
            }
            Branch branch = branches.findByIdAndMerchantId(branchId, merchantId)
                    .orElseThrow(() -> ApiException.notFound("A selected branch could not be found."));
            if (!branch.isActive()) {
                throw new ApiException(HttpStatus.CONFLICT, "branch_inactive", "A selected branch is inactive and cannot receive new assignments.");
            }
        }
    }

    private void requirePending(StaffInvitationStore.Row row) {
        if (!"PENDING".equals(row.effectiveStatus(clock.instant()))) {
            throw invalid();
        }
    }

    private StaffDtos.InvitationDto toDto(StaffInvitationStore.Row r, List<UUID> branchIds, Instant now) {
        return new StaffDtos.InvitationDto(r.id(), r.merchantId(), r.email(), r.role(), branchIds, r.note(), r.membershipId(),
                r.invitedByUserId(), r.effectiveStatus(now), r.expiresAt(), r.createdAt(), r.updatedAt());
    }

    private static String validToken(String token) {
        if (token == null || token.isBlank() || token.length() > 128) {
            throw invalid();
        }
        return token;
    }

    private static ApiException invalid() {
        return new ApiException(HttpStatus.BAD_REQUEST, "invalid_invitation", "This invitation is not valid, has expired or was already used.");
    }

    private static ApiException duplicate() {
        return new ApiException(HttpStatus.CONFLICT, "duplicate_invitation", "This person is already a member or has a pending invitation.");
    }

    private static String roleLabel(Role role) {
        return role.name().toLowerCase(java.util.Locale.ROOT);
    }
}
