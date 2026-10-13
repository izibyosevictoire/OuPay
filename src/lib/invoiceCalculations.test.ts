import type { InvoiceItemInput, TaxRate } from '@/types/invoice'
import {
  calculateInvoice,
  calculateLine,
  countDecimals,
  effectiveRateBp,
  mulDivRound,
  quantityToMilli,
  RWANDA_STANDARD_VAT_RATE_BP,
  totalsAreConsistent,
} from './invoiceCalculations'

const NO_VAT: TaxRate = { category: 'NOT_APPLICABLE', rateBp: 0 }
const VAT_18: TaxRate = { category: 'STANDARD', rateBp: RWANDA_STANDARD_VAT_RATE_BP }

const item = (overrides: Partial<InvoiceItemInput> = {}): InvoiceItemInput => ({
  description: 'Item',
  quantity: 1,
  unitPrice: 1000,
  discount: 0,
  taxRate: NO_VAT,
  ...overrides,
})

describe('integer arithmetic', () => {
  it('rounds half up, exactly', () => {
    expect(mulDivRound(1, 5, 10)).toBe(1) // 0.5 -> 1
    expect(mulDivRound(1, 4, 10)).toBe(0)
    expect(mulDivRound(3, 5, 10)).toBe(2) // 1.5 -> 2
    expect(mulDivRound(25, 1800, 10_000)).toBe(5) // 4.5 -> 5
    expect(mulDivRound(0, 7, 3)).toBe(0)
  })

  it('does not overflow or lose precision with very large amounts', () => {
    // 999,999,999 x 999,999.999 is ~1e15: beyond what float math does exactly with decimals.
    expect(mulDivRound(999_999_999, 999_999_999, 1000)).toBe(999_999_998_000_000)
  })

  it('turns quantities into exact thousandths despite float noise', () => {
    expect(quantityToMilli(1.005)).toBe(1005)
    expect(quantityToMilli(0.1 + 0.2)).toBe(300)
    expect(quantityToMilli(2)).toBe(2000)
  })

  it('counts decimal places of typed numbers', () => {
    expect(countDecimals('12')).toBe(0)
    expect(countDecimals('1.250')).toBe(3)
    expect(countDecimals(' 7.5 ')).toBe(1)
  })
})

describe('a single line', () => {
  it('multiplies price by quantity with no tax by default', () => {
    expect(calculateLine(item({ quantity: 3, unitPrice: 2500 }), 'EXCLUSIVE')).toEqual({
      gross: 7500,
      discount: 0,
      netAmount: 7500,
      taxAmount: 0,
      lineTotal: 7500,
    })
  })

  it('adds tax on top when prices EXCLUDE tax', () => {
    const line = calculateLine(item({ quantity: 3, unitPrice: 1000, taxRate: VAT_18 }), 'EXCLUSIVE')
    expect(line).toMatchObject({ gross: 3000, netAmount: 3000, taxAmount: 540, lineTotal: 3540 })
  })

  it('extracts tax from the price when prices INCLUDE tax', () => {
    const exact = calculateLine(item({ unitPrice: 1180, taxRate: VAT_18 }), 'INCLUSIVE')
    expect(exact).toMatchObject({ netAmount: 1000, taxAmount: 180, lineTotal: 1180 })
    // 1000 incl. 18%: tax = 152.54 -> 153, net = 847. The customer still pays exactly 1000.
    const rounded = calculateLine(item({ unitPrice: 1000, taxRate: VAT_18 }), 'INCLUSIVE')
    expect(rounded).toMatchObject({ netAmount: 847, taxAmount: 153, lineTotal: 1000 })
  })

  it('applies the discount before tax', () => {
    const line = calculateLine(
      item({ quantity: 2, unitPrice: 5000, discount: 1000, taxRate: VAT_18 }),
      'EXCLUSIVE',
    )
    expect(line).toMatchObject({
      gross: 10_000,
      discount: 1000,
      netAmount: 9000,
      taxAmount: 1620,
      lineTotal: 10_620,
    })
  })

  it('never lets a discount make a line negative', () => {
    const line = calculateLine(
      item({ unitPrice: 500, discount: 9999, taxRate: VAT_18 }),
      'EXCLUSIVE',
    )
    expect(line).toMatchObject({ discount: 500, netAmount: 0, taxAmount: 0, lineTotal: 0 })
  })

  it('rounds fractional quantities and tax half up', () => {
    // 2.5 x 1 = 2.5 -> 3
    expect(calculateLine(item({ quantity: 2.5, unitPrice: 1 }), 'EXCLUSIVE').gross).toBe(3)
    // 25 x 18% = 4.5 -> 5
    expect(calculateLine(item({ unitPrice: 25, taxRate: VAT_18 }), 'EXCLUSIVE').taxAmount).toBe(5)
    // 333 x 18% = 59.94 -> 60
    expect(calculateLine(item({ unitPrice: 333, taxRate: VAT_18 }), 'EXCLUSIVE').taxAmount).toBe(60)
  })

  it('ignores any rate on non-taxable categories: nothing is assumed taxable', () => {
    for (const category of ['NOT_APPLICABLE', 'EXEMPT', 'ZERO_RATED'] as const) {
      const taxRate: TaxRate = { category, rateBp: 1800 }
      expect(effectiveRateBp(taxRate)).toBe(0)
      expect(calculateLine(item({ unitPrice: 1000, taxRate }), 'EXCLUSIVE').taxAmount).toBe(0)
      expect(calculateLine(item({ unitPrice: 1000, taxRate }), 'INCLUSIVE').taxAmount).toBe(0)
    }
  })

  it('supports a custom rate on the STANDARD category', () => {
    const custom: TaxRate = { category: 'STANDARD', rateBp: 500 }
    expect(calculateLine(item({ unitPrice: 2000, taxRate: custom }), 'EXCLUSIVE').taxAmount).toBe(
      100,
    )
  })
})

