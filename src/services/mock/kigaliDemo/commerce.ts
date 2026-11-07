// DEMO DATA ONLY (R9c). The catalog, tax classes, stock and example POS carts of the fictional Kigali Demo Supermarket.
import {
  addExactDecimals,
  formatExactDecimal,
  parseExactDecimal,
  type ExactDecimal,
} from '@/lib/exactDecimal'
import type { CatalogItemType, MeasurementDimension, MeasurementUnitCode } from '@/types/catalog'
import type { PosPricedLine } from '@/types/pos'
import type { StockMovementType } from '@/types/inventory'
import type { StoredCatalogItem, StoredPriceVersion } from '../sampleCatalog'
import type { StoredCatalogTax } from '../sampleCatalogTax'
import type { StoredBalance, StoredMovement } from '../sampleInventory'
import type { StoredPosDraft } from '../mockPosService'
import { KD, KD_PEOPLE } from './organization'

/** The unit each dimension is stored in. Written here so these fixtures import no mock service code, only types. */
const CANONICAL_UNIT: Record<MeasurementDimension, MeasurementUnitCode> = { COUNT: 'pc', MASS: 'g', VOLUME: 'ml', LENGTH: 'mm', AREA: 'mm2' }

const at = (day: number, minute: number) =>
  `2026-10-${String(day).padStart(2, '0')}T09:${String(minute).padStart(2, '0')}:00+02:00`

// ---- catalog: ten goods and two services ----------------------------------------------------------------------------

interface SeedItem {
  key: string
  type: CatalogItemType
  name: string
  code: string
  description: string
  dimension: MeasurementDimension
  saleUnit: MeasurementUnitCode
  price: number
  minute: number
  packages?: { label: string; quantity: string }[]
}

const SEEDS: SeedItem[] = [
  { key: 'rice', type: 'GOODS', name: 'Rice', code: 'RICE', description: 'Long-grain rice, sold loose by the kilogram.', dimension: 'MASS', saleUnit: 'kg', price: 1_200, minute: 1, packages: [{ label: 'Sack', quantity: '25000' }] },
  { key: 'sugar', type: 'GOODS', name: 'Sugar', code: 'SUGAR', description: 'White sugar, sold by the kilogram.', dimension: 'MASS', saleUnit: 'kg', price: 1_500, minute: 2 },
  { key: 'flour', type: 'GOODS', name: 'Maize flour', code: 'FLOUR', description: 'Maize flour, sold by the kilogram.', dimension: 'MASS', saleUnit: 'kg', price: 1_100, minute: 3 },
  { key: 'beans', type: 'GOODS', name: 'Beans', code: 'BEANS', description: 'Dry beans, sold by the kilogram.', dimension: 'MASS', saleUnit: 'kg', price: 1_400, minute: 4 },
  { key: 'salt', type: 'GOODS', name: 'Salt', code: 'SALT', description: 'Table salt, sold by the kilogram.', dimension: 'MASS', saleUnit: 'kg', price: 600, minute: 5 },
  { key: 'oil', type: 'GOODS', name: 'Cooking oil', code: 'OIL', description: 'Sunflower cooking oil, sold by the litre.', dimension: 'VOLUME', saleUnit: 'l', price: 3_200, minute: 6, packages: [{ label: 'Bottle', quantity: '750' }, { label: 'Jerrycan', quantity: '20000' }] },
  { key: 'soda', type: 'GOODS', name: 'Soda 500 ml', code: 'SODA', description: 'Soft drink bottle, 500 ml.', dimension: 'COUNT', saleUnit: 'pc', price: 600, minute: 7, packages: [{ label: 'Crate', quantity: '24' }] },
  { key: 'water', type: 'GOODS', name: 'Bottled water 1.5 l', code: 'WATER', description: 'Drinking water bottle, 1.5 litres.', dimension: 'COUNT', saleUnit: 'pc', price: 900, minute: 8, packages: [{ label: 'Pack of 6', quantity: '6' }] },
  { key: 'notebook', type: 'GOODS', name: 'Notebook A5', code: 'NOTE', description: 'Ruled A5 school notebook.', dimension: 'COUNT', saleUnit: 'pc', price: 800, minute: 9 },
  { key: 'soap', type: 'GOODS', name: 'Laundry soap bar', code: 'SOAP', description: 'Laundry soap bar.', dimension: 'COUNT', saleUnit: 'pc', price: 500, minute: 10 },
  { key: 'charging', type: 'SERVICE', name: 'Phone charging', code: 'CHARGE', description: 'Phone charging service, per charge.', dimension: 'COUNT', saleUnit: 'pc', price: 200, minute: 11 },
  { key: 'delivery', type: 'SERVICE', name: 'Delivery within Kigali', code: 'DELIVER', description: 'Delivery of an order within Kigali.', dimension: 'COUNT', saleUnit: 'pc', price: 2_000, minute: 12 },
]

