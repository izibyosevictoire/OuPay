import type {
  AdjustStockInput,
  InventoryBalancePage,
  InventoryOptions,
  ListBalancesQuery,
  ListMovementsQuery,
  MovementResult,
  OpeningStockInput,
  ReceiveStockInput,
  StockMovementPage,
} from '@/types/inventory'

export type InventoryServiceErrorCode =
  | 'unauthenticated'
  /** Also used for businesses the caller does not belong to. */
  | 'not_found'
  | 'forbidden'
  | 'validation'
  /** The item is not goods: services have no stock. */
  | 'invalid_item'
  | 'package_inactive'
  | 'unsupported_unit'
  | 'dimension_mismatch'
  | 'invalid_quantity'
  | 'invalid_count'
  | 'precision_exceeded'
  | 'quantity_out_of_range'
  | 'invalid_package_conversion'
  /** Stock would go below zero. */
  | 'insufficient_stock'
  | 'opening_already_recorded'
  /** The same operation id was used for a different request. */
  | 'operation_id_reuse'
  | 'branch_inactive'
  | 'inventory_unavailable'
  | 'service_unavailable'

export class InventoryServiceError extends Error {
  readonly code: InventoryServiceErrorCode

  constructor(code: InventoryServiceErrorCode, message: string) {
    super(message)
    this.name = 'InventoryServiceError'
    this.code = code
  }
}

/**
 * Branch-level stock of GOODS (services have none). The server (or the mock) is authoritative for quantities, units,
 * permissions and branch eligibility; the browser validates for convenience only. Quantities travel as plain decimal text.
 * Stock only changes by appending an immutable movement. Every write carries a client operation id, so a retry of the same
 * submission can never add stock twice.
 */
export interface InventoryService {
  /** The branches the caller can view, and where they may record stock. */
  getOptions(merchantId: string): Promise<InventoryOptions>
  /** Newest first, keyset-paged. */
  listBalances(merchantId: string, query?: ListBalancesQuery): Promise<InventoryBalancePage>
  /** Newest first, keyset-paged. */
  listMovements(merchantId: string, query?: ListMovementsQuery): Promise<StockMovementPage>
  /** First stock of an item at a branch; only once, and only before any other movement. */
  recordOpening(merchantId: string, input: OpeningStockInput): Promise<MovementResult>
  receiveStock(merchantId: string, input: ReceiveStockInput): Promise<MovementResult>
  /** A manual correction in one direction, with a required reason. */
  adjustStock(merchantId: string, input: AdjustStockInput): Promise<MovementResult>
}
