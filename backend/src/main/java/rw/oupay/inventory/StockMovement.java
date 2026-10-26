package rw.oupay.inventory;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.UUID;

/** One immutable fact: stock changed by a signed canonical quantity. Every column is {@code updatable = false}; a trigger agrees. */
@Entity
@Table(name = "stock_movements")
public class StockMovement {

    @Id
    private UUID id;

    @Column(name = "merchant_id", nullable = false, updatable = false)
    private UUID merchantId;

    @Column(name = "branch_id", nullable = false, updatable = false)
    private UUID branchId;

    @Column(name = "item_id", nullable = false, updatable = false)
    private UUID itemId;

    @Enumerated(EnumType.STRING)
    @Column(name = "movement_type", nullable = false, updatable = false)
    private MovementType movementType;

    @Column(name = "quantity_delta", nullable = false, updatable = false, precision = 20, scale = 6)
    private BigDecimal quantityDelta;

    @Column(name = "balance_after", nullable = false, updatable = false, precision = 20, scale = 6)
    private BigDecimal balanceAfter;

    @Column(name = "entered_as", updatable = false)
    private String enteredAs;

    @Column(updatable = false)
    private String reason;

    @Column(updatable = false)
    private String reference;

    @Column(name = "operation_id", nullable = false, updatable = false)
    private UUID operationId;

    @Column(name = "request_sha256", nullable = false, updatable = false)
    private String requestSha256;

    @Column(name = "actor_user_id", nullable = false, updatable = false)
    private UUID actorUserId;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    protected StockMovement() {}

    public StockMovement(UUID merchantId, UUID branchId, UUID itemId, MovementType movementType, BigDecimal quantityDelta,
                         BigDecimal balanceAfter, String enteredAs, String reason, String reference, UUID operationId,
                         String requestSha256, UUID actorUserId, Instant now) {
        this.id = UUID.randomUUID();
        this.merchantId = merchantId;
        this.branchId = branchId;
        this.itemId = itemId;
        this.movementType = movementType;
        this.quantityDelta = quantityDelta;
        this.balanceAfter = balanceAfter;
        this.enteredAs = enteredAs;
        this.reason = reason;
        this.reference = reference;
        this.operationId = operationId;
        this.requestSha256 = requestSha256;
        this.actorUserId = actorUserId;
        this.createdAt = now.truncatedTo(ChronoUnit.MICROS);
    }

    public UUID getId() { return id; }
    public UUID getMerchantId() { return merchantId; }
    public UUID getBranchId() { return branchId; }
    public UUID getItemId() { return itemId; }
    public MovementType getMovementType() { return movementType; }
    public BigDecimal getQuantityDelta() { return quantityDelta; }
    public BigDecimal getBalanceAfter() { return balanceAfter; }
    public String getEnteredAs() { return enteredAs; }
    public String getReason() { return reason; }
    public String getReference() { return reference; }
    public UUID getOperationId() { return operationId; }
    public String getRequestSha256() { return requestSha256; }
    public UUID getActorUserId() { return actorUserId; }
    public Instant getCreatedAt() { return createdAt; }
}
