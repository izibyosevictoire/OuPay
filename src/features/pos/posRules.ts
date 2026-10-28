import {
  compareExactDecimals,
  formatExactDecimal,
  parseExactDecimal,
  shiftDecimalPoint,
} from '@/lib/exactDecimal'
import type { MeasurementUnitCode } from '@/types/catalog'
import type {
  PosCatalogItem,
  PosLineInput,
  PosPricedLine,
  PosProblem,
  PosStockCheck,
  PosStockInfo,
} from '@/types/pos'

/**
 * One line of the cart on screen. The cashier chooses an item, a quantity and EITHER a unit OR one of the item's packages;
 * the price is never chosen here: the line remembers only the price VERSION the cashier saw, and the server prices it.
 */
export interface CartLine {
  /** Identifies the line on screen only. */
  key: string
  item: PosCatalogItem
  quantity: string
  /** Either a unit code or `pkg:<packageId>`. */
  choice: string
}

const PACKAGE_PREFIX = 'pkg:'

export const packageChoice = (packageId: string) => `${PACKAGE_PREFIX}${packageId}`

export const UNIT_NAMES: Record<MeasurementUnitCode, string> = {
  pc: 'pieces',
  g: 'grams',
  kg: 'kilograms',
  ml: 'millilitres',
  l: 'litres',
  mm: 'millimetres',
  m: 'metres',
  mm2: 'square millimetres',
  m2: 'square metres',
}

/** A short unit for display beside a number ("kg", "pc"). */
export const unitSymbol = (unit: MeasurementUnitCode) =>
  unit === 'mm2' ? 'mm²' : unit === 'm2' ? 'm²' : unit

/** The line as the server wants it: an item, a decimal STRING quantity, a unit or a package, and the version seen. Never a price. */
export function toLineInput(line: CartLine): PosLineInput {
  const isPackage = line.choice.startsWith(PACKAGE_PREFIX)
  return {
    itemId: line.item.itemId,
    quantity: line.quantity.trim(),
    unit: isPackage ? null : (line.choice as MeasurementUnitCode),
    packageId: isPackage ? line.choice.slice(PACKAGE_PREFIX.length) : null,
    expectedPriceVersion: line.item.priceVersion,
  }
}

/** The unit a newly added line starts in: the item's selling unit. */
export const defaultChoice = (item: PosCatalogItem): string => item.saleUnit

/**
 * Quick feedback while typing; the server decides. A quantity is plain decimal text: a number of packages must be whole, and a
 * counted good must be whole. More decimals than a bill can hold are explained by the server (it never rounds).
 */
export function quantityProblem(line: CartLine): string | null {
  const text = line.quantity.trim()
  if (text === '') return 'Enter a quantity.'
  const value = parseExactDecimal(text)
  if (!value || !/^[0-9]+(\.[0-9]+)?$/.test(text)) {
    return 'Enter the quantity as a number, for example 2 or 1.5.'
  }
  if (compareExactDecimals(value, { unscaled: 0n, scale: 0 }) <= 0) {
    return 'The quantity must be more than zero.'
  }
  if (line.choice.startsWith(PACKAGE_PREFIX) && value.scale > 0) {
    return 'Enter a whole number of packages.'
  }
  if (line.item.measurementDimension === 'COUNT' && value.scale > 0) {
    return 'Items sold by the piece must be whole numbers.'
  }
  return null
}

const DISPLAY_STEP: Partial<
  Record<MeasurementUnitCode, { bigger: MeasurementUnitCode; places: number }>
> = {
  g: { bigger: 'kg', places: 3 },
  ml: { bigger: 'l', places: 3 },
  mm: { bigger: 'm', places: 3 },
  mm2: { bigger: 'm2', places: 6 },
}

/** An exact quantity in the canonical unit, shown in the larger unit once it reaches one of it ("12500 g" becomes "12.5 kg"). */
export function friendlyQuantity(value: string | null, unit: MeasurementUnitCode): string {
  const parsed = value === null ? null : parseExactDecimal(value)
  if (!parsed) return '—'
  const step = DISPLAY_STEP[unit]
  if (step) {
    const bigger = shiftDecimalPoint(parsed, -step.places)
    if (compareExactDecimals(bigger, { unscaled: 1n, scale: 0 }) >= 0) {
      return `${formatExactDecimal(bigger)} ${unitSymbol(step.bigger)}`
    }
  }
  return `${formatExactDecimal(parsed)} ${unitSymbol(unit)}`
}

export type StockTone = 'ok' | 'warning' | 'neutral'

export interface StockDescription {
  tone: StockTone
  text: string
}

/** What a stock figure means for the cashier. Always informational: nothing is held, and billing checks again. */
export function describeStockInfo(stock: PosStockInfo): StockDescription {
  switch (stock.state) {
    case 'NOT_TRACKED':
      return { tone: 'neutral', text: 'Service: no stock needed' }
    case 'NO_RECORD':
      return { tone: 'warning', text: 'No stock recorded at this branch' }
    case 'RECORDED':
      return { tone: 'ok', text: `${friendlyQuantity(stock.onHand, stock.canonicalUnit)} in stock` }
  }
}

export function describeStockCheck(check: PosStockCheck): StockDescription {
  switch (check.state) {
    case 'NOT_TRACKED':
      return { tone: 'neutral', text: 'Service: no stock needed' }
    case 'NO_STOCK_RECORD':
      return {
        tone: 'warning',
        text: `No stock recorded at this branch (${friendlyQuantity(check.requested, check.canonicalUnit)} requested)`,
      }
    case 'SUFFICIENT':
      return {
        tone: 'ok',
        text: `${friendlyQuantity(check.onHand, check.canonicalUnit)} in stock`,
      }
    case 'INSUFFICIENT':
      return {
        tone: 'warning',
        text: `Only ${friendlyQuantity(check.onHand, check.canonicalUnit)} in stock, ${friendlyQuantity(check.requested, check.canonicalUnit)} requested`,
      }
  }
}

/** The line as the server priced it, found by its position among the lines that priced (a line with a problem has none). */
export function pricedLineFor(
  lines: PosPricedLine[],
  problems: PosProblem[],
  index: number,
): PosPricedLine | undefined {
  if (problems.some((p) => p.lineIndex === index)) return undefined
  const before = problems.filter((p) => p.lineIndex < index).length
  return lines[index - before]
}

/** Lets the cashier accept a changed price: the line takes the current version and price the server reported. */
export function acceptCurrentPrice(line: CartLine, problem: PosProblem): CartLine {
  if (problem.currentPriceVersion === null || problem.currentPriceRwf === null) return line
  return {
    ...line,
    item: {
      ...line.item,
      priceVersion: problem.currentPriceVersion,
      pricePerSaleUnitRwf: problem.currentPriceRwf,
    },
  }
}

/** What makes two carts the same cart: the branch, the note and every line as typed. The same cart keeps the same attempt ids. */
export const payloadKeyOf = (branchId: string, note: string, lines: PosLineInput[]) =>
  JSON.stringify([
    branchId,
    note.trim(),
    lines.map((l) => [
      l.itemId,
      l.quantity,
      l.unit ?? null,
      l.packageId ?? null,
      l.expectedPriceVersion,
    ]),
  ])
