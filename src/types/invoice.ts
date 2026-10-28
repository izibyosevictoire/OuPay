import type { MerchantOwned } from './merchant'
import type { InvoicePaymentSummary } from './payment'

/**
 * MONEY: every amount on an invoice is an INTEGER in the currency's minor unit.
 * RWF has no minor unit in everyday use (exponent 0), so 1 unit = 1 franc and
 * `unitPrice: 2500` means RWF 2,500. No floating-point money anywhere; see
 * `lib/invoiceCalculations.ts` for the arithmetic and rounding rules.
 */
export type InvoiceCurrency = 'RWF'

/**
 * Commercial lifecycle of the invoice document. Payment is tracked separately.
 * DRAFT -> ISSUED | CANCELLED, ISSUED -> VOIDED (owner, unpaid only). CANCELLED and
 * VOIDED are final. Nothing is ever deleted.
 */
export type InvoiceStatus = 'DRAFT' | 'ISSUED' | 'CANCELLED' | 'VOIDED'

/**
 * Settlement state. READ-ONLY in the UI and never set by issuing, cancelling or any button:
 * only bank-confirmed payment reconciliation (a future integration) may change it.
 * PARTIALLY_PAID, OVERPAID and REFUNDED are reserved for that future work.
 */
export type InvoicePaymentStatus = 'UNPAID' | 'PARTIALLY_PAID' | 'PAID' | 'OVERPAID' | 'REFUNDED'

/** Whether item prices exclude or already include tax. Chosen per invoice and stored with it. */
export type TaxMode = 'EXCLUSIVE' | 'INCLUSIVE'

/**
 * Tax treatment of one line. `category` is deliberately explicit so a future RRA EBM/VSDC
 * integration can map it to fiscal tax codes without restructuring invoices. Only STANDARD
 * (and custom rates, which are STANDARD with another `rateBp`) carry a non-zero rate.
 */
export type TaxCategory = 'NOT_APPLICABLE' | 'EXEMPT' | 'ZERO_RATED' | 'STANDARD'

export interface TaxRate {
  category: TaxCategory
  /** Rate in basis points: 1800 = 18.00%. Always 0 unless the category is STANDARD. */
  rateBp: number
}

/** What a user enters for a line; the totals are always computed, never trusted from input. */
export interface InvoiceItemInput {
  description: string
  /** Up to 3 decimal places (e.g. 1.5 kg). */
  quantity: number
  /** Minor units, per one unit of quantity, on the invoice's tax basis (see TaxMode). */
  unitPrice: number
  /** Fixed discount for the whole line, minor units. */
  discount: number
  taxRate: TaxRate
}

export interface InvoiceItem extends InvoiceItemInput {
  id: string
  /** Line amount excluding tax, after discount. Stored so historical tax stays exact. */
  netAmount: number
  taxAmount: number
  /** netAmount + taxAmount: what the customer pays for this line. */
  lineTotal: number
}

/** Customer details as they were when the invoice was written (no CRM, no live link). */
export interface InvoiceCustomer {
  name: string
  email?: string
  phoneNumber?: string
  address?: string
  tin?: string
}

/** Merchant details frozen onto the invoice so later profile edits never rewrite history. */
export interface MerchantSnapshot {
  legalName: string
  tradingName?: string
  tin?: string
  registrationNumber?: string
  address: string
  phoneNumber?: string
  email?: string
}

export interface BranchSnapshot {
  name: string
  code: string
  address: string
}

/**
 * A commercial invoice record. It is NOT a fiscal document: RRA EBM/EIS fiscal documents
 * will be separate records that reference `id`, so nothing fiscal lives here.
 *
 * Totals identity (all integers):
 * - EXCLUSIVE: grandTotal = subtotal - discountTotal + taxTotal
 * - INCLUSIVE: grandTotal = subtotal - discountTotal   (taxTotal is the portion already inside)
 */
export interface Invoice extends MerchantOwned {
  id: string
  branchId: string
  /** Unique per merchant, never reused, even for cancelled or voided invoices. */
  invoiceNumber: string
  createdByUserId: string
  /** The cashier / sales agent responsible. Historical: later staff changes never rewrite it. */
  assignedToUserId: string
  createdByName: string
  assignedToName: string
  customer: InvoiceCustomer
  merchantSnapshot: MerchantSnapshot
  branchSnapshot: BranchSnapshot
  items: InvoiceItem[]
  currency: InvoiceCurrency
  taxMode: TaxMode
  subtotal: number
  discountTotal: number
  taxTotal: number
  grandTotal: number
  /** Set when the invoice is issued. */
  issuedAt?: string
  /** Due date, YYYY-MM-DD. */
  dueAt: string
  createdAt: string
  updatedAt: string
  cancelledAt?: string
  voidedAt?: string
  voidReason?: string
  status: InvoiceStatus
  /**
   * DERIVED from payment allocations on every read; whatever is stored is ignored. Read-only.
   */
  paymentStatus: InvoicePaymentStatus
  /** Present on invoices returned by the service: the derived balance behind `paymentStatus`. */
  payment?: InvoicePaymentSummary
  notes?: string
  /** Increments on every change; writes must quote the version they read (optimistic locking). */
  version: number
  /**
   * Where the invoice came from, set by the server and never by a form. Absent on older records, which are
   * traditional invoices (read as `INVOICE`).
   */
  saleChannel?: SaleChannel
  /**
   * A DEMONSTRATION code sale: kept for the internal checkout demonstration, never a real invoice. It is numbered DEMO-0001..., and is
   * excluded from invoice lists, receivables, overdue figures, reports and any outside system. Set by the server only.
   */
  demonstration?: boolean
}

/** `INVOICE`: a traditional manual invoice. `POS` and `SIMPLIFIED`: checkout flows. */
export type SaleChannel = 'INVOICE' | 'POS' | 'SIMPLIFIED' | 'CODE'

export interface InvoiceDraftInput {
  branchId: string
  assignedToUserId: string
  customer: InvoiceCustomer
  items: InvoiceItemInput[]
  taxMode: TaxMode
  dueAt: string
  notes?: string
}

/** Contract-ready for server pagination; the mock returns everything in one page. */
export interface InvoiceListRequest {
  limit?: number
  cursor?: string
}

export interface InvoicePage {
  items: Invoice[]
  totalCount: number
  /** Null when there are no more pages. */
  nextCursor: string | null
}

export interface InvoiceBranchOption {
  id: string
  name: string
  code: string
}

export interface InvoiceAssigneeOption {
  userId: string
  membershipId: string
  fullName: string
  /** ACTIVE branches this person is actively assigned to. */
  branchIds: string[]
}

/** Who and where the current user may create invoices for. */
export interface InvoiceFormOptions {
  branches: InvoiceBranchOption[]
  assignees: InvoiceAssigneeOption[]
}
