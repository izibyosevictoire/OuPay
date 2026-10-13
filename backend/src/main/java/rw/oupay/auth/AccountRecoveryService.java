package rw.oupay.auth;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Optional;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import rw.oupay.audit.AuditService;
import rw.oupay.common.ApiException;
import rw.oupay.email.EmailOutboxService;
import rw.oupay.email.EmailTemplates;
import rw.oupay.user.User;
import rw.oupay.user.UserRepository;
import rw.oupay.user.UserStatus;

/**
 * Password reset, password change and e-mail verification.
 *
 * <p>Security properties:
 * <ul>
 *   <li><b>No account enumeration:</b> requesting a reset answers identically (and quickly) whether or not
 *       the address is registered; the only difference is whether a message is queued;</li>
 *   <li><b>Tokens</b> are single-use, expiring, unguessable and stored hashed ({@link AccountTokenService});</li>
 *   <li><b>Mail bombing is bounded:</b> at most {@code max-links-per-hour} links per account and purpose;</li>
 *   <li><b>A reset or change signs the account out</b> (everywhere for a reset, every other device for a
 *       change), lifts any lockout, and tells the owner by e-mail;</li>
 *   <li>A weak new password is rejected BEFORE the link is spent, so a typo does not burn it.</li>
 * </ul>
 */
@Service
public class AccountRecoveryService {

    private static final Logger log = LoggerFactory.getLogger(AccountRecoveryService.class);

    private final UserRepository users;
    private final AccountTokenService tokens;
    private final PasswordService passwords;
    private final SessionService sessions;
    private final EmailOutboxService outbox;
    private final EmailTemplates templates;
    private final SecurityProperties properties;
    private final AuditService audit;
    private final Clock clock;

    public AccountRecoveryService(UserRepository users, AccountTokenService tokens, PasswordService passwords,
                                  SessionService sessions, EmailOutboxService outbox, EmailTemplates templates,
                                  SecurityProperties properties, AuditService audit, Clock clock) {
        this.users = users;
        this.tokens = tokens;
        this.passwords = passwords;
        this.sessions = sessions;
        this.outbox = outbox;
        this.templates = templates;
        this.properties = properties;
        this.audit = audit;
        this.clock = clock;
    }

    // ---- password reset ------------------------------------------------------------------------

    /** Always returns normally. Whether anything was sent is invisible to the caller. */
    @Transactional
    public void requestPasswordReset(String email, String clientIp) {
        Optional<User> found = users.findByEmailIgnoreCase(AuthService.normaliseEmail(email));
        if (found.isEmpty()) {
            return;
        }
        User user = found.get();
        // Only a real, active account can recover a password: an invited placeholder has none, a suspended one is not allowed.
        if (user.getStatus() != UserStatus.ACTIVE || withinLinkBudget(user, AccountTokenService.Purpose.PASSWORD_RESET)) {
            return;
        }
        Duration ttl = properties.recovery().passwordResetTtl();
        String token = tokens.issue(user.getId(), AccountTokenService.Purpose.PASSWORD_RESET, user.getEmail(), ttl, clientIp);
        outbox.enqueue("PASSWORD_RESET", user.getEmail(), user.getId(), templates.passwordReset(user.getFullName(), token, ttl));
        audit.record(null, user.getId(), "PASSWORD_RESET_REQUESTED", "user", user.getId(), "A password reset link was requested.");
    }

    @Transactional(readOnly = true)
    public void verifyPasswordResetToken(String token) {
        requireValid(tokens.inspect(token, AccountTokenService.Purpose.PASSWORD_RESET));
    }

    @Transactional
    public void resetPassword(String token, String newPassword) {
        // Check the link first (without spending it), then the password, then spend: a typo never burns the link.
        requireValid(tokens.inspect(token, AccountTokenService.Purpose.PASSWORD_RESET));
        passwords.validatePolicy(newPassword, null);
        var consumed = tokens.consume(token, AccountTokenService.Purpose.PASSWORD_RESET)
                .orElseThrow(() -> new ApiException(HttpStatus.BAD_REQUEST, "invalid_token", "This link is not valid."));
        User user = users.findById(consumed.userId()).orElseThrow(() -> invalidToken());
        if (user.getStatus() != UserStatus.ACTIVE) {
            throw invalidToken();
        }
        passwords.validatePolicy(newPassword, user.getEmail());
        Instant now = clock.instant();
        user.setPasswordHash(passwords.hash(newPassword), now);
        user.clearLockout(now);
        // The link reached the mailbox, which proves control of the address it was sent to.
        if (consumed.email().equalsIgnoreCase(user.getEmail())) {
            user.markEmailVerified(now);
        }
        users.save(user);
        sessions.revokeAll(user.getId());
        outbox.enqueue("PASSWORD_CHANGED", user.getEmail(), user.getId(), templates.passwordChanged(user.getFullName()));
        audit.record(null, user.getId(), "PASSWORD_RESET_COMPLETED", "user", user.getId(), "Password reset; all sessions ended.");
    }

