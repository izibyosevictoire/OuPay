package rw.oupay.collection;

import jakarta.persistence.LockModeType;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import rw.oupay.banking.ProviderId;

public interface CollectionCodeRepository extends JpaRepository<CollectionCode, UUID> {

    Optional<CollectionCode> findByIdAndMerchantId(UUID id, UUID merchantId);

    /** Serialises every change to one code (lifecycle, assignment, reassignment), so a stale view is a clean conflict. */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select c from CollectionCode c where c.id = :id and c.merchantId = :merchantId")
    Optional<CollectionCode> lockByIdAndMerchantId(UUID id, UUID merchantId);

    Optional<CollectionCode> findByMerchantIdAndClientRequestId(UUID merchantId, UUID clientRequestId);

    boolean existsByInternalRef(String internalRef);

    boolean existsByProviderIdAndExternalCodeIgnoreCase(ProviderId providerId, String externalCode);

    /** Keyset page, newest first, total order (created_at, id). Filters take plain values with an "any" switch (never a null parameter). */
    @Query("select c from CollectionCode c where c.merchantId = :merchantId"
            + " and (c.createdAt < :at or (c.createdAt = :at and c.id < :id))"
            + " and (:anyStatus = true or c.status = :status)"
            + " and (:anyBranch = true or c.branchId = :branchId)"
            + " and (:anyText = true or lower(c.displayLabel) like :pattern escape '!' or lower(c.internalRef) like :pattern escape '!'"
            + "      or lower(coalesce(c.externalCode, '')) like :pattern escape '!')"
            + " order by c.createdAt desc, c.id desc")
    List<CollectionCode> page(UUID merchantId, Instant at, UUID id, boolean anyStatus, CollectionCodeStatus status, boolean anyBranch,
                              UUID branchId, boolean anyText, String pattern, Pageable pageable);
}
