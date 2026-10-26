package rw.oupay.inventory;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import jakarta.persistence.Version;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;
import rw.oupay.measurement.MeasurementDimension;

/**
 * The physical stock of one goods item at one branch, in the item's canonical stock unit ({@code NUMERIC(20,6)}). It is READ-ONLY
 * here: the database moves it, and only when a {@link StockMovement} is inserted (trigger {@code apply_stock_movement}), in the same
 * statement and under the row lock, so it can never differ from the sum of its movements. The database refuses a negative
 * quantity, a fraction of a piece and stock for a service.
 */
@Entity
@Table(name = "inventory_balances")
public class InventoryBalance {

    @Id
    private UUID id;

    @Column(name = "merchant_id", nullable = false, updatable = false)
    private UUID merchantId;

    @Column(name = "branch_id", nullable = false, updatable = false)
    private UUID branchId;

    @Column(name = "item_id", nullable = false, updatable = false)
    private UUID itemId;

    @Column(name = "item_type", nullable = false, updatable = false)
    private String itemType;

    @Enumerated(EnumType.STRING)
    @Column(name = "measurement_dimension", nullable = false, updatable = false)
    private MeasurementDimension measurementDimension;

    /** Changed only by the database, when a movement is inserted (see V10); the entity never writes it. */
    @Column(name = "quantity_on_hand", nullable = false, updatable = false, precision = 20, scale = 6)
    private BigDecimal quantityOnHand;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false, updatable = false)
    private Instant updatedAt;

    @Version
    private long version;

    protected InventoryBalance() {}

    public UUID getId() { return id; }
    public UUID getMerchantId() { return merchantId; }
    public UUID getBranchId() { return branchId; }
    public UUID getItemId() { return itemId; }
    public String getItemType() { return itemType; }
    public MeasurementDimension getMeasurementDimension() { return measurementDimension; }
    public BigDecimal getQuantityOnHand() { return quantityOnHand; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }
    public long getVersion() { return version; }
}
