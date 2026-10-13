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

    @Query("select a from PaymentAllocation a where a.invoiceId = :invoiceId and a.status = 'ACTIVE'")
    List<PaymentAllocation> findActiveByInvoice(UUID invoiceId);
}
