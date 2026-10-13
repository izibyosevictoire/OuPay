package rw.oupay.payment;

import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;

public interface PaymentProfileRepository extends JpaRepository<PaymentProfile, UUID> {

    Optional<PaymentProfile> findByPublicToken(String publicToken);

    Optional<PaymentProfile> findByIdAndMerchantId(UUID id, UUID merchantId);

    List<PaymentProfile> findByMerchantIdOrderByCreatedAtDesc(UUID merchantId);

    boolean existsByPublicToken(String publicToken);
}