describe('whole invoices', () => {
  const items = [
    item({ description: 'A', quantity: 2, unitPrice: 1500, taxRate: VAT_18 }),
    item({ description: 'B', quantity: 1, unitPrice: 4000, discount: 500 }),
    item({
      description: 'C',
      quantity: 0.5,
      unitPrice: 10_001,
      taxRate: { category: 'EXEMPT', rateBp: 0 },
    }),
  ]

  it('sums per-line values into totals, in both tax modes', () => {
    const exclusive = calculateInvoice(items, 'EXCLUSIVE')
    expect(exclusive.subtotal).toBe(3000 + 4000 + 5001) // 5000.5 -> 5001
    expect(exclusive.discountTotal).toBe(500)
    expect(exclusive.taxTotal).toBe(540)
    expect(exclusive.grandTotal).toBe(12_001 - 500 + 540)
    expect(totalsAreConsistent(exclusive, 'EXCLUSIVE')).toBe(true)

    const inclusive = calculateInvoice(items, 'INCLUSIVE')
    expect(inclusive.grandTotal).toBe(12_001 - 500) // tax is already inside
    expect(totalsAreConsistent(inclusive, 'INCLUSIVE')).toBe(true)
  })

  it('stores net, tax and total on each line, so history stays exact', () => {
    const { items: computed } = calculateInvoice(items, 'EXCLUSIVE')
    for (const line of computed) expect(line.netAmount + line.taxAmount).toBe(line.lineTotal)
    expect(computed.map((line) => line.taxAmount)).toEqual([540, 0, 0])
  })

  it('rounds each line once and sums the rounded values (printed lines always add up)', () => {
    // Two lines whose tax is 4.5 each: each rounds to 5 (total 10), not round(9) = 9.
    const result = calculateInvoice(
      [item({ unitPrice: 25, taxRate: VAT_18 }), item({ unitPrice: 25, taxRate: VAT_18 })],
      'EXCLUSIVE',
    )
    expect(result.taxTotal).toBe(10)
    expect(result.items.map((line) => line.taxAmount)).toEqual([5, 5])
  })

  it('keeps integer results for awkward values (no float drift)', () => {
    const result = calculateInvoice(
      Array.from({ length: 10 }, () => item({ quantity: 0.1, unitPrice: 3, taxRate: VAT_18 })),
      'EXCLUSIVE',
    )
    expect(Number.isInteger(result.grandTotal)).toBe(true)
    expect(result.items.every((line) => Number.isInteger(line.lineTotal))).toBe(true)
  })

  it('assigns provided ids and falls back to stable ones', () => {
    expect(calculateInvoice([item(), item()], 'EXCLUSIVE', ['x']).items.map((i) => i.id)).toEqual([
      'x',
      'item-2',
    ])
  })

  it('detects totals that break the identity', () => {
    const good = calculateInvoice(items, 'EXCLUSIVE')
    expect(totalsAreConsistent({ ...good, grandTotal: good.grandTotal + 1 }, 'EXCLUSIVE')).toBe(
      false,
    )
  })
})
