package rw.oupay.branch;

import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;

public interface BranchRepository extends JpaRepository<Branch, UUID> {

    List<Branch> findByMerchantIdOrderByNameAsc(UUID merchantId);

    Optional<Branch> findByIdAndMerchantId(UUID id, UUID merchantId);

    boolean existsByMerchantIdAndCode(UUID merchantId, String code);

    boolean existsByMerchantIdAndCodeAndIdNot(UUID merchantId, String code, UUID id);
}
