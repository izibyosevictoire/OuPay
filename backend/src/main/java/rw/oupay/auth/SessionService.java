package rw.oupay.auth;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Optional;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import rw.oupay.common.SecureTokens;
import rw.oupay.user.User;
import rw.oupay.user.UserRepository;
import rw.oupay.user.UserStatus;

/**
 * Opaque, server-side sessions: a random 256-bit value in an HttpOnly cookie, stored hashed.
 * Sessions have an idle timeout (sliding) and an absolute limit, and can be revoked at any time
 * (logout, password change, suspension). Nothing long-lived is ever handed to JavaScript.
 */
@Service
public class SessionService {

    /** Avoid a database write on every request: slide the idle window at most this often. */
    private static final Duration TOUCH_INTERVAL = Duration.ofSeconds(60);

    private final AuthSessionRepository sessions;
    private final UserRepository users;
    private final SecurityProperties properties;
    private final Clock clock;

    public SessionService(AuthSessionRepository sessions, UserRepository users, SecurityProperties properties, Clock clock) {
        this.sessions = sessions;
        this.users = users;
        this.properties = properties;
        this.clock = clock;
    }

    public record IssuedSession(String rawToken, AuthSession session) {}

    @Transactional
    public IssuedSession issue(User user, boolean rememberMe, String clientIp, String userAgent) {
        Instant now = clock.instant();
        var cfg = properties.session();
        Duration idle = rememberMe ? cfg.rememberIdleTimeout() : cfg.idleTimeout();
        Duration absolute = rememberMe ? cfg.rememberAbsoluteTimeout() : cfg.absoluteTimeout();
        String raw = SecureTokens.sessionToken();
        AuthSession session = new AuthSession(UUID.randomUUID(), user.getId(), hash(raw), rememberMe, now,
                now.plus(idle), now.plus(absolute), truncate(clientIp, 64), truncate(userAgent, 200));
        sessions.save(session);
        return new IssuedSession(raw, session);
    }

    /** Resolves a cookie value to a signed-in user, or empty if it is unknown, expired or revoked. */
    @Transactional
    public Optional<AuthenticatedUser> authenticate(String rawToken) {
        if (rawToken == null || rawToken.isBlank() || rawToken.length() > 128) {
            return Optional.empty();
        }
        Instant now = clock.instant();
        return sessions.findByTokenHash(hash(rawToken))
                .filter(s -> s.isUsable(now))
                .flatMap(s -> users.findById(s.getUserId())
                        .filter(u -> u.getStatus() == UserStatus.ACTIVE)
                        .map(u -> {
                            if (Duration.between(s.getLastSeenAt(), now).compareTo(TOUCH_INTERVAL) > 0) {
                                var cfg = properties.session();
                                s.touch(now, now.plus(s.isRememberMe() ? cfg.rememberIdleTimeout() : cfg.idleTimeout()));
                            }
                            return new AuthenticatedUser(u.getId(), s.getId());
                        }));
    }

    public Optional<AuthSession> find(UUID sessionId) {
        return sessions.findById(sessionId);
    }

    @Transactional
    public void revoke(UUID sessionId) {
        sessions.findById(sessionId).ifPresent(s -> s.revoke(clock.instant()));
    }

    /** Signs a user out everywhere: used after a password change or when access is withdrawn. */
    @Transactional
    public void revokeAll(UUID userId) {
        Instant now = clock.instant();
        sessions.findByUserIdAndRevokedAtIsNull(userId).forEach(s -> s.revoke(now));
    }

    static byte[] hash(String raw) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(raw.getBytes(StandardCharsets.UTF_8));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    private static String truncate(String value, int max) {
        if (value == null) {
            return null;
        }
        return value.length() <= max ? value : value.substring(0, max);
    }
}