    // ---- password change (signed in) -----------------------------------------------------------

    @Transactional(noRollbackFor = ApiException.class)
    public void changePassword(AuthenticatedUser principal, String currentPassword, String newPassword) {
        User user = users.findById(principal.userId()).orElseThrow(ApiException::unauthenticated);
        Instant now = clock.instant();
        if (user.isLocked(now)) {
            throw new ApiException(HttpStatus.FORBIDDEN, "account_unavailable", "This account is temporarily locked. Try again later.");
        }
        if (!passwords.matches(currentPassword, user.getPasswordHash())) {
            var login = properties.login();
            user.recordFailedLogin(login.maxFailedAttempts(), now.plus(login.lockoutDuration()), now);
            users.save(user);
            // 422, not 401: the person IS signed in, so this must not look like an expired session.
            throw new ApiException(HttpStatus.UNPROCESSABLE_CONTENT, "invalid_credentials", "The current password is not correct.");
        }
        passwords.validatePolicy(newPassword, user.getEmail());
        if (currentPassword.equals(newPassword)) {
            throw ApiException.validation("Choose a password you have not used just now.");
        }
        user.recordSuccessfulLogin(now);
        user.setPasswordHash(passwords.hash(newPassword), now);
        users.save(user);
        sessions.revokeAllExcept(user.getId(), principal.sessionId());
        outbox.enqueue("PASSWORD_CHANGED", user.getEmail(), user.getId(), templates.passwordChanged(user.getFullName()));
        audit.record(null, user.getId(), "PASSWORD_CHANGED", "user", user.getId(), "Password changed; other sessions ended.");
    }

    // ---- e-mail verification -------------------------------------------------------------------

    /** Queues a verification link for an account that has not verified yet. Silent when it has, or over budget. */
    @Transactional
    public void sendEmailVerification(UUID userId, String clientIp) {
        User user = users.findById(userId).orElseThrow(ApiException::unauthenticated);
        queueVerification(user, clientIp);
    }

    /** Used by registration, inside its transaction. */
    @Transactional
    public void queueVerification(User user, String clientIp) {
        if (user.isEmailVerified() || user.getStatus() != UserStatus.ACTIVE
                || withinLinkBudget(user, AccountTokenService.Purpose.EMAIL_VERIFICATION)) {
            return;
        }
        Duration ttl = properties.recovery().emailVerificationTtl();
        String token = tokens.issue(user.getId(), AccountTokenService.Purpose.EMAIL_VERIFICATION, user.getEmail(), ttl, clientIp);
        outbox.enqueue("EMAIL_VERIFICATION", user.getEmail(), user.getId(), templates.emailVerification(user.getFullName(), token, ttl));
    }

    @Transactional
    public void confirmEmailVerification(String token) {
        requireValid(tokens.inspect(token, AccountTokenService.Purpose.EMAIL_VERIFICATION));
        var consumed = tokens.consume(token, AccountTokenService.Purpose.EMAIL_VERIFICATION).orElseThrow(AccountRecoveryService::invalidToken);
        User user = users.findById(consumed.userId()).orElseThrow(AccountRecoveryService::invalidToken);
        // Only the address the link was sent to can be verified: a changed address is not silently trusted.
        if (!consumed.email().equalsIgnoreCase(user.getEmail())) {
            throw invalidToken();
        }
        user.markEmailVerified(clock.instant());
        users.save(user);
        audit.record(null, user.getId(), "EMAIL_VERIFIED", "user", user.getId(), "Email address verified.");
    }

    // ---- helpers -------------------------------------------------------------------------------

    private boolean withinLinkBudget(User user, AccountTokenService.Purpose purpose) {
        long recent = tokens.issuedSince(user.getId(), purpose, clock.instant().minus(Duration.ofHours(1)));
        boolean exhausted = recent >= properties.recovery().maxLinksPerHour();
        if (exhausted) {
            log.warn("link budget exhausted purpose={} user={}", purpose, user.getId());
        }
        return exhausted;
    }

    private static void requireValid(AccountTokenService.State state) {
        switch (state) {
            case VALID -> { }
            case EXPIRED -> throw new ApiException(HttpStatus.BAD_REQUEST, "expired_token", "This link has expired. Request a new one.");
            case INVALID -> throw invalidToken();
        }
    }

    private static ApiException invalidToken() {
        return new ApiException(HttpStatus.BAD_REQUEST, "invalid_token", "This link is not valid or was already used.");
    }
}