export const KD_ITEM_IDS: Record<string, string> = Object.fromEntries(
  SEEDS.map((s) => [s.key, `kd-cat-${s.key}`]),
)

const itemAt = (minute: number) => `2026-10-01T10:${String(minute).padStart(2, '0')}:00+02:00`

export const KIGALI_CATALOG_ITEMS: StoredCatalogItem[] = SEEDS.map((seed) => {
  const goods = seed.type === 'GOODS'
  const id = KD_ITEM_IDS[seed.key]!
  return {
    id,
    merchantId: KD.merchantId,
    itemType: seed.type,
    name: seed.name,
    description: seed.description,
    code: seed.code,
    active: true,
    measurementDimension: seed.dimension,
    stockUnit: goods ? CANONICAL_UNIT[seed.dimension] : null,
    saleUnit: seed.saleUnit,
    pricePerSaleUnitRwf: seed.price,
    // Rice has had a price rise since it was listed, so its history has two versions.
    priceVersion: seed.key === 'rice' ? 2 : 1,
    packages: (seed.packages ?? []).map((p, index) => ({
      id: `${id}-pkg-${index + 1}`,
      itemId: id,
      label: p.label,
      quantityPerPackage: p.quantity,
      canonicalUnit: CANONICAL_UNIT[seed.dimension],
      active: true,
      createdAt: itemAt(seed.minute),
      updatedAt: itemAt(seed.minute),
      version: 0,
    })),
    createdAt: itemAt(seed.minute),
    updatedAt: itemAt(seed.minute),
    version: 0,
  }
})

export const KIGALI_CATALOG_PRICES: StoredPriceVersion[] = KIGALI_CATALOG_ITEMS.flatMap((item) => {
  const rice = item.id === KD_ITEM_IDS.rice
  const first: StoredPriceVersion = {
    merchantId: KD.merchantId,
    itemId: item.id,
    version: 1,
    pricePerSaleUnitRwf: rice ? 1_100 : item.pricePerSaleUnitRwf,
    saleUnit: item.saleUnit,
    effectiveAt: item.createdAt,
    reason: null,
  }
  return rice
    ? [
        first,
        {
          ...first,
          version: 2,
          pricePerSaleUnitRwf: 1_200,
          effectiveAt: '2026-10-20T09:00:00+02:00',
          reason: 'Supplier price increase',
        },
      ]
    : [first]
})

/**
 * DEMONSTRATION tax classes, NOT tax advice and no claim about what is taxable in Rwanda. They exist so the demo can show a billable cart.
 * Salt is deliberately left UNCONFIGURED: an item with no class can not be billed, and nothing is ever assumed.
 */
const tax = (key: string, category: StoredCatalogTax['category'], rateBp = 0): StoredCatalogTax => ({
  merchantId: KD.merchantId,
  itemId: KD_ITEM_IDS[key]!,
  category,
  rateBp,
})

export const KIGALI_CATALOG_TAX: StoredCatalogTax[] = [
  tax('rice', 'EXEMPT'),
  tax('sugar', 'STANDARD', 1800),
  tax('flour', 'EXEMPT'),
  tax('beans', 'EXEMPT'),
  tax('oil', 'STANDARD', 1800),
  tax('soda', 'STANDARD', 1800),
  tax('water', 'STANDARD', 1800),
  tax('notebook', 'STANDARD', 1800),
  tax('soap', 'STANDARD', 1800),
  tax('charging', 'STANDARD', 1800),
  tax('delivery', 'STANDARD', 1800),
]

// ---- stock: opening balances at every branch, plus a little history -------------------------------------------------------

interface SeedMovement {
  type: StockMovementType
  /** Signed canonical quantity (grams, millilitres or pieces). */
  delta: string
  enteredAs: string
  reason?: string
  reference?: string
  day: number
}

interface SeedStock {
  branchId: string
  item: string
  actor: { id: string; name: string }
  movements: SeedMovement[]
}

