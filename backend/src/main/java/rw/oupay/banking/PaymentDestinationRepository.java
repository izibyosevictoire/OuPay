package rw.oupay.banking;

import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;

public interface PaymentDestinationRepository extends JpaRepository<PaymentDestination, UUID> {

    List<PaymentDestination> findByMerchantIdOrderByCreatedAtAsc(UUID merchantId);

    Optional<PaymentDestination> findByIdAndMerchantId(UUID id, UUID merchantId);
}
