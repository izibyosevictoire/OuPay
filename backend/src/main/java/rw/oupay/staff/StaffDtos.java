package rw.oupay.staff;

import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import rw.oupay.membership.MembershipStatus;
import rw.oupay.membership.Role;

public final class StaffDtos {

    private StaffDtos() {}

    public record RoleRequest(@NotNull Role role) {}

    public record InviteRequest(@NotBlank @Email @Size(max = 254) String email, @NotNull Role role,
                                @Size(max = 50) List<UUID> branchIds, @Size(max = 300) String note) {}

    /** What the inviter sees. The link token is never part of it: it only ever travels by e-mail. */
    public record InvitationDto(UUID id, UUID merchantId, String email, Role role, List<UUID> branchIds, String note, UUID membershipId,
                                UUID invitedByUserId, String status, Instant expiresAt, Instant createdAt, Instant updatedAt) {}

    public record PendingInvitationDto(UUID id, String note, Instant createdAt, Instant expiresAt) {}

    public record StaffMemberDto(UUID merchantId, UUID membershipId, UUID userId, String fullName, String email,
                                 String phoneNumber, Role role, MembershipStatus status, List<UUID> branchIds,
                                 Instant joinedAt, PendingInvitationDto pendingInvitation) {}

    /** What the holder of a link may see before signing in. Deliberately minimal. */
    public record InvitationPreviewDto(String email, Role role, String businessName, String status, boolean inviteeHasActiveAccount) {}
}