const OWNER = { id: KD_PEOPLE.owner.id, name: KD_PEOPLE.owner.name }
const MANAGER = { id: KD_PEOPLE.manager.id, name: KD_PEOPLE.manager.name }

const opening = (delta: string, enteredAs: string): SeedMovement => ({
  type: 'OPENING',
  delta,
  enteredAs,
  day: 2,
})

const STOCK: SeedStock[] = [
  // Kigali Main carries the whole range.
  {
    branchId: KD.branches.main,
    item: 'rice',
    actor: OWNER,
    movements: [
      opening('150000', '150 kg'),
      { type: 'RECEIVE', delta: '250000', enteredAs: '10 x Sack', reference: 'DN-DEMO-0101', day: 9 },
      { type: 'ADJUST_OUT', delta: '-3500', enteredAs: '3.5 kg', reason: 'Spillage in the store room', day: 14 },
    ],
  },
  { branchId: KD.branches.main, item: 'sugar', actor: OWNER, movements: [opening('90000', '90 kg')] },
  { branchId: KD.branches.main, item: 'flour', actor: OWNER, movements: [opening('100000', '100 kg')] },
  { branchId: KD.branches.main, item: 'beans', actor: OWNER, movements: [opening('80000', '80 kg')] },
  { branchId: KD.branches.main, item: 'salt', actor: OWNER, movements: [opening('40000', '40 kg')] },
  {
    branchId: KD.branches.main,
    item: 'oil',
    actor: MANAGER,
    movements: [
      opening('60000', '60 L'),
      { type: 'RECEIVE', delta: '40000', enteredAs: '2 x Jerrycan', reference: 'DN-DEMO-0102', day: 11 },
    ],
  },
  { branchId: KD.branches.main, item: 'soda', actor: MANAGER, movements: [opening('240', '240 pc')] },
  { branchId: KD.branches.main, item: 'water', actor: MANAGER, movements: [opening('120', '120 pc')] },
  { branchId: KD.branches.main, item: 'notebook', actor: OWNER, movements: [opening('200', '200 pc')] },
  { branchId: KD.branches.main, item: 'soap', actor: OWNER, movements: [opening('150', '150 pc')] },
  // Remera.
  { branchId: KD.branches.remera, item: 'rice', actor: MANAGER, movements: [opening('70000', '70 kg')] },
  { branchId: KD.branches.remera, item: 'sugar', actor: MANAGER, movements: [opening('45000', '45 kg')] },
  { branchId: KD.branches.remera, item: 'oil', actor: MANAGER, movements: [opening('30000', '30 L')] },
  { branchId: KD.branches.remera, item: 'soda', actor: MANAGER, movements: [opening('120', '120 pc')] },
  { branchId: KD.branches.remera, item: 'water', actor: MANAGER, movements: [opening('60', '60 pc')] },
  { branchId: KD.branches.remera, item: 'soap', actor: MANAGER, movements: [opening('80', '80 pc')] },
  { branchId: KD.branches.remera, item: 'notebook', actor: MANAGER, movements: [opening('60', '60 pc')] },
  // Kimironko starts small.
  { branchId: KD.branches.kimironko, item: 'rice', actor: OWNER, movements: [opening('50000', '50 kg')] },
  { branchId: KD.branches.kimironko, item: 'beans', actor: OWNER, movements: [opening('35000', '35 kg')] },
  { branchId: KD.branches.kimironko, item: 'soda', actor: OWNER, movements: [opening('96', '96 pc')] },
  { branchId: KD.branches.kimironko, item: 'water', actor: OWNER, movements: [opening('48', '48 pc')] },
  { branchId: KD.branches.kimironko, item: 'notebook', actor: OWNER, movements: [opening('90', '90 pc')] },
]

const sum = (a: ExactDecimal, b: string) => addExactDecimals(a, parseExactDecimal(b)!)

