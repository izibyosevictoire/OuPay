package rw.oupay.audit;

import java.util.List;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;

public interface AuditLogRepository extends JpaRepository<AuditLog, Long> {

    List<AuditLog> findByMerchantIdOrderByIdDesc(UUID merchantId, org.springframework.data.domain.Pageable pageable);

    List<AuditLog> findByMerchantIdAndIdLessThanOrderByIdDesc(UUID merchantId, long beforeId, org.springframework.data.domain.Pageable pageable);

    List<AuditLog> findByMerchantIdAndBankTransactionIdOrderByIdAsc(UUID merchantId, UUID bankTransactionId);
}
