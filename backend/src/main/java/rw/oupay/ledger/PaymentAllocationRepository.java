package rw.oupay.ledger;

import java.util.Collection;
import java.util.List;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;

public interface PaymentAllocationRepository extends JpaRepository<PaymentAllocation, UUID> {

    List<PaymentAllocation> findByBankTransactionId(UUID bankTransactionId);

    List<PaymentAllocation> findByMerchantId(UUID merchantId);

    @Query("select a from PaymentAllocation a where a.bankTransactionId in :ids")
    List<PaymentAllocation> findByTransactionIds(Collection<UUID> ids);

    @Query("select a from PaymentAllocation a where a.merchantId = :merchantId and (a.createdAt < :at or (a.createdAt = :at and a.id < :id)) order by a.createdAt desc, a.id desc")
    List<PaymentAllocation> pageForMerchant(UUID merchantId, java.time.Instant at, UUID id, org.springframework.data.domain.Pageable pageable);

    @Query("select a from PaymentAllocation a where a.merchantId = :merchantId and (a.createdAt < :at or (a.createdAt = :at and a.id < :id)) "
            + "and exists (select 1 from Invoice i where i.id = a.invoiceId and i.assignedToUserId = :userId) order by a.createdAt desc, a.id desc")
    List<PaymentAllocation> pageForAssignee(UUID merchantId, UUID userId, java.time.Instant at, UUID id, org.springframework.data.domain.Pageable pageable);

    @Query("select a from PaymentAllocation a where a.invoiceId = :invoiceId and a.status = 'ACTIVE'")
    List<PaymentAllocation> findActiveByInvoice(UUID invoiceId);
}
