package rw.oupay.pos;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import rw.oupay.catalog.CatalogItemType;

/**
 * Wire shapes of the business POS (R7a). The merchant is always the URL, never a body. Quantities travel as plain decimal STRINGS (a
 * browser would round a JSON number); prices are whole RWF and are NEVER accepted from the client: the request names an item and the
 * price VERSION the cashier saw, and the server prices the line from the catalog's current version.
 */
public final class PosDtos {

    private PosDtos() {}

    /** The most lines one cart can hold. */
    public static final int MAX_LINES = 100;

    /** The stock figures in a cart are informational only: nothing is reserved or deducted until billing (R7b). */
    public static final String STOCK_NOTE = "Stock shown is informational. Nothing is reserved or deducted, and it is checked again when you bill.";

    /** Shown on every saved draft: a draft is an intent to sell, never a sale. */
    public static final String DRAFT_NOTICE = "A POS draft is not a sale: it is not an invoice, nothing is payable and no stock is reserved or deducted.";

    /**
     * Shown with every quote and draft. The catalog carries no tax category, so a POS total is the plain rounded sum of price times
     * quantity: it is PROVISIONAL, never a bill. Tax treatment must be configured and validated before an invoice is issued (R7b).
     */
    public static final String TAX_NOTE = "Provisional total: tax is not calculated or included, and prices are rechecked when you bill. "
            + "Tax treatment is applied only when an invoice is issued.";

    public enum Readiness { READY, NOT_BUSINESS, NO_BRANCH }

    public record BranchChoice(UUID id, String name, String code) {}

    public record Options(Readiness readiness, List<BranchChoice> branches, int maxLines, String stockNote) {}

    /** One package of an item: how much stock it holds, exactly. */
    public record PackageOption(UUID id, String label, String quantityPerPackage, String canonicalUnit, String quantityInSaleUnit) {}

    /**
     * @param state NOT_TRACKED (a service), RECORDED (a balance exists at the branch) or NO_RECORD (no stock has ever been recorded there)
     */
    public record StockInfo(String state, String onHand, String canonicalUnit, String onHandInSaleUnit) {}

    public record CatalogItemView(UUID itemId, CatalogItemType itemType, String name, String code, String measurementDimension, String saleUnit,
                                  List<String> units, long pricePerSaleUnitRwf, int priceVersion, List<PackageOption> packages, StockInfo stock) {}

    /**
     * @param quantity a plain decimal string in {@code unit}, or the number of whole packages when {@code packageId} is given
     * @param unit     the unit the quantity is entered in (any unit of the item's dimension), or null when a package is chosen
     * @param expectedPriceVersion the price version the cashier saw; a different current version is refused with the new price
     */
    public record LineRequest(@NotNull UUID itemId, @NotBlank @Size(max = 60) String quantity, @Size(max = 8) String unit, UUID packageId,
                              @NotNull Integer expectedPriceVersion) {}

    public record QuoteRequest(@NotNull UUID branchId, @NotEmpty @Size(max = MAX_LINES) @Valid List<LineRequest> lines) {}

    public record DraftRequest(@NotNull UUID clientRequestId, @NotNull UUID branchId, @Size(max = 200) String note,
                               @NotEmpty @Size(max = MAX_LINES) @Valid List<LineRequest> lines) {}

    public record UpdateRequest(@NotNull Long expectedVersion, @Size(max = 200) String note,
                                @NotEmpty @Size(max = MAX_LINES) @Valid List<LineRequest> lines) {}

    /** @param state NOT_TRACKED, SUFFICIENT, INSUFFICIENT or NO_STOCK_RECORD. Informational only. */
    public record StockCheck(String state, String onHand, String requested, String canonicalUnit) {}

    /** One priced line: an immutable snapshot once saved. */
    public record PricedLine(int lineNo, UUID itemId, CatalogItemType itemType, String name, String code, String measurementDimension,
                             String enteredQuantity, String enteredUnit, UUID packageId, String packageLabel, String saleUnit,
                             String quantityInSaleUnit, String canonicalQuantity, String canonicalUnit, int priceVersion, long unitPriceRwf,
                             long lineTotalRwf, StockCheck stock) {}

    /** Why one line of a cart can not be priced. {@code currentPriceVersion} and {@code currentPriceRwf} accompany `price_changed`. */
    public record Problem(int lineIndex, String code, String message, Integer currentPriceVersion, Long currentPriceRwf) {}

    public record Quote(UUID branchId, String branchName, List<PricedLine> lines, List<Problem> problems, long totalRwf, String currency,
                        String stockNote, String taxNote) {}

    public record Draft(UUID id, UUID merchantId, UUID branchId, String branchName, String status, String note, List<PricedLine> lines,
                        long totalRwf, String currency, String createdByName, Instant createdAt, Instant updatedAt, long version,
                        String notice, String stockNote, String taxNote) {}

    public record DraftSummary(UUID id, UUID branchId, String branchName, String status, int lineCount, long totalRwf, String createdByName,
                               Instant createdAt, Instant updatedAt, long version) {}

    /** The result of creating a draft: whether this call made it, or it was already there (a repeat). */
    public record Saved(Draft draft, boolean created) {}
}
