import type { CatalogItemType, MeasurementDimension, MeasurementUnitCode } from './catalog'
import type { CodeSale } from './codeCheckout'

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
  /** PHYSICAL stock, in the canonical unit. */
  onHand: string | null
  canonicalUnit: MeasurementUnitCode
  onHandInSaleUnit: string | null
  /** Stock reserved for sales already billed (R7b). Available = physical - reserved. */
  reserved?: string | null
  available?: string | null
  availableInSaleUnit?: string | null
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
  reserved?: string | null
  available?: string | null
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

export type PosDraftStatus = 'DRAFT' | 'DISCARDED' | 'BILLED'

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

// ---- Billing (R7b) ------------------------------------------------------------------------------------------------
//
// BILLING turns a reviewed draft into an issued invoice, a fixed-amount payment request through the cashier's collection code and a
// RESERVATION of the goods, atomically. The browser sends only the draft, the version and total it reviewed, and (optionally) the code:
// the server re-reads prices, tax and stock and refuses the bill if what it computes is not what was reviewed. "Reserved" is not "sold",
// and nothing here is ever "paid" until verified reconciliation says so.

export type PosTaxCategory = 'NOT_APPLICABLE' | 'EXEMPT' | 'ZERO_RATED' | 'STANDARD'

/** Stock for one goods line at review time: physical, reserved and available are kept apart (available = physical - reserved). */
export interface PosAvailability {
  state: PosStockCheckState
  physical: string | null
  reserved: string | null
  available: string | null
  requested: string | null
  canonicalUnit: MeasurementUnitCode
}

export interface PosReviewLine {
  lineNo: number
  itemId: string
  name: string
  code: string | null
  enteredQuantity: string
  enteredUnit: MeasurementUnitCode | null
  packageLabel: string | null
  saleUnit: MeasurementUnitCode
  quantityInSaleUnit: string
  canonicalQuantity: string
  canonicalUnit: MeasurementUnitCode
  priceVersion: number
  unitPriceRwf: number
  /** What the draft was SAVED at, so a change is visible. */
  draftPriceVersion: number
  draftUnitPriceRwf: number
  priceChangedSinceDraft: boolean
  taxCategory: PosTaxCategory | null
  taxRateBp: number | null
  taxApproved: boolean
  netRwf: number
  taxRwf: number
  lineTotalRwf: number
  availability: PosAvailability
}

/** `lineNo` is 0 for a problem of the whole bill (no code, no branch...). */
export interface PosBillingProblem {
  lineNo: number
  code: string
  message: string
}

export type PosBillMode = 'LIVE' | 'DEMONSTRATION' | 'UNAVAILABLE'

export interface PosBillingReview {
  draftId: string
  draftVersion: number
  branchId: string
  branchName: string
  lines: PosReviewLine[]
  problems: PosBillingProblem[]
  subtotalRwf: number
  taxRwf: number
  totalRwf: number
  billable: boolean
  mode: PosBillMode
  codeLabel: string | null
  modeNote: string
  stockNote: string
  taxNote: string
  approvedTaxTreatments: string[]
}

export interface PosBillInput {
  /** The version of the draft that was reviewed. */
  expectedDraftVersion: number
  /** The total that was reviewed: the bill is refused (`review_changed`) when the server computes another. */
  reviewedTotalRwf: number
  collectionCodeId?: string | null
  /** The transport retry key: reused when the SAME bill is retried after a lost answer. */
  idempotencyKey: string
}

export interface PosSaleLine {
  lineNo: number
  itemId: string
  itemType: 'GOODS' | 'SERVICE'
  name: string
  code: string | null
  enteredQuantity: string
  enteredUnit: MeasurementUnitCode | null
  packageLabel: string | null
  saleUnit: MeasurementUnitCode
  quantityInSaleUnit: string
  canonicalQuantity: string
  canonicalUnit: MeasurementUnitCode
  priceVersion: number
  unitPriceRwf: number
  taxCategory: PosTaxCategory
  taxRateBp: number
  netRwf: number
  taxRwf: number
  lineTotalRwf: number
}

export interface PosReservationLine {
  itemId: string
  name: string
  quantity: string
  canonicalUnit: MeasurementUnitCode | ''
  enteredQuantity: string
  enteredUnit: MeasurementUnitCode | null
  packageLabel: string | null
}

/** RESERVED is not sold, and not paid. NOT_RESERVED: a demonstration, or a sale of services only. */
export type PosReservationState = 'RESERVED' | 'FULFILLED' | 'RELEASED' | 'NOT_RESERVED'

export interface PosReservation {
  state: PosReservationState
  note: string
  expiryReviewAt: string | null
  releasedAt: string | null
  releaseReason: string | null
  lines: PosReservationLine[]
}

/** The sale's payment side (reference, code, status) is the existing code-sale view: nothing is paid until verified reconciliation says so. */
export interface PosBilledSale {
  sale: CodeSale
  draftId: string
  mode: 'LIVE' | 'DEMONSTRATION'
  lines: PosSaleLine[]
  subtotalRwf: number
  taxRwf: number
  totalRwf: number
  reservation: PosReservation
  taxNote: string
}
