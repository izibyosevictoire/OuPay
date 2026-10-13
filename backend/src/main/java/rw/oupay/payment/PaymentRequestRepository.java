package rw.oupay.payment;

import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;

public interface PaymentRequestRepository extends JpaRepository<PaymentRequest, UUID> {

    Optional<PaymentRequest> findByMerchantIdAndPublicReference(UUID merchantId, String publicReference);

    Optional<PaymentRequest> findByPublicReference(String publicReference);

    Optional<PaymentRequest> findByIdAndMerchantId(UUID id, UUID merchantId);

    List<PaymentRequest> findByMerchantIdAndInvoiceIdOrderByCreatedAtDesc(UUID merchantId, UUID invoiceId);

    boolean existsByPublicReference(String publicReference);

    long countByPaymentProfileIdAndCreatedAtAfter(UUID paymentProfileId, java.time.Instant after);
}
