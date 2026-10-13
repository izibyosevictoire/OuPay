package rw.oupay.auth;

import java.time.Clock;
import java.time.Instant;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.UUID;
import java.util.regex.Pattern;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import rw.oupay.audit.AuditService;
import rw.oupay.common.ApiException;
import rw.oupay.membership.MembershipRepository;
import rw.oupay.user.User;
import rw.oupay.user.UserRepository;
import rw.oupay.user.UserStatus;

@Service
public class AuthService {

    private static final Pattern PHONE = Pattern.compile("^\\+?[0-9]{9,15}$");

    private final UserRepository users;
    private final MembershipRepository memberships;
    private final PasswordService passwords;
    private final SessionService sessions;
    private final SecurityProperties properties;
    private final AuditService audit;
    private final Clock clock;

    public AuthService(UserRepository users, MembershipRepository memberships, PasswordService passwords,
                       SessionService sessions, SecurityProperties properties, AuditService audit, Clock clock) {
        this.users = users;
        this.memberships = memberships;
        this.passwords = passwords;
        this.sessions = sessions;
        this.properties = properties;
        this.audit = audit;
        this.clock = clock;
    }

    public record SignedIn(AuthDtos.SessionDto session, SessionService.IssuedSession issued) {}

    @Transactional
    public SignedIn register(AuthDtos.RegisterRequest request, String clientIp, String userAgent) {
        if (request.invitationToken() != null && !request.invitationToken().isBlank()) {
            // Invitation-based registration needs the email invitation flow, which is not built yet.
            throw ApiException.notImplemented("Registering from an invitation is not available yet.");
        }
        String email = normaliseEmail(request.email());
        String phone = request.phoneNumber() == null ? "" : request.phoneNumber().trim();
        if (!phone.isEmpty() && !PHONE.matcher(phone).matches()) {
            throw ApiException.validation("The phone number is not valid.");
        }
        passwords.validatePolicy(request.password(), email);
        if (users.findByEmailIgnoreCase(email).isPresent()) {
            throw new ApiException(HttpStatus.CONFLICT, "email_taken", "That email address is already registered.");
        }
        Instant now = clock.instant();
        User user = new User(UUID.randomUUID(), email, request.fullName().trim(), phone,
                passwords.hash(request.password()), UserStatus.ACTIVE, now);
        try {
            users.saveAndFlush(user);
        } catch (DataIntegrityViolationException race) {
            // Two registrations for the same email raced; the unique index decided.
            throw new ApiException(HttpStatus.CONFLICT, "email_taken", "That email address is already registered.");
        }
        audit.record(null, user.getId(), "USER_REGISTERED", "user", user.getId(), "A new account was registered.");
        var issued = sessions.issue(user, false, clientIp, userAgent);
        return new SignedIn(toSession(user, issued.session()), issued);
    }

    @Transactional(noRollbackFor = ApiException.class)
    public SignedIn login(AuthDtos.LoginRequest request, String clientIp, String userAgent) {
        String email = normaliseEmail(request.email());
        Instant now = clock.instant();
        Optional<User> found = users.findByEmailIgnoreCase(email);
        if (found.isEmpty()) {
            passwords.burnTime(request.password());
            throw invalidCredentials();
        }
        User user = found.get();
        if (user.isLocked(now)) {
            // Locked accounts answer the same way whether or not the password is right.
            passwords.burnTime(request.password());
            throw new ApiException(HttpStatus.FORBIDDEN, "account_unavailable",
                    "This account is temporarily locked. Try again later.");
        }
        if (!passwords.matches(request.password(), user.getPasswordHash())) {
            var login = properties.login();
            user.recordFailedLogin(login.maxFailedAttempts(), now.plus(login.lockoutDuration()), now);
            users.save(user);
            throw invalidCredentials();
        }
        if (user.getStatus() != UserStatus.ACTIVE) {
            throw new ApiException(HttpStatus.FORBIDDEN, "account_unavailable", "This account is not available.");
        }
        user.recordSuccessfulLogin(now);
        if (passwords.needsUpgrade(user.getPasswordHash())) {
            user.setPasswordHash(passwords.hash(request.password()), now);
        }
        users.save(user);
        var issued = sessions.issue(user, Boolean.TRUE.equals(request.rememberMe()), clientIp, userAgent);
        audit.record(null, user.getId(), "USER_SIGNED_IN", "user", user.getId(), "Signed in.");
        return new SignedIn(toSession(user, issued.session()), issued);
    }

    @Transactional
    public void logout(AuthenticatedUser principal) {
        sessions.revoke(principal.sessionId());
    }

    @Transactional(readOnly = true)
    public Optional<AuthDtos.SessionDto> currentSession() {
        return CurrentUser.find().flatMap(principal -> users.findById(principal.userId())
                .flatMap(user -> sessions.find(principal.sessionId()).map(s -> toSession(user, s))));
    }

    private AuthDtos.SessionDto toSession(User user, AuthSession session) {
        List<AuthDtos.MembershipDto> list = memberships.findByUserId(user.getId()).stream()
                .map(AuthDtos.MembershipDto::of)
                .toList();
        return new AuthDtos.SessionDto(AuthDtos.UserDto.of(user), list, session.effectiveExpiry());
    }

    private static ApiException invalidCredentials() {
        return new ApiException(HttpStatus.UNAUTHORIZED, "invalid_credentials", "The email or password is not correct.");
    }

    static String normaliseEmail(String email) {
        return email.trim().toLowerCase(Locale.ROOT);
    }
}
