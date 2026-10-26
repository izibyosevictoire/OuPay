package rw.oupay.catalog;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Clock;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.stream.Collectors;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import rw.oupay.audit.AuditService;
import rw.oupay.common.ApiException;
import rw.oupay.common.DatabaseErrors;
import rw.oupay.common.Pagination;
import rw.oupay.membership.Actor;
import rw.oupay.membership.MerchantAccess;
import rw.oupay.membership.Permission;
import rw.oupay.measurement.MeasuredQuantity;
import rw.oupay.measurement.MeasurementDimension;
import rw.oupay.measurement.MeasurementException;
import rw.oupay.measurement.MeasurementUnit;
import rw.oupay.measurement.PackageConversion;
import rw.oupay.measurement.QuantityPrecision;
import rw.oupay.merchant.MerchantSettingsService;
import rw.oupay.merchant.OperatingMode;

/**
 * The goods and services catalog of a BUSINESS merchant.
 *
 * <p><b>Prices.</b> {@code pricePerSaleUnitRwf} is the price of ONE sale unit of the item: one kg, one litre, one piece or one
 * service. A package has no price of its own; it is a multiple of the sale unit. Every change of price or sale unit appends an
 * immutable {@link CatalogPrice} version. Financial records never reference the catalog: a future invoice line snapshots what it
 * sold, so nothing here can alter history.
 *
 * <p><b>Authorisation.</b> Every method starts with the {@link MerchantAccess} gate (404 for a stranger, 403 without the
 * permission), then requires the merchant to be in BUSINESS mode (409 {@code catalog_unavailable} otherwise: SIMPLIFIED
 * merchants keep the amount-only checkout and have no catalog).
 *
 * <p><b>Concurrency.</b> A change locks the item row, then compares the caller's {@code expectedVersion}, so a stale edit is
 * always a clean 409 and never a lost update. The {@code @Version} column and the database constraints remain the backstop.
 */
@Service
public class CatalogService {

    static final int MAX_PACKAGES_PER_ITEM = 20;
    private static final int MAX_SEARCH_LENGTH = 100;
    private static final String UNIQUE_VIOLATION = "23505";

    private final CatalogItemRepository items;
    private final CatalogPriceRepository prices;
    private final CatalogPackageRepository packages;
    private final MerchantAccess access;
    private final MerchantSettingsService settings;
    private final AuditService audit;
    private final Clock clock;

    public CatalogService(CatalogItemRepository items, CatalogPriceRepository prices, CatalogPackageRepository packages,
                          MerchantAccess access, MerchantSettingsService settings, AuditService audit, Clock clock) {
        this.items = items;
        this.prices = prices;
        this.packages = packages;
        this.access = access;
        this.settings = settings;
        this.audit = audit;
        this.clock = clock;
    }

    // ---------------------------------------------------------------------------------------------
    // Reads
    // ---------------------------------------------------------------------------------------------

    @Transactional(readOnly = true)
    public List<CatalogDtos.MeasurementUnitOption> measurementUnits(UUID merchantId) {
        require(merchantId, Permission.CATALOG_VIEW);
        return Arrays.stream(MeasurementDimension.values())
                .map(d -> new CatalogDtos.MeasurementUnitOption(d.name(), d.canonicalUnit().code(), d.wholeUnitsOnly(),
                        Arrays.stream(MeasurementUnit.values()).filter(u -> u.dimension() == d)
                                .map(u -> new CatalogDtos.UnitDto(u.code(), displayName(u))).toList()))
                .toList();
    }

    @Transactional(readOnly = true)
    public Pagination.Page<CatalogDtos.ItemDto> list(UUID merchantId, Integer limit, String cursor, String query,
                                                     CatalogItemType type, Boolean active) {
        require(merchantId, Permission.CATALOG_VIEW);
        int size = Pagination.limit(limit);
        Pagination.Position position = Pagination.decode(cursor);
        String text = query == null ? "" : query.trim();
        if (text.length() > MAX_SEARCH_LENGTH) {
            throw ApiException.validation("The search text is too long.");
        }
        String pattern = "%" + escapeLike(text.toLowerCase(Locale.ROOT)) + "%";
        List<CatalogItem> fetched = items.page(merchantId, position.at(), position.id(), type == null,
                type == null ? CatalogItemType.GOODS : type, active == null, active != null && active, text.isEmpty(), pattern,
                Pagination.fetch(size));
        Pagination.Page<CatalogItem> page = Pagination.page(fetched, size, CatalogItem::getCreatedAt, CatalogItem::getId, null);
        Map<UUID, List<CatalogPackage>> byItem = page.items().isEmpty() ? Map.of() : packages
                .findForItems(page.items().stream().map(CatalogItem::getId).toList(), merchantId).stream()
                .collect(Collectors.groupingBy(CatalogPackage::getItemId));
        return page.map(item -> toDto(item, byItem.getOrDefault(item.getId(), List.of())));
    }

