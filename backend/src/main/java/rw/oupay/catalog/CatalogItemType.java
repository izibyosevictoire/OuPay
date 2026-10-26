package rw.oupay.catalog;

/** What a catalog item is. A business in BUSINESS mode manages both kinds in the same catalog. */
public enum CatalogItemType {
    /** A physical product, measured in a stock dimension (and, later, stocked). */
    GOODS,
    /** Something done for a customer. It has no stock and is counted per service unit. */
    SERVICE
}
