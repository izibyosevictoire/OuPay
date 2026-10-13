package rw.oupay.membership;

import jakarta.persistence.LockModeType;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;

public interface MembershipRepository extends JpaRepository<Membership, UUID> {

    List<Membership> findByUserId(UUID userId);

    List<Membership> findByMerchantId(UUID merchantId);

    Optional<Membership> findByUserIdAndMerchantId(UUID userId, UUID merchantId);

    Optional<Membership> findByIdAndMerchantId(UUID id, UUID merchantId);

    /** Serialises membership changes inside a business (last-owner protection). */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select m from Membership m where m.merchantId = :merchantId")
    List<Membership> lockAllOfMerchant(UUID merchantId);
}