    @Transactional(readOnly = true)
    public CatalogDtos.ItemDto get(UUID merchantId, UUID itemId) {
        require(merchantId, Permission.CATALOG_VIEW);
        return toDto(find(merchantId, itemId));
    }

    @Transactional(readOnly = true)
    public List<CatalogDtos.PriceVersionDto> priceHistory(UUID merchantId, UUID itemId) {
        require(merchantId, Permission.CATALOG_VIEW);
        find(merchantId, itemId);
        return prices.findByItemIdAndMerchantIdOrderByVersionDesc(itemId, merchantId).stream()
                .map(p -> new CatalogDtos.PriceVersionDto(p.getVersion(), p.getPricePerSaleUnitRwf(), p.getSaleUnit().code(),
                        p.getEffectiveAt(), p.getReason()))
                .toList();
    }

    // ---------------------------------------------------------------------------------------------
    // Items
    // ---------------------------------------------------------------------------------------------

    @Transactional
    public CatalogDtos.ItemDto create(UUID merchantId, CatalogDtos.CreateItemRequest request) {
        Actor actor = require(merchantId, Permission.CATALOG_MANAGE);
        Units units = unitsForNewItem(request.itemType(), request.measurementDimension(), request.saleUnit());
        String code = normalizeCode(request.code());
        if (code != null && items.existsByMerchantIdAndCode(merchantId, code)) {
            throw duplicateCode();
        }
        long price = wholeRwf(request.pricePerSaleUnitRwf());
        var now = clock.instant();
        CatalogItem item = saveItem(new CatalogItem(UUID.randomUUID(), merchantId, request.itemType(), request.name().trim(),
                blankToNull(request.description()), code, request.active() == null || request.active(), units.dimension(),
                units.stock(), units.sale(), price, actor.userId(), now));
        // The item is flushed first: its current-price key is a DEFERRED foreign key, satisfied by this row at commit.
        prices.saveAndFlush(new CatalogPrice(item.getId(), merchantId, 1, price, units.sale(), null, actor.userId(), now));
        audit.record(merchantId, actor.userId(), "CATALOG_ITEM_CREATED", "catalog_item", item.getId(),
                request.itemType() + " item \"" + item.getName() + "\" created, " + describePrice(price, units.sale()) + ".");
        return toDto(item, List.of());
    }

    @Transactional
    public CatalogDtos.ItemDto update(UUID merchantId, UUID itemId, CatalogDtos.UpdateItemRequest request) {
        Actor actor = require(merchantId, Permission.CATALOG_MANAGE);
        CatalogItem item = lock(merchantId, itemId);
        requireVersion(item.getVersion(), request.expectedVersion(), "item");
        MeasurementUnit saleUnit = saleUnitForUpdate(item, request.saleUnit());
        String name = request.name().trim();
        String description = blankToNull(request.description());
        String code = normalizeCode(request.code());
        if (code != null && items.existsByMerchantIdAndCodeAndIdNot(merchantId, code, itemId)) {
            throw duplicateCode();
        }
        long price = wholeRwf(request.pricePerSaleUnitRwf());
        boolean described = !name.equals(item.getName()) || !Objects.equals(description, item.getDescription())
                || !Objects.equals(code, item.getCode());
        boolean repriced = price != item.getPricePerSaleUnitRwf() || saleUnit != item.getSaleUnit();
        if (!described && !repriced) {
            return toDto(item);
        }
        var now = clock.instant();
        String before = describePrice(item.getPricePerSaleUnitRwf(), item.getSaleUnit());
        if (described) {
            item.describe(name, description, code, now);
        }
        int priceVersion = repriced ? item.reprice(saleUnit, price, now) : item.getCurrentPriceVersion();
        item = saveItem(item);
        if (repriced) {
            prices.saveAndFlush(new CatalogPrice(itemId, merchantId, priceVersion, price, saleUnit, blankToNull(request.priceChangeReason()),
                    actor.userId(), now));
            audit.record(merchantId, actor.userId(), "CATALOG_PRICE_CHANGED", "catalog_item", itemId,
                    "Price of \"" + item.getName() + "\" changed from " + before + " to " + describePrice(price, saleUnit)
                            + " (price version " + priceVersion + ").");
        }
        if (described) {
            audit.record(merchantId, actor.userId(), "CATALOG_ITEM_UPDATED", "catalog_item", itemId,
                    "Item \"" + item.getName() + "\" updated.");
        }
        return toDto(item);
    }

