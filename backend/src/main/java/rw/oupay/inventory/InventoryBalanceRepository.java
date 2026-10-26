package rw.oupay.inventory;

import jakarta.persistence.LockModeType;
import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;

public interface InventoryBalanceRepository extends JpaRepository<InventoryBalance, UUID> {

    Optional<InventoryBalance> findByMerchantIdAndBranchIdAndItemId(UUID merchantId, UUID branchId, UUID itemId);

    /** Pessimistic write lock: the single serialisation point of every stock change to this branch and item. */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select b from InventoryBalance b where b.merchantId = :merchantId and b.branchId = :branchId and b.itemId = :itemId")
    Optional<InventoryBalance> lockByKey(UUID merchantId, UUID branchId, UUID itemId);

    /**
     * Keyset page, newest first, total order (created_at, id). Filters take plain values with an "any" switch (never a null
     * parameter). {@code allowed} limits the branches a caller may see; it is only used when {@code restrict} is true.
     * {@code pattern} is a lower-case LIKE pattern escaped with '!'.
     */
    @Query("select b from InventoryBalance b where b.merchantId = :merchantId"
            + " and (b.createdAt < :at or (b.createdAt = :at and b.id < :id))"
            + " and (:anyBranch = true or b.branchId = :branchId)"
            + " and (:anyItem = true or b.itemId = :itemId)"
            + " and (:restrict = false or b.branchId in :allowed)"
            + " and (:anyText = true or exists (select 1 from CatalogItem i where i.id = b.itemId and i.merchantId = b.merchantId"
            + "      and (lower(i.name) like :pattern escape '!' or lower(coalesce(i.code, '')) like :pattern escape '!')))"
            + " order by b.createdAt desc, b.id desc")
    List<InventoryBalance> page(UUID merchantId, Instant at, UUID id, boolean anyBranch, UUID branchId, boolean anyItem, UUID itemId,
                                boolean restrict, Collection<UUID> allowed, boolean anyText, String pattern, Pageable pageable);
}
