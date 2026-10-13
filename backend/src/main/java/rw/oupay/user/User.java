package rw.oupay.user;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import jakarta.persistence.Version;
import java.time.Instant;
import java.util.UUID;

/**
 * A person with an OuPay login. Deliberately has no role: roles belong to a membership, because
 * one user can hold different roles in different businesses.
 */
@Entity
@Table(name = "users")
public class User {

    @Id
    private UUID id;

    @Column(nullable = false)
    private String email;

    @Column(name = "full_name", nullable = false)
    private String fullName;

    @Column(name = "phone_number", nullable = false)
    private String phoneNumber = "";

    @Column(name = "password_hash")
    private String passwordHash;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    private UserStatus status;

    @Column(name = "failed_login_attempts", nullable = false)
    private int failedLoginAttempts;

    @Column(name = "locked_until")
    private Instant lockedUntil;

    @Column(name = "password_changed_at")
    private Instant passwordChangedAt;

    @Column(name = "email_verified_at")
    private Instant emailVerifiedAt;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    @Version
    private long version;

    protected User() {}

    public User(UUID id, String email, String fullName, String phoneNumber, String passwordHash, UserStatus status, Instant now) {
        this.id = id;
        this.email = email;
        this.fullName = fullName;
        this.phoneNumber = phoneNumber;
        this.passwordHash = passwordHash;
        this.status = status;
        this.createdAt = now;
        this.updatedAt = now;
        this.passwordChangedAt = passwordHash == null ? null : now;
    }

    public UUID getId() { return id; }
    public String getEmail() { return email; }
    public String getFullName() { return fullName; }
    public String getPhoneNumber() { return phoneNumber; }
    public String getPasswordHash() { return passwordHash; }
    public UserStatus getStatus() { return status; }
    public int getFailedLoginAttempts() { return failedLoginAttempts; }
    public Instant getLockedUntil() { return lockedUntil; }
    public Instant getEmailVerifiedAt() { return emailVerifiedAt; }
    public boolean isEmailVerified() { return emailVerifiedAt != null; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }
    public long getVersion() { return version; }

    public void setPasswordHash(String hash, Instant now) {
        this.passwordHash = hash;
        this.passwordChangedAt = now;
        this.updatedAt = now;
    }

    public void markEmailVerified(Instant now) {
        if (this.emailVerifiedAt == null) {
            this.emailVerifiedAt = now;
            this.updatedAt = now;
        }
    }

    /** A password reset also lifts a lockout: the owner of the mailbox has proven who they are. */
    public void clearLockout(Instant now) {
        this.failedLoginAttempts = 0;
        this.lockedUntil = null;
        this.updatedAt = now;
    }

    /** Turns the placeholder created for an invitation into a real account (the invitation link proved the mailbox). */
    public void activateFromInvitation(String fullName, String phoneNumber, String passwordHash, Instant now) {
        this.fullName = fullName;
        this.phoneNumber = phoneNumber;
        this.passwordHash = passwordHash;
        this.passwordChangedAt = now;
        this.status = UserStatus.ACTIVE;
        this.emailVerifiedAt = now;
        this.updatedAt = now;
    }

    public void setStatus(UserStatus status, Instant now) {
        this.status = status;
        this.updatedAt = now;
    }

    public void recordFailedLogin(int lockoutThreshold, Instant lockUntil, Instant now) {
        this.failedLoginAttempts++;
        if (this.failedLoginAttempts >= lockoutThreshold) {
            this.lockedUntil = lockUntil;
            this.failedLoginAttempts = 0;
        }
        this.updatedAt = now;
    }

    public void recordSuccessfulLogin(Instant now) {
        this.failedLoginAttempts = 0;
        this.lockedUntil = null;
        this.updatedAt = now;
    }

    public boolean isLocked(Instant now) {
        return lockedUntil != null && lockedUntil.isAfter(now);
    }
}