const built = (() => {
  const balances: StoredBalance[] = []
  const movements: StoredMovement[] = []
  let seq = 0
  STOCK.forEach((seed, seedIndex) => {
    const n = String(seedIndex + 1).padStart(3, '0')
    let running = parseExactDecimal('0')!
    seq += 1
    const balanceSeq = seq
    seed.movements.forEach((movement, index) => {
      running = sum(running, movement.delta)
      seq += 1
      movements.push({
        id: `kd-mov-${n}-${index + 1}`,
        merchantId: KD.merchantId,
        branchId: seed.branchId,
        itemId: KD_ITEM_IDS[seed.item]!,
        movementType: movement.type,
        quantityDelta: movement.delta,
        balanceAfter: formatExactDecimal(running),
        enteredAs: movement.enteredAs,
        reason: movement.reason ?? null,
        reference: movement.reference ?? null,
        operationId: `00000000-0000-4000-9000-${String(seedIndex + 1).padStart(4, '0')}${String(index + 1).padStart(8, '0')}`,
        fingerprint: `kd-seed-${seedIndex}-${index}`,
        actorUserId: seed.actor.id,
        actorName: seed.actor.name,
        createdAt: at(movement.day, seedIndex),
        seq,
      })
    })
    const last = seed.movements[seed.movements.length - 1]!
    balances.push({
      id: `kd-bal-${n}`,
      merchantId: KD.merchantId,
      branchId: seed.branchId,
      itemId: KD_ITEM_IDS[seed.item]!,
      quantityOnHand: formatExactDecimal(running),
      createdAt: at(seed.movements[0]!.day, seedIndex),
      updatedAt: at(last.day, seedIndex),
      seq: balanceSeq,
      version: seed.movements.length - 1,
    })
  })
  return { balances, movements }
})()

export const KIGALI_INVENTORY_BALANCES: StoredBalance[] = built.balances
export const KIGALI_STOCK_MOVEMENTS: StoredMovement[] = built.movements

// ---- two example POS carts ------------------------------------------------------------------------------------------

const TO_CANONICAL: Record<MeasurementUnitCode, number> = {
  pc: 1,
  g: 1,
  kg: 1000,
  ml: 1,
  l: 1000,
  mm: 1,
  m: 1000,
  mm2: 1,
  m2: 1_000_000,
}

const line = (lineNo: number, key: string, quantity: number, unit: MeasurementUnitCode): PosPricedLine => {
  const item = KIGALI_CATALOG_ITEMS.find((i) => i.id === KD_ITEM_IDS[key])!
  return {
    lineNo,
    itemId: item.id,
    itemType: item.itemType,
    name: item.name,
    code: item.code,
    measurementDimension: item.measurementDimension,
    enteredQuantity: String(quantity),
    enteredUnit: unit,
    packageId: null,
    packageLabel: null,
    saleUnit: item.saleUnit,
    quantityInSaleUnit: String(quantity),
    canonicalQuantity: String(quantity * TO_CANONICAL[unit]),
    canonicalUnit: CANONICAL_UNIT[item.measurementDimension],
    priceVersion: item.priceVersion,
    unitPriceRwf: item.pricePerSaleUnitRwf,
    lineTotalRwf: quantity * item.pricePerSaleUnitRwf,
    stock: null,
  }
}

const draft = (
  n: number,
  branchId: string,
  branchName: string,
  note: string,
  by: { id: string; name: string },
  lines: PosPricedLine[],
  day: number,
): StoredPosDraft => ({
  id: `kd-posd-${String(n).padStart(3, '0')}`,
  merchantId: KD.merchantId,
  branchId,
  branchName,
  status: 'DRAFT',
  note,
  lines,
  totalRwf: lines.reduce((total, l) => total + l.lineTotalRwf, 0),
  createdByUserId: by.id,
  createdByName: by.name,
  createdAt: `2026-11-0${day}T10:15:00+02:00`,
  updatedAt: `2026-11-0${day}T10:15:00+02:00`,
  version: 0,
  clientRequestId: `00000000-0000-4000-a000-${String(n).padStart(12, '0')}`,
  fingerprint: `kd-seed-draft-${n}`,
  idempotencyKeys: [],
})

/**
 * Two carts that are NOT sales: no invoice, no payment request, no stock deducted. The first is the cashier's at Kigali Main (so the cashier
 * sees it), the second the manager's at Remera.
 */
export const KIGALI_POS_DRAFTS: StoredPosDraft[] = [
  draft(1, KD.branches.main, 'Kigali Main', 'Weekly groceries (demo cart)', { id: KD_PEOPLE.cashier.id, name: KD_PEOPLE.cashier.name }, [line(1, 'rice', 2, 'kg'), line(2, 'oil', 1, 'l'), line(3, 'soda', 6, 'pc')], 5),
  draft(2, KD.branches.remera, 'Remera', 'School supplies and soap (demo cart)', { id: KD_PEOPLE.manager.id, name: KD_PEOPLE.manager.name }, [line(1, 'notebook', 5, 'pc'), line(2, 'soap', 3, 'pc')], 6),
]
