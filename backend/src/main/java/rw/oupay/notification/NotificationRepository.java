package rw.oupay.notification;

import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;

public interface NotificationRepository extends JpaRepository<Notification, UUID> {

    List<Notification> findByMerchantIdAndRecipientUserIdOrderByCreatedAtDesc(UUID merchantId, UUID recipientUserId);

    Optional<Notification> findByIdAndMerchantIdAndRecipientUserId(UUID id, UUID merchantId, UUID recipientUserId);

    @Modifying
    @Query("update Notification n set n.readAt = :now where n.merchantId = :merchantId and n.recipientUserId = :userId and n.readAt is null")
    int markAllRead(UUID merchantId, UUID userId, java.time.Instant now);
}
