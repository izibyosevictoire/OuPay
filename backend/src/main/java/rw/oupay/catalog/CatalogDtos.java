package rw.oupay.catalog;

import jakarta.validation.constraints.DecimalMax;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * Wire shapes of the catalog. The merchant is always taken from the URL, never from a body. Quantities travel as plain decimal
 * STRINGS (never JSON numbers, which a browser would round); prices are whole RWF.
 */
public final class CatalogDtos {

    /** Empty is allowed and means "no code". */
    static final String CODE_PATTERN = "^(|[A-Za-z0-9][A-Za-z0-9._-]{0,39})$";
    static final String CODE_MESSAGE = "The code must be 1 to 40 letters, digits, dots, dashes or underscores.";

    private CatalogDtos() {}

    /**
     * Prices are received as exact decimals and checked to be WHOLE rwf by the service (400 otherwise): a JSON number such as
     * 10.5 must never be truncated to 10 by the JSON mapper, which silently coerces floats into a {@code long}.
     */
    /**
     * The price arrives as an exact decimal and the service requires it to be whole RWF (400 otherwise). Declaring it as a Java
     * long would let the JSON mapper silently truncate 10.5 to 10.
     */
    /**
     * {@code measurementDimension} and {@code saleUnit} are required for GOODS and must be omitted for a SERVICE (a service is
     * counted per service unit and has no stock).
     */
    public record CreateItemRequest(
            @NotNull CatalogItemType itemType,
            @NotBlank @Size(max = 120) String name,
            @Size(max = 500) String description,
            @Size(max = 40) @Pattern(regexp = CODE_PATTERN, message = CODE_MESSAGE) String code,
            @Size(max = 8) String measurementDimension,
            @Size(max = 8) String saleUnit,
            @NotNull @DecimalMin(value = "0", message = "The price cannot be negative.")
            @DecimalMax(value = "1000000000", message = "The price is too large.") BigDecimal pricePerSaleUnitRwf,
            Boolean active) {}

    /** The item type, dimension and stock unit cannot be changed, so they are not part of an update. */
    public record UpdateItemRequest(
            @NotNull Long expectedVersion,
            @NotBlank @Size(max = 120) String name,
            @Size(max = 500) String description,
            @Size(max = 40) @Pattern(regexp = CODE_PATTERN, message = CODE_MESSAGE) String code,
            @Size(max = 8) String saleUnit,
            @NotNull @DecimalMin(value = "0", message = "The price cannot be negative.")
            @DecimalMax(value = "1000000000", message = "The price is too large.") BigDecimal pricePerSaleUnitRwf,
            @Size(max = 200) String priceChangeReason) {}

    public record StatusRequest(@NotNull Long expectedVersion, @NotNull Boolean active) {}

    /** "One carton holds 24 pc": the amount is a plain decimal string in {@code contentsUnit}. */
    public record CreatePackageRequest(
            @NotBlank @Size(max = 60) String label,
            @NotBlank @Size(max = 60) String contentsAmount,
            @NotBlank @Size(max = 8) String contentsUnit) {}

    public record UpdatePackageRequest(
            @NotNull Long expectedVersion,
            @NotBlank @Size(max = 60) String label,
            @NotBlank @Size(max = 60) String contentsAmount,
            @NotBlank @Size(max = 8) String contentsUnit,
            @NotNull Boolean active) {}

    /**
     * {@code quantityPerPackage} is canonical (the item's stock unit); {@code quantityInSaleUnit} is the same exact quantity
     * in the item's CURRENT sale unit, so a client never has to convert.
     */
    public record PackageDto(UUID id, UUID itemId, String label, String quantityPerPackage, String canonicalUnit,
                             String quantityInSaleUnit, boolean active, Instant createdAt, Instant updatedAt, long version) {}

    public record ItemDto(UUID id, UUID merchantId, CatalogItemType itemType, String name, String description, String code,
                          boolean active, String measurementDimension, String stockUnit, String saleUnit,
                          long pricePerSaleUnitRwf, int priceVersion, List<PackageDto> packages, Instant createdAt,
                          Instant updatedAt, long version) {}

    public record PriceVersionDto(int version, long pricePerSaleUnitRwf, String saleUnit, Instant effectiveAt, String reason) {}

    public record UnitDto(String code, String name) {}

    public record MeasurementUnitOption(String dimension, String canonicalUnit, boolean wholeUnitsOnly, List<UnitDto> units) {}
}
