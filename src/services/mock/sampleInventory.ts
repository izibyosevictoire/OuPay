// SAMPLE DATA ONLY. Fictional stock for the BUSINESS demo merchants, matching the sample catalog goods and branches.
import {
  addExactDecimals,
  formatExactDecimal,
  parseExactDecimal,
  type ExactDecimal,
} from '@/lib/exactDecimal'
import type { StockMovementType } from '@/types/inventory'
import { DEMO_USER_IDS } from './sampleAccounts'
import { SAMPLE_MERCHANT_ID, SAMPLE_SECOND_MERCHANT_ID } from './sampleMerchants'
import { SAMPLE_BRANCH_IDS } from './sampleOrganization'

/** The stock of one item at one branch, in the item's stock (canonical) unit. */
export interface StoredBalance {
  id: string
  merchantId: string
  branchId: string
  itemId: string
  quantityOnHand: string
  createdAt: string
  updatedAt: string
  /** Orders records that were created in the same millisecond, exactly like the server's total order. */
  seq: number
  version: number
}

/** One immutable line of stock history. Never edited or deleted. */
export interface StoredMovement {
  id: string
  merchantId: string
  branchId: string
  itemId: string
  movementType: StockMovementType
  quantityDelta: string
  balanceAfter: string
  enteredAs: string | null
  reason: string | null
  reference: string | null
  operationId: string
  /** What makes two requests the same operation (the server computes its own). */
  fingerprint: string
  actorUserId: string
  actorName: string
  createdAt: string
  seq: number
}

const at = (day: number, minute: number) =>
  `2026-09-${String(day).padStart(2, '0')}T09:${String(minute).padStart(2, '0')}:00+02:00`

interface SeedMovement {
  type: StockMovementType
  /** Signed canonical quantity. */
  delta: string
  enteredAs: string
  reason?: string
  reference?: string
  day: number
}

interface SeedStock {
  merchantId: string
  branchId: string
  itemId: string
  actor: { id: string; name: string }
  movements: SeedMovement[]
}

const OWNER = { id: DEMO_USER_IDS.owner, name: 'Sample Owner' }
const MANAGER = { id: DEMO_USER_IDS.manager, name: 'Grace Mukamana' }
const CAFE_OWNER = { id: DEMO_USER_IDS.cafeOwner, name: 'Claudine Mukashema' }

