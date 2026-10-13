package rw.oupay.staff;

import jakarta.validation.constraints.NotNull;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import rw.oupay.membership.MembershipStatus;
import rw.oupay.membership.Role;

public final class StaffDtos {

    private StaffDtos() {}

    public record RoleRequest(@NotNull Role role) {}

    public record StaffMemberDto(UUID merchantId, UUID membershipId, UUID userId, String fullName, String email,
                                 String phoneNumber, Role role, MembershipStatus status, List<UUID> branchIds,
                                 Instant joinedAt) {}
}
