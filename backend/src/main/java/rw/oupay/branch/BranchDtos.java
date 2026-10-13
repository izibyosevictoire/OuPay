package rw.oupay.branch;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import rw.oupay.membership.MembershipStatus;
import rw.oupay.membership.Role;

/** Wire shapes matching the frontend's Branch, BranchSummary, BranchDetails and BranchAssignment. */
public final class BranchDtos {

    private BranchDtos() {}

    public record Location(
            @NotBlank @Size(max = 60) String province,
            @NotBlank @Size(max = 60) String district,
            @NotBlank @Size(max = 60) String sector,
            @NotBlank @Size(max = 300) String physicalAddress) {}

    public record CreateRequest(
            @NotBlank @Size(min = 2, max = 120) String name,
            @NotBlank @Pattern(regexp = "^[A-Za-z0-9]{2,12}$", message = "The code must be 2 to 12 letters or digits.") String code,
            @NotNull @Valid Location location,
            @Pattern(regexp = "^\\+?[0-9]{9,15}$", message = "The phone number is not valid.") String contactPhone,
            @Pattern(regexp = "ACTIVE|INACTIVE") String status) {}

    public record UpdateRequest(
            @NotBlank @Size(min = 2, max = 120) String name,
            @NotBlank @Pattern(regexp = "^[A-Za-z0-9]{2,12}$", message = "The code must be 2 to 12 letters or digits.") String code,
            @NotNull @Valid Location location,
            @Pattern(regexp = "^\\+?[0-9]{9,15}$", message = "The phone number is not valid.") String contactPhone) {}

    public record StatusRequest(@NotNull @Pattern(regexp = "ACTIVE|INACTIVE") String status) {}

    public record AssignmentsRequest(@NotNull List<UUID> branchIds) {}

    public record BranchDto(UUID id, UUID merchantId, String name, String code, Location location, String contactPhone,
                            String status, Instant createdAt, Instant updatedAt) {}

    public record BranchSummaryDto(UUID id, UUID merchantId, String name, String code, Location location, String contactPhone,
                                   String status, Instant createdAt, Instant updatedAt, int assignedStaffCount) {}

    public record BranchStaffMemberDto(UUID membershipId, String fullName, Role role, MembershipStatus membershipStatus,
                                       Instant assignedAt) {}

    public record BranchDetailsDto(BranchDto branch, List<BranchStaffMemberDto> assignedStaff) {}

    public record AssignmentDto(UUID id, UUID merchantId, UUID membershipId, UUID branchId, String status,
                                Instant createdAt, Instant updatedAt, Instant endedAt) {}
}