    /** Items are deactivated, never deleted; deactivating changes nothing already recorded. */
    @Transactional
    public CatalogDtos.ItemDto changeStatus(UUID merchantId, UUID itemId, CatalogDtos.StatusRequest request) {
        Actor actor = require(merchantId, Permission.CATALOG_MANAGE);
        CatalogItem item = lock(merchantId, itemId);
        requireVersion(item.getVersion(), request.expectedVersion(), "item");
        if (item.isActive() == request.active()) {
            return toDto(item);
        }
        item.setActive(request.active(), clock.instant());
        item = saveItem(item);
        audit.record(merchantId, actor.userId(), request.active() ? "CATALOG_ITEM_ACTIVATED" : "CATALOG_ITEM_DEACTIVATED",
                "catalog_item", itemId, "Item \"" + item.getName() + "\" " + (request.active() ? "activated" : "deactivated") + ".");
        return toDto(item);
    }

    // ---------------------------------------------------------------------------------------------
    // Packages
    // ---------------------------------------------------------------------------------------------

    @Transactional
    public CatalogDtos.PackageDto createPackage(UUID merchantId, UUID itemId, CatalogDtos.CreatePackageRequest request) {
        Actor actor = require(merchantId, Permission.CATALOG_MANAGE);
        CatalogItem item = lock(merchantId, itemId);
        requireGoods(item);
        if (packages.countByItemId(itemId) >= MAX_PACKAGES_PER_ITEM) {
            throw ApiException.validation("An item can have at most " + MAX_PACKAGES_PER_ITEM + " packages.");
        }
        String label = request.label().trim();
        BigDecimal quantity = canonicalQuantity(item, request.contentsAmount(), request.contentsUnit());
        if (packages.labelTaken(itemId, label.toLowerCase(Locale.ROOT))) {
            throw duplicateLabel();
        }
        CatalogPackage created = savePackage(new CatalogPackage(itemId, merchantId, item.getMeasurementDimension(), label, quantity,
                clock.instant()));
        audit.record(merchantId, actor.userId(), "CATALOG_PACKAGE_CREATED", "catalog_package", created.getId(),
                "Package \"" + label + "\" (" + request.contentsAmount().trim() + " " + request.contentsUnit().trim().toLowerCase(Locale.ROOT)
                        + ") added to \"" + item.getName() + "\".");
        return toDto(item, created);
    }

    @Transactional
    public CatalogDtos.PackageDto updatePackage(UUID merchantId, UUID itemId, UUID packageId, CatalogDtos.UpdatePackageRequest request) {
        Actor actor = require(merchantId, Permission.CATALOG_MANAGE);
        CatalogItem item = lock(merchantId, itemId);
        requireGoods(item);
        CatalogPackage pack = packages.findByIdAndItemIdAndMerchantId(packageId, itemId, merchantId)
                .orElseThrow(() -> ApiException.notFound("This package could not be found."));
        requireVersion(pack.getVersion(), request.expectedVersion(), "package");
        String label = request.label().trim();
        BigDecimal quantity = canonicalQuantity(item, request.contentsAmount(), request.contentsUnit());
        if (packages.labelTakenByAnother(itemId, label.toLowerCase(Locale.ROOT), packageId)) {
            throw duplicateLabel();
        }
        boolean active = request.active();
        if (label.equals(pack.getLabel()) && quantity.compareTo(pack.getQuantityPerPackage()) == 0 && active == pack.isActive()) {
            return toDto(item, pack);
        }
        pack.redefine(label, quantity, active, clock.instant());
        pack = savePackage(pack);
        audit.record(merchantId, actor.userId(), "CATALOG_PACKAGE_UPDATED", "catalog_package", packageId,
                "Package \"" + label + "\" of \"" + item.getName() + "\" updated" + (active ? "." : " and deactivated."));
        return toDto(item, pack);
    }