const SEEDS: SeedStock[] = [
  {
    merchantId: SAMPLE_MERCHANT_ID,
    branchId: SAMPLE_BRANCH_IDS.remera,
    itemId: 'cat-rice',
    actor: OWNER,
    movements: [
      { type: 'OPENING', delta: '500000', enteredAs: '500 kg', day: 12 },
      { type: 'RECEIVE', delta: '250000', enteredAs: '10 x Bag', reference: 'DN-1042', day: 15 },
      {
        type: 'ADJUST_OUT',
        delta: '-3500',
        enteredAs: '3.5 kg',
        reason: 'Spillage in the store room',
        day: 17,
      },
    ],
  },
  {
    merchantId: SAMPLE_MERCHANT_ID,
    branchId: SAMPLE_BRANCH_IDS.cityCentre,
    itemId: 'cat-rice',
    actor: OWNER,
    movements: [{ type: 'OPENING', delta: '120000', enteredAs: '120 kg', day: 12 }],
  },
  {
    merchantId: SAMPLE_MERCHANT_ID,
    branchId: SAMPLE_BRANCH_IDS.remera,
    itemId: 'cat-oil',
    actor: MANAGER,
    movements: [
      { type: 'OPENING', delta: '80000', enteredAs: '80 L', day: 12 },
      { type: 'RECEIVE', delta: '40000', enteredAs: '2 x Jerrycan', reference: 'DN-1051', day: 16 },
    ],
  },
  {
    merchantId: SAMPLE_MERCHANT_ID,
    branchId: SAMPLE_BRANCH_IDS.remera,
    itemId: 'cat-cement',
    actor: OWNER,
    movements: [{ type: 'OPENING', delta: '2000000', enteredAs: '40 x Bag', day: 12 }],
  },
  {
    merchantId: SAMPLE_MERCHANT_ID,
    branchId: SAMPLE_BRANCH_IDS.remera,
    itemId: 'cat-fabric',
    actor: OWNER,
    movements: [{ type: 'OPENING', delta: '150000', enteredAs: '150 m', day: 12 }],
  },
  {
    merchantId: SAMPLE_MERCHANT_ID,
    branchId: SAMPLE_BRANCH_IDS.remera,
    itemId: 'cat-tiles',
    actor: OWNER,
    movements: [{ type: 'OPENING', delta: '25000000', enteredAs: '25 m²', day: 12 }],
  },
  {
    merchantId: SAMPLE_MERCHANT_ID,
    branchId: SAMPLE_BRANCH_IDS.remera,
    itemId: 'cat-phone',
    actor: OWNER,
    movements: [
      { type: 'OPENING', delta: '42', enteredAs: '42 pc', day: 12 },
      {
        type: 'ADJUST_OUT',
        delta: '-1',
        enteredAs: '1 pc',
        reason: 'Display unit damaged',
        day: 18,
      },
    ],
  },
  {
    merchantId: SAMPLE_MERCHANT_ID,
    branchId: SAMPLE_BRANCH_IDS.cityCentre,
    itemId: 'cat-phone',
    actor: OWNER,
    movements: [{ type: 'OPENING', delta: '15', enteredAs: '15 pc', day: 12 }],
  },
  {
    merchantId: SAMPLE_SECOND_MERCHANT_ID,
    branchId: SAMPLE_BRANCH_IDS.cafe,
    itemId: 'cat-cafe-beans',
    actor: CAFE_OWNER,
    movements: [{ type: 'OPENING', delta: '40000', enteredAs: '40 kg', day: 12 }],
  },
]

const sum = (a: ExactDecimal, b: string) => addExactDecimals(a, parseExactDecimal(b)!)

const built = (() => {
  const balances: StoredBalance[] = []
  const movements: StoredMovement[] = []
  let seq = 0
  SEEDS.forEach((seed, seedIndex) => {
    let running = parseExactDecimal('0')!
    const balanceId = `bal-seed-${String(seedIndex + 1).padStart(3, '0')}`
    const first = at(seed.movements[0]!.day, seedIndex)
    seq += 1
    const balanceSeq = seq
    seed.movements.forEach((movement, index) => {
      running = sum(running, movement.delta)
      seq += 1
      movements.push({
        id: `mov-seed-${String(seedIndex + 1).padStart(3, '0')}-${index + 1}`,
        merchantId: seed.merchantId,
        branchId: seed.branchId,
        itemId: seed.itemId,
        movementType: movement.type,
        quantityDelta: movement.delta,
        balanceAfter: formatExactDecimal(running),
        enteredAs: movement.enteredAs,
        reason: movement.reason ?? null,
        reference: movement.reference ?? null,
        operationId: `00000000-0000-4000-8000-${String(seedIndex + 1).padStart(4, '0')}${String(index + 1).padStart(8, '0')}`,
        fingerprint: `seed-${seedIndex}-${index}`,
        actorUserId: seed.actor.id,
        actorName: seed.actor.name,
        createdAt: at(movement.day, seedIndex),
        seq,
      })
    })
    balances.push({
      id: balanceId,
      merchantId: seed.merchantId,
      branchId: seed.branchId,
      itemId: seed.itemId,
      quantityOnHand: formatExactDecimal(running),
      createdAt: first,
      updatedAt: at(seed.movements[seed.movements.length - 1]!.day, seedIndex),
      seq: balanceSeq,
      version: seed.movements.length - 1,
    })
  })
  return { balances, movements }
})()

export const SAMPLE_INVENTORY_BALANCES: StoredBalance[] = built.balances
export const SAMPLE_STOCK_MOVEMENTS: StoredMovement[] = built.movements
