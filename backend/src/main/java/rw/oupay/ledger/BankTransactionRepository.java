package rw.oupay.ledger;

import jakarta.persistence.LockModeType;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import rw.oupay.banking.ProviderId;

public interface BankTransactionRepository extends JpaRepository<BankTransaction, UUID> {

    /** Row lock: the first step of every financial mutation (lock order: transaction, then invoices). */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select t from BankTransaction t where t.providerId = :provider and t.providerTransactionId = :providerTransactionId")
    Optional<BankTransaction> lockByProviderTransaction(ProviderId provider, String providerTransactionId);

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select t from BankTransaction t where t.id = :id and t.merchantId = :merchantId")
    Optional<BankTransaction> lockByIdAndMerchantId(UUID id, UUID merchantId);

    Optional<BankTransaction> findByIdAndMerchantId(UUID id, UUID merchantId);

    @Query("select t from BankTransaction t where t.merchantId = :merchantId order by t.providerOccurredAt desc")
    List<BankTransaction> findAllForMerchant(UUID merchantId);

    @Query("select t from BankTransaction t where t.merchantId = :merchantId and (t.paymentRequestId = :requestId or t.paymentReference = :reference)")
    List<BankTransaction> findForRequest(UUID merchantId, UUID requestId, String reference);
}
