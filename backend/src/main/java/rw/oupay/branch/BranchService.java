package rw.oupay.branch;

import java.time.Clock;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.function.Function;
import java.util.stream.Collectors;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import rw.oupay.audit.AuditService;
import rw.oupay.common.ApiException;
import rw.oupay.membership.Actor;
import rw.oupay.membership.Membership;
import rw.oupay.membership.MembershipRepository;
import rw.oupay.membership.MembershipStatus;
import rw.oupay.membership.MerchantAccess;
import rw.oupay.membership.Permission;
import rw.oupay.membership.StaffPolicy;
import rw.oupay.user.UserRepository;

@Service
public class BranchService {

    private final BranchRepository branches;
    private final BranchAssignmentRepository assignments;
    private final MembershipRepository memberships;
    private final UserRepository users;
    private final MerchantAccess access;
    private final AuditService audit;
    private final Clock clock;

    public BranchService(BranchRepository branches, BranchAssignmentRepository assignments, MembershipRepository memberships,
                         UserRepository users, MerchantAccess access, AuditService audit, Clock clock) {
        this.branches = branches;
        this.assignments = assignments;
        this.memberships = memberships;
        this.users = users;
        this.access = access;
        this.audit = audit;
        this.clock = clock;
    }

    @Transactional(readOnly = true)
    public List<BranchDtos.BranchSummaryDto> list(UUID merchantId) {
        access.require(merchantId, Permission.BRANCHES_MANAGE);
        Map<UUID, Membership> staff = memberships.findByMerchantId(merchantId).stream()
                .collect(Collectors.toMap(Membership::getId, Function.identity()));
        List<BranchAssignment> active = assignments.findByMerchantIdAndStatus(merchantId, "ACTIVE");
        return branches.findByMerchantIdOrderByNameAsc(merchantId).stream()
                .map(b -> {
                    int count = (int) active.stream()
                            .filter(a -> a.getBranchId().equals(b.getId()) && isCountedStaff(staff.get(a.getMembershipId())))
                            .count();
                    return new BranchDtos.BranchSummaryDto(b.getId(), b.getMerchantId(), b.getName(), b.getCode(), location(b),
                            b.getContactPhone(), b.getStatus(), b.getCreatedAt(), b.getUpdatedAt(), count);
                })
                .toList();
    }

    @Transactional(readOnly = true)
    public BranchDtos.BranchDetailsDto get(UUID merchantId, UUID branchId) {
        access.require(merchantId, Permission.BRANCHES_MANAGE);
        Branch branch = find(merchantId, branchId);
        Map<UUID, Membership> staff = memberships.findByMerchantId(merchantId).stream()
                .collect(Collectors.toMap(Membership::getId, Function.identity()));
        var members = assignments.findByBranchIdAndStatus(branchId, "ACTIVE").stream()
                .filter(a -> isCountedStaff(staff.get(a.getMembershipId())))
                .map(a -> {
                    Membership m = staff.get(a.getMembershipId());
                    String name = users.findById(m.getUserId()).map(u -> u.getFullName()).orElse("Unknown");
                    return new BranchDtos.BranchStaffMemberDto(m.getId(), name, m.getRole(), m.getStatus(), a.getCreatedAt());
                })
                .toList();
        return new BranchDtos.BranchDetailsDto(toDto(branch), members);
    }

    @Transactional
    public BranchDtos.BranchDto create(UUID merchantId, BranchDtos.CreateRequest request) {
        Actor actor = access.require(merchantId, Permission.BRANCHES_MANAGE);
        String code = request.code().trim().toUpperCase(Locale.ROOT);
        if (branches.existsByMerchantIdAndCode(merchantId, code)) {
            throw duplicateCode();
        }
        var l = request.location();
        Branch branch = new Branch(UUID.randomUUID(), merchantId, request.name().trim(), code, l.province(), l.district(),
                l.sector(), l.physicalAddress().trim(), blankToNull(request.contactPhone()),
                request.status() == null ? "ACTIVE" : request.status(), clock.instant());
        branches.saveAndFlush(branch);
        audit.record(merchantId, actor.userId(), "BRANCH_CREATED", "branch", branch.getId(), "Branch " + code + " created.");
        return toDto(branch);
    }

    @Transactional
    public BranchDtos.BranchDto update(UUID merchantId, UUID branchId, BranchDtos.UpdateRequest request) {
        Actor actor = access.require(merchantId, Permission.BRANCHES_MANAGE);
        Branch branch = find(merchantId, branchId);
        String code = request.code().trim().toUpperCase(Locale.ROOT);
        if (branches.existsByMerchantIdAndCodeAndIdNot(merchantId, code, branchId)) {
            throw duplicateCode();
        }
        var l = request.location();
        branch.update(request.name().trim(), code, l.province(), l.district(), l.sector(), l.physicalAddress().trim(),
                blankToNull(request.contactPhone()), clock.instant());
        audit.record(merchantId, actor.userId(), "BRANCH_UPDATED", "branch", branchId, "Branch " + code + " updated.");
        return toDto(branch);
    }

