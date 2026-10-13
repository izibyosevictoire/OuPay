package rw.oupay.auth;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.Instant;
import java.util.UUID;

/** A server-side session. Only the SHA-256 of the cookie value is stored. */
@Entity
@Table(name = "auth_sessions")
public class AuthSession {

    @Id
    private UUID id;

    @Column(name = "user_id", nullable = false)
    private UUID userId;

    @Column(name = "token_hash", nullable = false, updatable = false)
    private byte[] tokenHash;

    @Column(name = "remember_me", nullable = false)
    private boolean rememberMe;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    @Column(name = "last_seen_at", nullable = false)
    private Instant lastSeenAt;

    @Column(name = "idle_expires_at", nullable = false)
    private Instant idleExpiresAt;

    @Column(name = "absolute_expires_at", nullable = false)
    private Instant absoluteExpiresAt;

    @Column(name = "revoked_at")
    private Instant revokedAt;

    @Column(name = "client_ip")
    private String clientIp;

    @Column(name = "user_agent")
    private String userAgent;

    protected AuthSession() {}

    public AuthSession(UUID id, UUID userId, byte[] tokenHash, boolean rememberMe, Instant now,
                       Instant idleExpiresAt, Instant absoluteExpiresAt, String clientIp, String userAgent) {
        this.id = id;
        this.userId = userId;
        this.tokenHash = tokenHash;
        this.rememberMe = rememberMe;
        this.createdAt = now;
        this.lastSeenAt = now;
        this.idleExpiresAt = idleExpiresAt;
        this.absoluteExpiresAt = absoluteExpiresAt;
        this.clientIp = clientIp;
        this.userAgent = userAgent;
    }

    public UUID getId() { return id; }
    public UUID getUserId() { return userId; }
    public boolean isRememberMe() { return rememberMe; }
    public Instant getLastSeenAt() { return lastSeenAt; }
    public Instant getIdleExpiresAt() { return idleExpiresAt; }
    public Instant getAbsoluteExpiresAt() { return absoluteExpiresAt; }
    public Instant getRevokedAt() { return revokedAt; }

    public boolean isUsable(Instant now) {
        return revokedAt == null && idleExpiresAt.isAfter(now) && absoluteExpiresAt.isAfter(now);
    }

    public void touch(Instant now, Instant newIdleExpiry) {
        this.lastSeenAt = now;
        this.idleExpiresAt = newIdleExpiry.isAfter(absoluteExpiresAt) ? absoluteExpiresAt : newIdleExpiry;
    }

    public void revoke(Instant now) {
        if (revokedAt == null) {
            this.revokedAt = now;
        }
    }

    /** The earlier of the idle and absolute limits: when this session will stop working. */
    public Instant effectiveExpiry() {
        return idleExpiresAt.isBefore(absoluteExpiresAt) ? idleExpiresAt : absoluteExpiresAt;
    }
}
