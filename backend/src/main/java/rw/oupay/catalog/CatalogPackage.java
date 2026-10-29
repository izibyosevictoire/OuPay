package rw.oupay.catalog;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import jakarta.persistence.Version;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.UUID;
import rw.oupay.measurement.MeasurementDimension;

/**
 * How much of ONE item a package holds ("Carton" = 24 pieces, "Bag" = 25 kg stored as 25000 g). Defined per item, never global.
 * The quantity is exact and in the item's stock (canonical) unit, {@code NUMERIC(20,6)}. A package has no price of its own.
 */
@Entity
@Table(name = "catalog_item_packages")
public class CatalogPackage {

    @Id
    private UUID id;

    @Column(name = "item_id", nullable = false, updatable = false)
    private UUID itemId;

    @Column(name = "merchant_id", nullable = false, updatable = false)
    private UUID merchantId;

    /** Always GOODS; part of the composite key that stops a service from owning packages. */
    @Column(name = "item_type", nullable = false, updatable = false)
    private String itemType;

    @Enumerated(EnumType.STRING)
    @Column(name = "measurement_dimension", nullable = false, updatable = false)
    private MeasurementDimension measurementDimension;

    @Column(nullable = false)
    private String label;

    @Column(name = "quantity_per_package", nullable = false, precision = 20, scale = 6)
    private BigDecimal quantityPerPackage;

    @Column(nullable = false)
    private boolean active;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    @Version
    private long version;

    protected CatalogPackage() {}

    public CatalogPackage(UUID itemId, UUID merchantId, MeasurementDimension dimension, String label,
                          BigDecimal quantityPerPackage, Instant now) {
        this.id = UUID.randomUUID();
        this.itemId = itemId;
        this.merchantId = merchantId;
        this.itemType = CatalogItemType.GOODS.name();
        this.measurementDimension = dimension;
        this.label = label;
        this.quantityPerPackage = quantityPerPackage;
        this.active = true;
        this.createdAt = now.truncatedTo(ChronoUnit.MICROS);
        this.updatedAt = this.createdAt;
    }

    public UUID getId() { return id; }
    public UUID getMerchantId() { return merchantId; }
    public String getItemType() { return itemType; }
    public MeasurementDimension getMeasurementDimension() { return measurementDimension; }
    public UUID getItemId() { return itemId; }
    public String getLabel() { return label; }
    public BigDecimal getQuantityPerPackage() { return quantityPerPackage; }
    public boolean isActive() { return active; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }
    public long getVersion() { return version; }

    public void redefine(String label, BigDecimal quantityPerPackage, boolean active, Instant now) {
        this.label = label;
        this.quantityPerPackage = quantityPerPackage;
        this.active = active;
        this.updatedAt = now.truncatedTo(ChronoUnit.MICROS);
    }
}