    // ---------------------------------------------------------------------------------------------
    // Rules
    // ---------------------------------------------------------------------------------------------

    private record Units(MeasurementDimension dimension, MeasurementUnit stock, MeasurementUnit sale) {}

    /** GOODS need a dimension and a sale unit of that dimension; a SERVICE has neither (it is counted per service). */
    private static Units unitsForNewItem(CatalogItemType type, String dimensionText, String saleUnitText) {
        if (type == CatalogItemType.SERVICE) {
            requireServiceUnits(dimensionText, saleUnitText);
            return new Units(MeasurementDimension.COUNT, null, MeasurementUnit.PIECE);
        }
        if (isBlank(dimensionText) || isBlank(saleUnitText)) {
            throw invalidUnits("Goods need a measurement type and a selling unit.");
        }
        MeasurementDimension dimension = parseDimension(dimensionText);
        MeasurementUnit sale = MeasurementUnit.fromCode(saleUnitText);
        if (sale.dimension() != dimension) {
            throw invalidUnits("That selling unit does not match the measurement type.");
        }
        return new Units(dimension, dimension.canonicalUnit(), sale);
    }

    private static MeasurementUnit saleUnitForUpdate(CatalogItem item, String saleUnitText) {
        if (item.getItemType() == CatalogItemType.SERVICE) {
            requireServiceUnits(null, saleUnitText);
            return MeasurementUnit.PIECE;
        }
        if (isBlank(saleUnitText)) {
            throw invalidUnits("Goods need a selling unit.");
        }
        MeasurementUnit sale = MeasurementUnit.fromCode(saleUnitText);
        if (sale.dimension() != item.getMeasurementDimension()) {
            throw invalidUnits("That selling unit does not match the measurement type of this item.");
        }
        return sale;
    }

    private static void requireServiceUnits(String dimensionText, String saleUnitText) {
        boolean dimensionOk = isBlank(dimensionText) || MeasurementDimension.COUNT.name().equals(dimensionText.trim().toUpperCase(Locale.ROOT));
        boolean unitOk = isBlank(saleUnitText) || MeasurementUnit.PIECE.code().equals(saleUnitText.trim().toLowerCase(Locale.ROOT));
        if (!dimensionOk || !unitOk) {
            throw invalidUnits("A service is priced per service and has no measurement unit.");
        }
    }

    private static MeasurementDimension parseDimension(String text) {
        try {
            return MeasurementDimension.valueOf(text.trim().toUpperCase(Locale.ROOT));
        } catch (IllegalArgumentException e) {
            throw invalidUnits("That measurement type is not supported.");
        }
    }

    /** The exact canonical quantity one package holds, from text such as "25" and a unit such as "kg". Never rounds. */
    private static BigDecimal canonicalQuantity(CatalogItem item, String amountText, String unitCode) {
        MeasurementUnit unit = MeasurementUnit.fromCode(unitCode);
        if (unit.dimension() != item.getMeasurementDimension()) {
            throw new MeasurementException(MeasurementException.Reason.DIMENSION_MISMATCH,
                    "That unit does not measure this item.");
        }
        MeasuredQuantity contents = MeasuredQuantity.parse(amountText, unit);
        PackageConversion conversion = PackageConversion.of(contents.amount(), unit);
        return conversion.canonicalPerPackage().setScale(QuantityPrecision.SCALE, RoundingMode.UNNECESSARY);
    }

