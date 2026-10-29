package rw.oupay.inventory;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * Wire shapes of inventory. The merchant comes only from the URL. Quantities travel as plain decimal STRINGS. A stock entry is
 * either {@code amount} + {@code unit} or {@code packageId} + {@code packageCount}, never both and never neither.
 */
public final class InventoryDtos {

    private InventoryDtos() {}

    /** Records stock the business already holds (once per branch and item, before any other movement). */
    public record OpeningRequest(
            @NotNull UUID clientOperationId, @NotNull UUID branchId, @NotNull UUID itemId,
            @Size(max = 60) String amount, @Size(max = 8) String unit, UUID packageId, @Size(max = 60) String packageCount,
            @Size(max = 100) String reference, @Size(max = 200) String reason) {}

    public record ReceiveRequest(
            @NotNull UUID clientOperationId, @NotNull UUID branchId, @NotNull UUID itemId,
            @Size(max = 60) String amount, @Size(max = 8) String unit, UUID packageId, @Size(max = 60) String packageCount,
            @Size(max = 100) String reference, @Size(max = 200) String reason) {}

    /** {@code direction} is explicit and a reason is required. */
    public record AdjustRequest(
            @NotNull UUID clientOperationId, @NotNull UUID branchId, @NotNull UUID itemId,
            @NotNull @Pattern(regexp = "IN|OUT", message = "The direction must be IN or OUT.") String direction,
            @Size(max = 60) String amount, @Size(max = 8) String unit, UUID packageId, @Size(max = 60) String packageCount,
            @Size(max = 100) String reference, @NotBlank @Size(max = 200) String reason) {}

    public record BalanceDto(UUID id, UUID branchId, String branchName, String branchCode, UUID itemId, String itemName,
                             String itemCode, String measurementDimension, String stockUnit, String quantityOnHand, String saleUnit,
                             String quantityInSaleUnit, Instant updatedAt, long version,
                             /** R7b: stock reserved for sales already billed, and what is left to sell (physical minus reserved), both canonical. */
                             String quantityReserved, String quantityAvailable) {}

    public record MovementDto(UUID id, UUID branchId, String branchName, UUID itemId, String itemName, MovementType movementType,
                              String quantityDelta, String balanceAfter, String stockUnit, String enteredAs, String reason,
                              String reference, UUID operationId, String actorName, Instant createdAt) {}

    public record MovementResult(MovementDto movement, BalanceDto balance, boolean replayed) {}

    public record BranchOption(UUID id, String name, String code, String status, boolean writable) {}

    public record Options(List<BranchOption> branches) {}
}
