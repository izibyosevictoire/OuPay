package rw.oupay.pos;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import rw.oupay.checkout.CodeCheckoutDtos;

/**
 * Wire shapes of POS BILLING (R7b). The merchant is always the URL. The cashier names the draft, the version of it they reviewed, the TOTAL
 * they reviewed and, when they hold several codes, which code to bill through. Prices, tax, quantities and stock are never accepted from
 * the client: the server re-reads the catalog, the tax classification and the stock at the moment of billing, and refuses the bill (with
 * the current figures) if what it computes is not what was reviewed.
 */
public final class PosBillingDtos {

    private PosBillingDtos() {}

    public static final String RESERVATION_NOTE = "Goods in this sale are RESERVED at this branch (not sold): physical stock is unchanged until the payment is verified and "
            + "the sale is fulfilled.";
    public static final String DEMO_RESERVATION_NOTE = "DEMONSTRATION: no stock is reserved and nothing can be paid or fulfilled.";

    public record BillRequest(@NotNull Long expectedDraftVersion, @NotNull Long reviewedTotalRwf, UUID collectionCodeId) {}

    public record ReleaseRequest(@NotBlank @Size(min = 10, max = 300) String reason) {}

    /**
     * Stock for one goods line at review or billing time: physical, reserved and available are kept apart (available = physical - reserved).
     * {@code state}: NOT_TRACKED (service), SUFFICIENT, INSUFFICIENT or NO_STOCK_RECORD.
     */
    public record Availability(String state, String physical, String reserved, String available, String requested, String canonicalUnit) {}

    public record ReviewLine(int lineNo, UUID itemId, String name, String code, String enteredQuantity, String enteredUnit, String packageLabel, String saleUnit,
                             String quantityInSaleUnit, String canonicalQuantity, String canonicalUnit, int priceVersion, long unitPriceRwf,
                             /** The price version and price the draft was SAVED at, so a change is visible. */
                             int draftPriceVersion, long draftUnitPriceRwf, boolean priceChangedSinceDraft,
                             String taxCategory, Integer taxRateBp, boolean taxApproved, long netRwf, long taxRwf, long lineTotalRwf, Availability availability) {}

    /** {@code lineNo} is 0 for a problem of the whole bill (no code, no branch...). */
    public record Problem(int lineNo, String code, String message) {}

    /** The FINAL review the cashier confirms: current catalog prices, tax and stock as the server sees them now. */
    public record Review(UUID draftId, long draftVersion, UUID branchId, String branchName, List<ReviewLine> lines, List<Problem> problems, long subtotalRwf,
                         long taxRwf, long totalRwf, boolean billable,
                         /** LIVE, DEMONSTRATION or UNAVAILABLE for the code the sale would go through. */
                         String mode, String codeLabel, String modeNote, String stockNote, String taxNote, List<String> approvedTaxTreatments) {}

    public record SaleLine(int lineNo, UUID itemId, String itemType, String name, String code, String enteredQuantity, String enteredUnit, String packageLabel,
                           String saleUnit, String quantityInSaleUnit, String canonicalQuantity, String canonicalUnit, int priceVersion, long unitPriceRwf,
                           String taxCategory, int taxRateBp, long netRwf, long taxRwf, long lineTotalRwf) {}

    public record ReservationLine(UUID itemId, String name, String quantity, String canonicalUnit, String enteredQuantity, String enteredUnit, String packageLabel) {}

    /**
     * @param state RESERVED (active), FULFILLED, RELEASED or NOT_RESERVED (a demonstration, or a sale of services only). Stock reserved is
     *              NOT stock sold, and is not "paid".
     */
    public record ReservationView(String state, String note, Instant expiryReviewAt, Instant releasedAt, String releaseReason, List<ReservationLine> lines) {}

    /** One deduction: the goods of a reserved line, taken out of PHYSICAL stock by a SALE movement. Physical and available are as they are NOW. */
    public record FulfilmentLine(UUID itemId, String name, String quantityDeducted, String canonicalUnit, UUID movementId, String physicalNow, String availableNow) {}

    public record FulfilmentEvent(String kind, String detail, Instant at) {}

    /** A decision a person has to take: see pos_fulfilment_exceptions. */
    public record FulfilmentIssue(UUID id, UUID saleId, String saleReference, String invoiceNumber, String kind, String status, String detail, Instant openedAt,
                                      List<FulfilmentEvent> history) {}

    /**
     * Four SEPARATE facts, never one status. paymentState: UNPAID, PARTIAL, PAID or REVERSED (from verified, reconciled allocations only), or
     * NOT_APPLICABLE for a demonstration. The reservation is in {@link ReservationView}. inventoryState: NOT_POSTED, POSTED, EXCEPTION, NOT_REQUIRED
     * (services only) or NOT_APPLICABLE (a demonstration). handover: NOT_TRACKED (handing the goods over is not recorded yet): PAID is never
     * "delivered", and POSTED only says the stock ledger was updated.
     */
    public record FulfilmentView(String paymentState, long appliedRwf, long totalRwf, String inventoryState, Instant postedAt, int attempts, Instant nextAttemptAt,
                                 String lastError, List<FulfilmentLine> lines, List<FulfilmentIssue> exceptions, List<FulfilmentEvent> events, String handover,
                                 String note) {}

    public static final String HANDOVER_NOTE = "Posting records the stock deduction only. Handing the goods over is not recorded yet.";
    public static final String DEMO_FULFILMENT_NOTE = "DEMONSTRATION: no real payment, stock reservation, stock deduction or fulfilment exists for this bill.";

    public record BilledSale(CodeCheckoutDtos.CodeSaleDto sale, UUID draftId, String mode, List<SaleLine> lines, long subtotalRwf, long taxRwf, long totalRwf,
                             ReservationView reservation, String taxNote, FulfilmentView fulfilment) {}

    /** {@code created} is false when this was a repeat of an earlier bill (the original sale comes back). */
    public record BillOutcome(BilledSale sale, boolean created) {}
}