    /**
     * A price is whole RWF. A fraction is rejected (400), never truncated or rounded: a price of 10.5 is a client error, not 10.
     * Range was already checked by validation, so this cannot expand an enormous exponent.
     */
    static long wholeRwf(BigDecimal price) {
        if (price.stripTrailingZeros().scale() > 0) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "bad_request", "The price must be a whole number of RWF.");
        }
        return price.longValueExact();
    }

    private static void requireGoods(CatalogItem item) {
        if (item.getItemType() != CatalogItemType.GOODS) {
            throw invalidUnits("Only goods can have packages.");
        }
    }

    private static void requireVersion(long actual, long expected, String what) {
        if (actual != expected) {
            throw ApiException.conflict("version_conflict", "This " + what + " was changed by someone else. Reload it and try again.");
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Plumbing
    // ---------------------------------------------------------------------------------------------

    /** Authorises, then confirms the business works in BUSINESS mode. */
    private Actor require(UUID merchantId, Permission permission) {
        Actor actor = access.require(merchantId, permission);
        if (settings.operatingModeOf(merchantId) != OperatingMode.BUSINESS) {
            throw ApiException.invalidState("catalog_unavailable", "The catalog is available to businesses in business mode.");
        }
        return actor;
    }

    private CatalogItem find(UUID merchantId, UUID itemId) {
        return items.findByIdAndMerchantId(itemId, merchantId).orElseThrow(CatalogService::itemNotFound);
    }

    private CatalogItem lock(UUID merchantId, UUID itemId) {
        return items.lockByIdAndMerchantId(itemId, merchantId).orElseThrow(CatalogService::itemNotFound);
    }

    private static ApiException itemNotFound() {
        return ApiException.notFound("This item could not be found.");
    }

    private CatalogItem saveItem(CatalogItem item) {
        try {
            return items.saveAndFlush(item);
        } catch (DataIntegrityViolationException e) {
            if (isUniqueViolation(e)) {
                throw duplicateCode();
            }
            throw e;
        }
    }

    private CatalogPackage savePackage(CatalogPackage pack) {
        try {
            return packages.saveAndFlush(pack);
        } catch (DataIntegrityViolationException e) {
            if (isUniqueViolation(e)) {
                throw duplicateLabel();
            }
            throw e;
        }
    }

    private static boolean isUniqueViolation(DataIntegrityViolationException e) {
        return DatabaseErrors.sqlState(e).filter(UNIQUE_VIOLATION::equals).isPresent();
    }

    private static ApiException duplicateCode() {
        return ApiException.conflict("duplicate_code", "Another item in this business already uses that code.");
    }

    private static ApiException duplicateLabel() {
        return ApiException.conflict("duplicate_label", "This item already has a package with that name.");
    }

    private static ApiException invalidUnits(String message) {
        return new ApiException(HttpStatus.UNPROCESSABLE_CONTENT, "invalid_unit_configuration", message);
    }

    private static String normalizeCode(String code) {
        return isBlank(code) ? null : code.trim().toUpperCase(Locale.ROOT);
    }

    private static String blankToNull(String text) {
        return isBlank(text) ? null : text.trim();
    }

    private static boolean isBlank(String text) {
        return text == null || text.isBlank();
    }

    private static String escapeLike(String text) {
        return text.replace("!", "!!").replace("%", "!%").replace("_", "!_");
    }

    private static String describePrice(long rwf, MeasurementUnit unit) {
        return rwf + " RWF per " + unit.code();
    }

    private static String displayName(MeasurementUnit unit) {
        return switch (unit) {
            case PIECE -> "Piece";
            case GRAM -> "Gram";
            case KILOGRAM -> "Kilogram";
            case MILLILITER -> "Milliliter";
            case LITER -> "Liter";
            case MILLIMETER -> "Millimeter";
            case METER -> "Meter";
            case SQUARE_MILLIMETER -> "Square millimeter";
            case SQUARE_METER -> "Square meter";
        };
    }

    private CatalogDtos.ItemDto toDto(CatalogItem item) {
        return toDto(item, packages.findForItems(List.of(item.getId()), item.getMerchantId()));
    }

    private static CatalogDtos.ItemDto toDto(CatalogItem item, List<CatalogPackage> itemPackages) {
        return new CatalogDtos.ItemDto(item.getId(), item.getMerchantId(), item.getItemType(), item.getName(), item.getDescription(),
                item.getCode(), item.isActive(), item.getMeasurementDimension().name(),
                item.getStockUnit() == null ? null : item.getStockUnit().code(), item.getSaleUnit().code(),
                item.getPricePerSaleUnitRwf(), item.getCurrentPriceVersion(),
                itemPackages.stream().map(p -> toDto(item, p)).toList(), item.getCreatedAt(), item.getUpdatedAt(), item.getVersion());
    }

    private static CatalogDtos.PackageDto toDto(CatalogItem item, CatalogPackage pack) {
        MeasurementUnit canonical = item.getMeasurementDimension().canonicalUnit();
        MeasuredQuantity quantity = new MeasuredQuantity(pack.getQuantityPerPackage(), canonical);
        return new CatalogDtos.PackageDto(pack.getId(), pack.getItemId(), pack.getLabel(), quantity.amount().toPlainString(),
                canonical.code(), quantity.to(item.getSaleUnit()).amount().toPlainString(), pack.isActive(), pack.getCreatedAt(),
                pack.getUpdatedAt(), pack.getVersion());
    }
}
