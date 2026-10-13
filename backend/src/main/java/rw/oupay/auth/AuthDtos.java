package rw.oupay.auth;

import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import rw.oupay.membership.Membership;
import rw.oupay.membership.MembershipStatus;
import rw.oupay.membership.Role;
import rw.oupay.user.User;
import rw.oupay.user.UserStatus;

/** Wire shapes. They match the frontend's AuthSession, User and BusinessMembership types. */
public final class AuthDtos {

    private AuthDtos() {}

    public record RegisterRequest(
            @NotBlank @Size(max = 120) String fullName,
            @NotBlank @Email @Size(max = 254) String email,
            @Size(max = 20) String phoneNumber,
            @NotBlank @Size(max = 128) String password,
            String invitationToken) {}

    public record LoginRequest(
            @NotBlank @Size(max = 254) String email,
            @NotBlank @Size(max = 128) String password,
            Boolean rememberMe) {}

    public record UserDto(UUID id, String fullName, String email, String phoneNumber, UserStatus status,
                          Instant createdAt, Instant updatedAt) {
        static UserDto of(User u) {
            return new UserDto(u.getId(), u.getFullName(), u.getEmail(), u.getPhoneNumber(), u.getStatus(),
                    u.getCreatedAt(), u.getUpdatedAt());
        }
    }

    public record MembershipDto(UUID id, UUID userId, UUID merchantId, Role role, MembershipStatus status,
                                Instant createdAt, Instant updatedAt) {
        public static MembershipDto of(Membership m) {
            return new MembershipDto(m.getId(), m.getUserId(), m.getMerchantId(), m.getRole(), m.getStatus(),
                    m.getCreatedAt(), m.getUpdatedAt());
        }
    }

    /** Contains no credentials or tokens: the session itself lives in an HttpOnly cookie. */
    public record SessionDto(UserDto user, List<MembershipDto> memberships, Instant expiresAt) {}
}
