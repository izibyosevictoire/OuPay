package rw.oupay.catalog;

import jakarta.persistence.LockModeType;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;

public interface CatalogItemRepository extends JpaRepository<CatalogItem, UUID> {

    Optional<CatalogItem> findByIdAndMerchantId(UUID id, UUID merchantId);

    /** Serialises concurrent changes to one item, so a stale expected version is always a clean conflict. */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select i from CatalogItem i where i.id = :id and i.merchantId = :merchantId")
    Optional<CatalogItem> lockByIdAndMerchantId(UUID id, UUID merchantId);

    boolean existsByMerchantIdAndCode(UUID merchantId, String code);

    boolean existsByMerchantIdAndCodeAndIdNot(UUID merchantId, String code, UUID id);

    /**
     * Keyset page, newest first, total order (created_at, id). The filters take plain values (never null) with an "any"
     * switch, so the query never depends on how a null parameter is typed. {@code pattern} is a lower-case LIKE pattern that
     * the service has escaped with '!'.
     */
    @Query("select i from CatalogItem i where i.merchantId = :merchantId"
            + " and (i.createdAt < :at or (i.createdAt = :at and i.id < :id))"
            + " and (:anyType = true or i.itemType = :type)"
            + " and (:anyActive = true or i.active = :active)"
            + " and (:anyText = true or lower(i.name) like :pattern escape '!' or lower(coalesce(i.code, '')) like :pattern escape '!')"
            + " order by i.createdAt desc, i.id desc")
    List<CatalogItem> page(UUID merchantId, Instant at, UUID id, boolean anyType, CatalogItemType type, boolean anyActive,
                           boolean active, boolean anyText, String pattern, Pageable pageable);
}
