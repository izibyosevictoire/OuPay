import type { CatalogItemType, MeasurementDimension, MeasurementUnitCode } from './catalog'

/**
 * Business POS billing (R7a): a cart of goods and services priced from the catalog and saved as a DRAFT.
 *
 * A POS draft is a checkout INTENT, not a sale: it is not an invoice, nothing is payable, no payment request exists, and no
 * stock is reserved or deducted. Stock shown here is informational and is checked again when the cart is billed.
 *
 * QUANTITIES are plain decimal STRINGS (never numbers): the server converts them exactly and refuses, never rounds, what the
 * bill cannot hold. PRICES are whole RWF and are NEVER sent by the browser: a line names an item and the price VERSION the
 * cashier saw, and the server prices it from the catalog's current version.
 */

/** READY, or the first thing that stops this person from preparing a sale. */
export type PosReadiness = 'READY' | 'NOT_BUSINESS' | 'NO_BRANCH'

export interface PosBranchChoice {
  id: string
  name: string
  code: string
}

export interface PosOptions {
  readiness: PosReadiness
  /** Branches THIS person may prepare a sale at. */
  branches: PosBranchChoice[]
  maxLines: number
  stockNote: string
}

export interface PosPackageOption {
  id: string
  label: string
  /** Stock held by one package, in the canonical unit. */
  quantityPerPackage: string
  canonicalUnit: MeasurementUnitCode
  /** The same quantity in the item's selling unit. Exact. */
  quantityInSaleUnit: string
}

/** NOT_TRACKED (a service), RECORDED (a balance exists at the branch) or NO_RECORD (stock was never recorded there). */
export type PosStockState = 'NOT_TRACKED' | 'RECORDED' | 'NO_RECORD'

export interface PosStockInfo {
  state: PosStockState
  onHand: string | null
  canonicalUnit: MeasurementUnitCode
  onHandInSaleUnit: string | null
}

export interface PosCatalogItem {
  itemId: string
  itemType: CatalogItemType
  name: string
  code: string | null
  measurementDimension: MeasurementDimension
  saleUnit: MeasurementUnitCode
  /** Every unit of the item's dimension a quantity may be entered in. */
  units: MeasurementUnitCode[]
  pricePerSaleUnitRwf: number
  priceVersion: number
  packages: PosPackageOption[]
  stock: PosStockInfo
}

/** One cart line as the cashier entered it. Either `unit` or `packageId`, never both. */
export interface PosLineInput {
  itemId: string
  quantity: string
  unit?: MeasurementUnitCode | null
  packageId?: string | null
  /** The price version the cashier saw. */
  expectedPriceVersion: number
}

export interface PosQuoteInput {
  branchId: string
  lines: PosLineInput[]
}

export interface PosDraftInput {
  /** The draft's permanent identifier: reused when the SAME cart is retried, so a retry can never make a second draft. */
  clientRequestId: string
  /** The transport retry key; travels in a header. */
  idempotencyKey: string
  branchId: string
  note?: string
  lines: PosLineInput[]
}

export interface PosDraftUpdateInput {
  expectedVersion: number
  note?: string
  lines: PosLineInput[]
}

/** Informational only. A statement about this moment: nothing is held, and billing checks again. */
export type PosStockCheckState = 'NOT_TRACKED' | 'SUFFICIENT' | 'INSUFFICIENT' | 'NO_STOCK_RECORD'

export interface PosStockCheck {
  state: PosStockCheckState
  onHand: string | null
  /** The total requested for this item across the whole cart, in the canonical unit. */
  requested: string | null
  canonicalUnit: MeasurementUnitCode
}

export interface PosPricedLine {
  lineNo: number
  itemId: string
  itemType: CatalogItemType
  name: string
  code: string | null
  measurementDimension: MeasurementDimension
  enteredQuantity: string
  enteredUnit: MeasurementUnitCode | null
  packageId: string | null
  packageLabel: string | null
  saleUnit: MeasurementUnitCode
  quantityInSaleUnit: string
  canonicalQuantity: string
  canonicalUnit: MeasurementUnitCode
  priceVersion: number
  unitPriceRwf: number
  lineTotalRwf: number
  stock: PosStockCheck | null
}

/** Why one line can not be priced. `price_changed` carries the current version and price so the cashier can accept them. */
export interface PosProblem {
  lineIndex: number
  code: string
  message: string
  currentPriceVersion: number | null
  currentPriceRwf: number | null
}

export interface PosQuote {
  branchId: string
  branchName: string
  lines: PosPricedLine[]
  problems: PosProblem[]
  totalRwf: number
  currency: 'RWF'
  stockNote: string
  /** The total is PROVISIONAL: no tax is calculated, and prices are rechecked when billing. */
  taxNote: string
}

export type PosDraftStatus = 'DRAFT' | 'DISCARDED'

export interface PosDraft {
  id: string
  merchantId: string
  branchId: string
  branchName: string
  status: PosDraftStatus
  note: string | null
  lines: PosPricedLine[]
  totalRwf: number
  currency: 'RWF'
  createdByName: string
  createdAt: string
  updatedAt: string
  version: number
  /** "A POS draft is not a sale ...": always shown beside a draft. */
  notice: string
  stockNote: string
  /** The total is PROVISIONAL: no tax is calculated, and prices are rechecked when billing. */
  taxNote: string
}

export interface PosDraftSummary {
  id: string
  branchId: string
  branchName: string
  status: PosDraftStatus
  lineCount: number
  totalRwf: number
  createdByName: string
  createdAt: string
  updatedAt: string
  version: number
}

export interface PosDraftPage {
  items: PosDraftSummary[]
  nextCursor: string | null
}
