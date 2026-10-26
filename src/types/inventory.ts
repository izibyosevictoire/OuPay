import type { MeasurementDimension, MeasurementUnitCode } from './catalog'

/**
 * Movement types implemented so far. Stock only changes by appending a movement: history is never edited, and a correction
 * is a new movement.
 */
export type StockMovementType = 'OPENING' | 'RECEIVE' | 'ADJUST_IN' | 'ADJUST_OUT'

export interface InventoryBranchOption {
  id: string
  name: string
  code: string
  status: 'ACTIVE' | 'INACTIVE'
  /** The caller may record stock here: an active branch and, unless they are an owner, one they are assigned to. */
  writable: boolean
}

export interface InventoryOptions {
  /** The branches the caller may view stock for. */
  branches: InventoryBranchOption[]
}

export interface InventoryBalance {
  id: string
  branchId: string
  branchName: string
  branchCode: string
  itemId: string
  itemName: string
  itemCode: string | null
  measurementDimension: MeasurementDimension
  /** The unit stock is kept in. */
  stockUnit: MeasurementUnitCode
  /** Plain decimal text in the stock unit. Never a JSON number. */
  quantityOnHand: string
  saleUnit: MeasurementUnitCode
  /** The same quantity in the item's selling unit; exact. */
  quantityInSaleUnit: string
  updatedAt: string
  version: number
}

export interface StockMovement {
  id: string
  branchId: string
  branchName: string
  itemId: string
  itemName: string
  movementType: StockMovementType
  /** SIGNED plain decimal in the stock unit: "-250" for stock taken out. */
  quantityDelta: string
  balanceAfter: string
  stockUnit: MeasurementUnitCode
  /** How the quantity was entered, for example "25 kg" or "2 x Bag". */
  enteredAs: string | null
  reason: string | null
  reference: string | null
  operationId: string
  actorName: string
  createdAt: string
}

export interface MovementResult {
  movement: StockMovement
  balance: InventoryBalance
  /** True when the same operation id was sent before with an identical request: nothing was added again. */
  replayed: boolean
}

export interface InventoryBalancePage {
  items: InventoryBalance[]
  nextCursor: string | null
  totalCount: number | null
}

export interface StockMovementPage {
  items: StockMovement[]
  nextCursor: string | null
  totalCount: number | null
}

export interface ListBalancesQuery {
  limit?: number
  cursor?: string | null
  branchId?: string
  itemId?: string
  /** Matches the item name or code. */
  q?: string
}

export interface ListMovementsQuery {
  limit?: number
  cursor?: string | null
  branchId?: string
  itemId?: string
  type?: StockMovementType
}

/** Either an amount in a unit of the item's dimension, or a count of one of the item's packages. Never both. */
export type StockQuantityEntry =
  | { amount: string; unit: MeasurementUnitCode; packageId?: undefined; packageCount?: undefined }
  | { packageId: string; packageCount: string; amount?: undefined; unit?: undefined }

interface StockOperationBase {
  /**
   * The durable identity of ONE submission. Sent again unchanged on a retry, it can never add stock twice; a different
   * request under the same id is refused.
   */
  clientOperationId: string
  branchId: string
  itemId: string
  reference?: string
  reason?: string
}

export type OpeningStockInput = StockOperationBase & StockQuantityEntry
export type ReceiveStockInput = StockOperationBase & StockQuantityEntry
export type AdjustStockInput = StockOperationBase &
  StockQuantityEntry & { direction: 'IN' | 'OUT'; reason: string }
