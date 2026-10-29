package rw.oupay.catalog;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import jakarta.persistence.Version;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.UUID;
import rw.oupay.measurement.MeasurementDimension;
import rw.oupay.measurement.MeasurementUnit;

/**
 * A good or a service a business sells. What the item IS (type, dimension, stock unit) is fixed at creation, because future
 * stock is kept in that unit; the database refuses to change it. Name, description, code, sale unit, price and the active flag
 * are editable. The price shown here is a copy of the current immutable {@link CatalogPrice} version.
 */
@Entity
@Table(name = "catalog_items")
public class CatalogItem {

    @Id
    private UUID id;

    @Column(name = "merchant_id", nullable = false, updatable = false)
    private UUID merchantId;

    @Enumerated(EnumType.STRING)
    @Column(name = "item_type", nullable = false, updatable = false)
    private CatalogItemType itemType;

    @Column(nullable = false)
    private String name;

    private String description;

    /** Merchant-defined SKU, stored uppercase. */
    private String code;

    @Column(nullable = false)
    private boolean active;

    @Enumerated(EnumType.STRING)
    @Column(name = "measurement_dimension", nullable = false, updatable = false)
    private MeasurementDimension measurementDimension;

    /** Unit code ("g"); null for a service. */
    @Column(name = "stock_unit", updatable = false)
    private String stockUnit;

    /** Unit code ("kg") the price applies to one of. */
    @Column(name = "sale_unit", nullable = false)
    private String saleUnit;

    @Column(name = "price_per_sale_unit_rwf", nullable = false)
    private long pricePerSaleUnitRwf;

    @Column(name = "current_price_version", nullable = false)
    private int currentPriceVersion;

    @Column(name = "created_by_user_id", nullable = false, updatable = false)
    private UUID createdByUserId;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    @Version
    private long version;

    protected CatalogItem() {}

    public CatalogItem(UUID id, UUID merchantId, CatalogItemType itemType, String name, String description, String code,
                       boolean active, MeasurementDimension dimension, MeasurementUnit stockUnit, MeasurementUnit saleUnit,
                       long pricePerSaleUnitRwf, UUID createdByUserId, Instant now) {
        this.id = id;
        this.merchantId = merchantId;
        this.itemType = itemType;
        this.name = name;
        this.description = description;
        this.code = code;
        this.active = active;
        this.measurementDimension = dimension;
        this.stockUnit = stockUnit == null ? null : stockUnit.code();
        this.saleUnit = saleUnit.code();
        this.pricePerSaleUnitRwf = pricePerSaleUnitRwf;
        this.currentPriceVersion = 1;
        this.createdByUserId = createdByUserId;
        this.createdAt = now.truncatedTo(ChronoUnit.MICROS);
        this.updatedAt = this.createdAt;
    }

    public UUID getId() { return id; }
    public UUID getMerchantId() { return merchantId; }
    public CatalogItemType getItemType() { return itemType; }
    public String getName() { return name; }
    public String getDescription() { return description; }
    public String getCode() { return code; }
    public boolean isActive() { return active; }
    public MeasurementDimension getMeasurementDimension() { return measurementDimension; }
    public MeasurementUnit getStockUnit() { return stockUnit == null ? null : MeasurementUnit.fromCode(stockUnit); }
    public MeasurementUnit getSaleUnit() { return MeasurementUnit.fromCode(saleUnit); }
    public long getPricePerSaleUnitRwf() { return pricePerSaleUnitRwf; }
    public int getCurrentPriceVersion() { return currentPriceVersion; }
    public UUID getCreatedByUserId() { return createdByUserId; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }
    public long getVersion() { return version; }

    /** Descriptive fields only; price and unit go through {@link #reprice}. */
    public void describe(String name, String description, String code, Instant now) {
        this.name = name;
        this.description = description;
        this.code = code;
        this.updatedAt = now.truncatedTo(ChronoUnit.MICROS);
    }

    /** Moves to the next price version. The caller records the matching immutable {@link CatalogPrice}. */
    public int reprice(MeasurementUnit saleUnit, long pricePerSaleUnitRwf, Instant now) {
        this.saleUnit = saleUnit.code();
        this.pricePerSaleUnitRwf = pricePerSaleUnitRwf;
        this.currentPriceVersion = currentPriceVersion + 1;
        this.updatedAt = now.truncatedTo(ChronoUnit.MICROS);
        return currentPriceVersion;
    }

    public void setActive(boolean active, Instant now) {
        this.active = active;
        this.updatedAt = now.truncatedTo(ChronoUnit.MICROS);
    }
}
