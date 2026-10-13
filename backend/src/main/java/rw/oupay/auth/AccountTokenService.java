package rw.oupay.auth;

import java.sql.Timestamp;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import rw.oupay.common.SecureTokens;
import rw.oupay.common.TokenHashing;

/**
 * Single-use, expiring, unguessable tokens for password reset and e-mail verification.
 *
 * <ul>
 *   <li>256 random bits; only the SHA-256 hash is stored, so a database leak cannot be replayed;</li>
 *   <li>issuing a new token retires every earlier unused one of the same kind for that account;</li>
 *   <li>{@link #consume} is one atomic UPDATE, so two simultaneous uses of one link cannot both succeed.</li>
 * </ul>
 */
@Service
public class AccountTokenService {

    public enum Purpose { PASSWORD_RESET, EMAIL_VERIFICATION }

    public enum State { VALID, EXPIRED, INVALID }

    public record Consumed(UUID userId, String email) {}

    private final JdbcClient jdbc;
    private final Clock clock;

    public AccountTokenService(JdbcClient jdbc, Clock clock) {
        this.jdbc = jdbc;
        this.clock = clock;
    }

    /** How many links were issued to this account for this purpose since the given instant. */
    @Transactional(readOnly = true)
    public long issuedSince(UUID userId, Purpose purpose, Instant since) {
        return jdbc.sql("select count(*) from account_tokens where user_id = :u and purpose = :p and created_at >= :since")
                .param("u", userId).param("p", purpose.name()).param("since", Timestamp.from(since))
                .query(Long.class).single();
    }

    /** Returns the raw token. It must only ever be put in the e-mail that goes to {@code email}. */
    @Transactional
    public String issue(UUID userId, Purpose purpose, String email, Duration ttl, String requestedIp) {
        Instant now = clock.instant();
        jdbc.sql("update account_tokens set used_at = :now where user_id = :u and purpose = :p and used_at is null")
                .param("now", Timestamp.from(now)).param("u", userId).param("p", purpose.name()).update();
        String raw = SecureTokens.sessionToken();
        jdbc.sql("insert into account_tokens (id, user_id, purpose, token_hash, email, requested_ip, created_at, expires_at) "
                        + "values (:id, :u, :p, :h, :e, :ip, :now, :exp)")
                .param("id", UUID.randomUUID()).param("u", userId).param("p", purpose.name()).param("h", TokenHashing.sha256(raw))
                .param("e", email).param("ip", requestedIp == null ? null : requestedIp.substring(0, Math.min(64, requestedIp.length())))
                .param("now", Timestamp.from(now)).param("exp", Timestamp.from(now.plus(ttl)))
                .update();
        return raw;
    }

    @Transactional(readOnly = true)
    public State inspect(String raw, Purpose purpose) {
        if (raw == null || raw.isBlank() || raw.length() > 128) {
            return State.INVALID;
        }
        var row = jdbc.sql("select expires_at, used_at from account_tokens where token_hash = :h and purpose = :p")
                .param("h", TokenHashing.sha256(raw)).param("p", purpose.name())
                .query((rs, n) -> new Object[] {rs.getTimestamp("expires_at").toInstant(), rs.getTimestamp("used_at")})
                .optional();
        if (row.isEmpty() || row.get()[1] != null) {
            return State.INVALID;
        }
        return ((Instant) row.get()[0]).isAfter(clock.instant()) ? State.VALID : State.EXPIRED;
    }

    /** Uses the token exactly once. Empty when it is unknown, already used or expired. */
    @Transactional
    public Optional<Consumed> consume(String raw, Purpose purpose) {
        if (raw == null || raw.isBlank() || raw.length() > 128) {
            return Optional.empty();
        }
        Timestamp now = Timestamp.from(clock.instant());
        return jdbc.sql("update account_tokens set used_at = :now where token_hash = :h and purpose = :p and used_at is null "
                        + "and expires_at > :now returning user_id, email")
                .param("now", now).param("h", TokenHashing.sha256(raw)).param("p", purpose.name())
                .query((rs, n) -> new Consumed(rs.getObject("user_id", UUID.class), rs.getString("email")))
                .optional();
    }
}