    /** History is untouched: assignments and invoices keep pointing at this branch. */
    @Transactional
    public BranchDtos.BranchDto changeStatus(UUID merchantId, UUID branchId, String status) {
        Actor actor = access.require(merchantId, Permission.BRANCHES_MANAGE);
        Branch branch = find(merchantId, branchId);
        branch.changeStatus(status, clock.instant());
        audit.record(merchantId, actor.userId(), "BRANCH_STATUS_CHANGED", "branch", branchId, "Branch set to " + status + ".");
        return toDto(branch);
    }

    @Transactional(readOnly = true)
    public List<BranchDtos.AssignmentDto> listAssignments(UUID merchantId, UUID membershipId, UUID branchId) {
        access.require(merchantId, Permission.CASHIERS_MANAGE);
        return assignments.findByMerchantId(merchantId).stream()
                .filter(a -> (membershipId == null || a.getMembershipId().equals(membershipId))
                        && (branchId == null || a.getBranchId().equals(branchId)))
                .map(BranchService::toDto)
                .toList();
    }

    /** Replaces a member's set of ACTIVE assignments. Only ACTIVE branches can be newly assigned. */
    @Transactional
    public List<BranchDtos.AssignmentDto> updateAssignments(UUID merchantId, UUID membershipId, List<UUID> branchIds) {
        Actor actor = access.require(merchantId, Permission.CASHIERS_MANAGE);
        Membership target = memberships.findByIdAndMerchantId(membershipId, merchantId)
                .orElseThrow(() -> ApiException.notFound("This staff member could not be found."));
        if (!StaffPolicy.canPerform(actor, StaffPolicy.Action.ASSIGN_BRANCHES, target.getRole())) {
            throw ApiException.forbidden("You cannot change this person's branches.");
        }
        if (target.getStatus() != MembershipStatus.ACTIVE) {
            throw new ApiException(HttpStatus.CONFLICT, "membership_not_active", "Only active staff can be assigned to branches.");
        }
        if (new HashSet<>(branchIds).size() != branchIds.size()) {
            throw new ApiException(HttpStatus.CONFLICT, "duplicate_assignment", "A branch was selected more than once.");
        }
        List<BranchAssignment> current = assignments.findByMembershipIdAndStatus(membershipId, "ACTIVE");
        Set<UUID> currentlyAssigned = current.stream().map(BranchAssignment::getBranchId).collect(Collectors.toSet());
        for (UUID branchId : branchIds) {
            Branch branch = find(merchantId, branchId); // a branch of another business is "not found"
            if (!currentlyAssigned.contains(branchId) && !branch.isActive()) {
                throw new ApiException(HttpStatus.CONFLICT, "branch_inactive",
                        branch.getName() + " is inactive and cannot receive new assignments.");
            }
        }
        var now = clock.instant();
        Set<UUID> wanted = new HashSet<>(branchIds);
        current.stream().filter(a -> !wanted.contains(a.getBranchId())).forEach(a -> a.end(now));
        for (UUID branchId : branchIds) {
            if (!currentlyAssigned.contains(branchId)) {
                assignments.save(new BranchAssignment(UUID.randomUUID(), merchantId, membershipId, branchId, now));
            }
        }
        audit.record(merchantId, actor.userId(), "BRANCH_ASSIGNMENTS_CHANGED", "membership", membershipId, "Branch assignments updated.");
        return assignments.findByMembershipIdAndStatus(membershipId, "ACTIVE").stream().map(BranchService::toDto).toList();
    }

    private Branch find(UUID merchantId, UUID branchId) {
        return branches.findByIdAndMerchantId(branchId, merchantId)
                .orElseThrow(() -> ApiException.notFound("This branch could not be found."));
    }

    private static boolean isCountedStaff(Membership m) {
        return m != null && (m.getStatus() == MembershipStatus.ACTIVE || m.getStatus() == MembershipStatus.SUSPENDED);
    }

    private static ApiException duplicateCode() {
        return new ApiException(HttpStatus.CONFLICT, "duplicate_branch_code", "Another branch in this business already uses this code.");
    }

    private static BranchDtos.Location location(Branch b) {
        return new BranchDtos.Location(b.getProvince(), b.getDistrict(), b.getSector(), b.getPhysicalAddress());
    }

    static BranchDtos.BranchDto toDto(Branch b) {
        return new BranchDtos.BranchDto(b.getId(), b.getMerchantId(), b.getName(), b.getCode(), location(b), b.getContactPhone(),
                b.getStatus(), b.getCreatedAt(), b.getUpdatedAt());
    }

    static BranchDtos.AssignmentDto toDto(BranchAssignment a) {
        return new BranchDtos.AssignmentDto(a.getId(), a.getMerchantId(), a.getMembershipId(), a.getBranchId(), a.getStatus(),
                a.getCreatedAt(), a.getUpdatedAt(), a.getEndedAt());
    }

    private static String blankToNull(String value) {
        return value == null || value.isBlank() ? null : value.trim();
    }
}
