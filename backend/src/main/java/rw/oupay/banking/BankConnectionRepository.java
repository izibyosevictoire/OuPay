package rw.oupay.banking;

import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;

public interface BankConnectionRepository extends JpaRepository<BankConnection, UUID> {

    List<BankConnection> findByMerchantIdOrderByCreatedAtAsc(UUID merchantId);

    Optional<BankConnection> findByIdAndMerchantId(UUID id, UUID merchantId);

    boolean existsByMerchantIdAndProviderIdAndStatusIn(UUID merchantId, ProviderId providerId, List<BankConnection.Status> statuses);

    Optional<BankConnection> findByProviderIdAndProviderAccountIdAndStatus(ProviderId providerId, String providerAccountId,
                                                                          BankConnection.Status status);
}
