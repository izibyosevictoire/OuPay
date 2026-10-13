package rw.oupay.invoice;

import jakarta.persistence.LockModeType;
import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;

public interface InvoiceRepository extends JpaRepository<Invoice, UUID> {

    Optional<Invoice> findByIdAndMerchantId(UUID id, UUID merchantId);

    Optional<Invoice> findByMerchantIdAndInvoiceNumber(UUID merchantId, String invoiceNumber);

    @Query("select i from Invoice i where i.merchantId = :merchantId order by i.createdAt desc")
    List<Invoice> findAllForMerchant(UUID merchantId);

    @Query("select i from Invoice i where i.merchantId = :merchantId and i.assignedToUserId = :userId order by i.createdAt desc")
    List<Invoice> findAssignedTo(UUID merchantId, UUID userId);

    /** Keyset page, newest first, total order (created_at, id). */
    @Query("select i from Invoice i where i.merchantId = :merchantId and (i.createdAt < :at or (i.createdAt = :at and i.id < :id)) order by i.createdAt desc, i.id desc")
    List<Invoice> pageForMerchant(UUID merchantId, java.time.Instant at, UUID id, org.springframework.data.domain.Pageable pageable);

    @Query("select i from Invoice i where i.merchantId = :merchantId and i.assignedToUserId = :userId and (i.createdAt < :at or (i.createdAt = :at and i.id < :id)) order by i.createdAt desc, i.id desc")
    List<Invoice> pageAssignedTo(UUID merchantId, UUID userId, java.time.Instant at, UUID id, org.springframework.data.domain.Pageable pageable);

    long countByMerchantId(UUID merchantId);

    long countByMerchantIdAndAssignedToUserId(UUID merchantId, UUID assignedToUserId);

    /** Pessimistic write lock: used before allocating money, so balances cannot change underneath. */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select i from Invoice i where i.id = :id and i.merchantId = :merchantId")
    Optional<Invoice> lockByIdAndMerchantId(UUID id, UUID merchantId);

    @Query("select i from Invoice i where i.id in :ids and i.merchantId = :merchantId")
    List<Invoice> findAllByIdsAndMerchant(Collection<UUID> ids, UUID merchantId);
}
