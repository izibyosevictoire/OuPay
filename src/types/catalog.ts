/** GOODS are physical things sold by a measured unit; a SERVICE is priced per service unit and has no stock. */
export type CatalogItemType = 'GOODS' | 'SERVICE'

export type MeasurementDimension = 'COUNT' | 'MASS' | 'VOLUME' | 'LENGTH' | 'AREA'

/** Lower-case unit codes used on the wire. */
export type MeasurementUnitCode = 'pc' | 'g' | 'kg' | 'ml' | 'l' | 'mm' | 'm' | 'mm2' | 'm2'

export interface MeasurementUnitOption {
  dimension: MeasurementDimension
  /** The unit stock is held in for this dimension. */
  canonicalUnit: MeasurementUnitCode
  /** COUNT: a fraction of a piece is not a quantity. */
  wholeUnitsOnly: boolean
  units: { code: MeasurementUnitCode; name: string }[]
}

/** A convenient multiple of the item's stock quantity, defined per product. It carries no price of its own. */
export interface CatalogPackage {
  id: string
  itemId: string
  label: string
  /** Plain decimal text: how much stock (in the canonical unit) one package holds. */
  quantityPerPackage: string
  canonicalUnit: MeasurementUnitCode
  /** The same quantity expressed in the item's current sale unit; exact. */
  quantityInSaleUnit: string
  active: boolean
  createdAt: string
  updatedAt: string
  version: number
}

export interface CatalogItem {
  id: string
  merchantId: string
  itemType: CatalogItemType
  name: string
  description: string | null
  /** Unique per business, stored upper-case. */
  code: string | null
  active: boolean
  /** Immutable after creation. */
  measurementDimension: MeasurementDimension
  /** Immutable after creation. Null for services. */
  stockUnit: MeasurementUnitCode | null
  saleUnit: MeasurementUnitCode
  /** Whole RWF for ONE sale unit (one kg, one litre, one piece, or one service unit). */
  pricePerSaleUnitRwf: number
  priceVersion: number
  packages: CatalogPackage[]
  createdAt: string
  updatedAt: string
  version: number
}

export interface CatalogItemPage {
  items: CatalogItem[]
  nextCursor: string | null
  totalCount: number | null
}

export interface PriceVersion {
  version: number
  pricePerSaleUnitRwf: number
  saleUnit: MeasurementUnitCode
  effectiveAt: string
  reason: string | null
}

export interface ListCatalogItemsQuery {
  limit?: number
  cursor?: string | null
  q?: string
  type?: CatalogItemType
  active?: boolean
}

export interface CreateCatalogItemInput {
  itemType: CatalogItemType
  name: string
  description?: string
  code?: string
  /** GOODS only. */
  measurementDimension?: MeasurementDimension
  /** GOODS only. */
  saleUnit?: MeasurementUnitCode
  pricePerSaleUnitRwf: number
  active?: boolean
}

export interface UpdateCatalogItemInput {
  expectedVersion: number
  name: string
  description?: string
  code?: string
  /** GOODS only (must stay within the item's dimension). */
  saleUnit?: MeasurementUnitCode
  pricePerSaleUnitRwf: number
  priceChangeReason?: string
}

export interface ChangeCatalogItemStatusInput {
  expectedVersion: number
  active: boolean
}

export interface CreateCatalogPackageInput {
  label: string
  /** Plain decimal text, for example "24" or "0.75". Never a floating-point number. */
  contentsAmount: string
  contentsUnit: MeasurementUnitCode
}

export interface UpdateCatalogPackageInput extends CreateCatalogPackageInput {
  expectedVersion: number
  active: boolean
}

/**
 * The explicit TAX CLASSIFICATION of a catalog item (R7b). NONE is a real state and BLOCKS POS billing: nothing is defaulted or guessed.
 * Whether a configured treatment may be BILLED is a separate approval (`approvedForPos`). OuPay makes no claim of tax compliance.
 */
export type ItemTaxCategory = 'NOT_APPLICABLE' | 'EXEMPT' | 'ZERO_RATED' | 'STANDARD'

export interface ItemTax {
  itemId: string
  /** The item's version: an optimistic check for the next change. */
  version: number
  configured: boolean
  taxCategory: ItemTaxCategory | null
  taxRateBp: number | null
  approvedForPos: boolean
  configuredAt: string | null
}

export interface SetItemTaxInput {
  expectedVersion: number
  taxCategory: ItemTaxCategory
  /** Basis points: 1800 is 18.00%. Only STANDARD has a rate. */
  taxRateBp: number
}
