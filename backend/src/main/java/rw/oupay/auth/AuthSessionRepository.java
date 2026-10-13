package rw.oupay.auth;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;

public interface AuthSessionRepository extends JpaRepository<AuthSession, UUID> {

    @Query("select s from AuthSession s where s.tokenHash = :hash")
    Optional<AuthSession> findByTokenHash(byte[] hash);

    List<AuthSession> findByUserIdAndRevokedAtIsNull(UUID userId);

    /** Housekeeping: dead sessions carry no value. */
    @Modifying
    @Query("delete from AuthSession s where s.absoluteExpiresAt < :cutoff or s.revokedAt < :cutoff")
    int deleteDeadBefore(Instant cutoff);
}
