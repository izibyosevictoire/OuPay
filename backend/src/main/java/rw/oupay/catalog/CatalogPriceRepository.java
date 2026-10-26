package rw.oupay.catalog;

import java.util.List;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;

public interface CatalogPriceRepository extends JpaRepository<CatalogPrice, UUID> {

    List<CatalogPrice> findByItemIdAndMerchantIdOrderByVersionDesc(UUID itemId, UUID merchantId);
}
