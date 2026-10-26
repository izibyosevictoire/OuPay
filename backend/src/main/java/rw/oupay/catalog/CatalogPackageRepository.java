package rw.oupay.catalog;

import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;

public interface CatalogPackageRepository extends JpaRepository<CatalogPackage, UUID> {

    @Query("select p from CatalogPackage p where p.itemId in :itemIds and p.merchantId = :merchantId order by p.createdAt, p.id")
    List<CatalogPackage> findForItems(Collection<UUID> itemIds, UUID merchantId);

    Optional<CatalogPackage> findByIdAndItemIdAndMerchantId(UUID id, UUID itemId, UUID merchantId);

    long countByItemId(UUID itemId);

    @Query("select count(p) > 0 from CatalogPackage p where p.itemId = :itemId and lower(p.label) = :label")
    boolean labelTaken(UUID itemId, String label);

    @Query("select count(p) > 0 from CatalogPackage p where p.itemId = :itemId and lower(p.label) = :label and p.id <> :exceptId")
    boolean labelTakenByAnother(UUID itemId, String label, UUID exceptId);
}
