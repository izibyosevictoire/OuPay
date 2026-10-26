package rw.oupay.inventory;

import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;

public interface StockMovementRepository extends JpaRepository<StockMovement, UUID> {

    /** The operation a durable id already recorded, if any. Unique per business (a database index). */
    Optional<StockMovement> findByMerchantIdAndOperationId(UUID merchantId, UUID operationId);

    boolean existsByMerchantIdAndBranchIdAndItemId(UUID merchantId, UUID branchId, UUID itemId);

    /** Keyset history page, newest first, total order (created_at, id). Same filter conventions as the balance page. */
    @Query("select m from StockMovement m where m.merchantId = :merchantId"
            + " and (m.createdAt < :at or (m.createdAt = :at and m.id < :id))"
            + " and (:anyBranch = true or m.branchId = :branchId)"
            + " and (:anyItem = true or m.itemId = :itemId)"
            + " and (:anyType = true or m.movementType = :type)"
            + " and (:restrict = false or m.branchId in :allowed)"
            + " order by m.createdAt desc, m.id desc")
    List<StockMovement> page(UUID merchantId, Instant at, UUID id, boolean anyBranch, UUID branchId, boolean anyItem, UUID itemId,
                             boolean anyType, MovementType type, boolean restrict, Collection<UUID> allowed, Pageable pageable);
}
