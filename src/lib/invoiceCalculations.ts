import type { InvoiceItem, InvoiceItemInput, TaxCategory, TaxMode, TaxRate } from '@/types/invoice'

/**
 * INVOICE ARITHMETIC: integers only, with one explicit rounding rule.
 *
 * Units: amounts are integer minor units (RWF: 1 = 1 franc). Quantity is converted to
 * thousandths so up to 3 decimal places multiply exactly. Tax rates are basis points
 * (1800 = 18%). Products and quotients use BigInt, so there is no float error and no
 * overflow, whatever the sizes.
 *
 * Rounding: every division rounds HALF UP (0.5 -> 1) on a non-negative value, and it
 * happens ONCE PER LINE. Invoice totals are plain sums of already-rounded line values,
 * so what is printed always adds up exactly.
 *
 * Per line:
 *   gross = round(unitPrice x quantity)
 *   base  = gross - discount
 *   EXCLUSIVE (prices exclude tax): tax = round(base x rate / 10000), net = base, total = base + tax
 *   INCLUSIVE (prices include tax): tax = round(base x rate / (10000 + rate)), net = base - tax, total = base
 */

export const BASIS_POINTS = 10_000
export const QUANTITY_SCALE = 1000
export const MAX_QUANTITY_DECIMALS = 3

/**
 * Standard VAT rate in Rwanda, offered as a PRESET for the user to choose. It is never
 * applied automatically: not every merchant or item is VAT-taxable.
 */
export const RWANDA_STANDARD_VAT_RATE_BP = 1800

/** round-half-up(a x b / c) for non-negative integers, exactly. */
export function mulDivRound(a: number, b: number, c: number): number {
  const numerator = BigInt(a) * BigInt(b)
  const denominator = BigInt(c)
  return Number((numerator * 2n + denominator) / (denominator * 2n))
}

/** Quantity in thousandths. Rounds to the nearest thousandth, so 1.005 -> 1005 despite float noise. */
export const quantityToMilli = (quantity: number) => Math.round(quantity * QUANTITY_SCALE)

const NO_TAX_CATEGORIES: TaxCategory[] = ['NOT_APPLICABLE', 'EXEMPT', 'ZERO_RATED']

/** The rate that actually applies: non-taxable categories are always 0, whatever `rateBp` says. */
export const effectiveRateBp = (taxRate: TaxRate) =>
  NO_TAX_CATEGORIES.includes(taxRate.category) ? 0 : taxRate.rateBp

export interface LineCalculation {
  gross: number
  discount: number
  netAmount: number
  taxAmount: number
  lineTotal: number
}

export function calculateLine(item: InvoiceItemInput, taxMode: TaxMode): LineCalculation {
  const gross = mulDivRound(item.unitPrice, quantityToMilli(item.quantity), QUANTITY_SCALE)
  // A discount can never push a line below zero.
  const discount = Math.min(item.discount, gross)
  const base = gross - discount
  const rate = effectiveRateBp(item.taxRate)

  if (taxMode === 'INCLUSIVE') {
    const taxAmount = mulDivRound(base, rate, BASIS_POINTS + rate)
    return { gross, discount, netAmount: base - taxAmount, taxAmount, lineTotal: base }
  }
  const taxAmount = mulDivRound(base, rate, BASIS_POINTS)
  return { gross, discount, netAmount: base, taxAmount, lineTotal: base + taxAmount }
}

export interface InvoiceTotals {
  subtotal: number
  discountTotal: number
  taxTotal: number
  grandTotal: number
}

export interface InvoiceCalculation extends InvoiceTotals {
  items: InvoiceItem[]
}

/** Computes every stored amount. The service calls this itself; client totals are never trusted. */
export function calculateInvoice(
  items: InvoiceItemInput[],
  taxMode: TaxMode,
  itemIds: string[] = [],
): InvoiceCalculation {
  const totals: InvoiceTotals = { subtotal: 0, discountTotal: 0, taxTotal: 0, grandTotal: 0 }
  const computed = items.map<InvoiceItem>((item, index) => {
    const line = calculateLine(item, taxMode)
    totals.subtotal += line.gross
    totals.discountTotal += line.discount
    totals.taxTotal += line.taxAmount
    totals.grandTotal += line.lineTotal
    return {
      ...item,
      id: itemIds[index] ?? `item-${index + 1}`,
      discount: line.discount,
      netAmount: line.netAmount,
      taxAmount: line.taxAmount,
      lineTotal: line.lineTotal,
    }
  })
  return { items: computed, ...totals }
}

/** True when stored totals satisfy the documented identity for their tax mode. */
export function totalsAreConsistent(totals: InvoiceTotals, taxMode: TaxMode): boolean {
  const expected =
    taxMode === 'EXCLUSIVE'
      ? totals.subtotal - totals.discountTotal + totals.taxTotal
      : totals.subtotal - totals.discountTotal
  return totals.grandTotal === expected
}

/** Counts decimal places of a plain decimal string such as "1.25". */
export function countDecimals(value: string): number {
  const [, fraction = ''] = value.trim().split('.')
  return fraction.length
}
