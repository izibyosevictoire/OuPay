package rw.oupay.catalog;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.UUID;
import rw.oupay.measurement.MeasurementUnit;

/**
 * One immutable version of an item's price: the price of ONE sale unit, from the moment it took effect. Rows are only ever
 * added (a database trigger refuses updates and deletes). Everything is {@code updatable = false}.
 */
@Entity
@Table(name = "catalog_item_prices")
public class CatalogPrice {

    @Id
    private UUID id;

    @Column(name = "item_id", nullable = false, updatable = false)
    private UUID itemId;

    @Column(name = "merchant_id", nullable = false, updatable = false)
    private UUID merchantId;

    @Column(nullable = false, updatable = false)
    private int version;

    @Column(name = "price_per_sale_unit_rwf", nullable = false, updatable = false)
    private long pricePerSaleUnitRwf;

    @Column(name = "sale_unit", nullable = false, updatable = false)
    private String saleUnit;

    @Column(updatable = false)
    private String reason;

    @Column(name = "created_by_user_id", nullable = false, updatable = false)
    private UUID createdByUserId;

    @Column(name = "effective_at", nullable = false, updatable = false)
    private Instant effectiveAt;

    protected CatalogPrice() {}

    public CatalogPrice(UUID itemId, UUID merchantId, int version, long pricePerSaleUnitRwf, MeasurementUnit saleUnit,
                        String reason, UUID createdByUserId, Instant now) {
        this.id = UUID.randomUUID();
        this.itemId = itemId;
        this.merchantId = merchantId;
        this.version = version;
        this.pricePerSaleUnitRwf = pricePerSaleUnitRwf;
        this.saleUnit = saleUnit.code();
        this.reason = reason;
        this.createdByUserId = createdByUserId;
        this.effectiveAt = now.truncatedTo(ChronoUnit.MICROS);
    }

    public UUID getMerchantId() { return merchantId; }
    public UUID getCreatedByUserId() { return createdByUserId; }
    public UUID getItemId() { return itemId; }
    public int getVersion() { return version; }
    public long getPricePerSaleUnitRwf() { return pricePerSaleUnitRwf; }
    public MeasurementUnit getSaleUnit() { return MeasurementUnit.fromCode(saleUnit); }
    public String getReason() { return reason; }
    public Instant getEffectiveAt() { return effectiveAt; }
}
