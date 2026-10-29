import type { StockMovementType } from '@/types/inventory'

export const STOCK_MOVEMENT_LABELS: Record<StockMovementType, string> = {
  OPENING: 'Opening stock',
  RECEIVE: 'Received',
  ADJUST_IN: 'Adjusted in',
  ADJUST_OUT: 'Adjusted out',
  SALE: 'Sold (paid sale)',
}

export const INVENTORY_PAGE_SIZE = 20
export const INVENTORY_MAX_REASON = 200
export const INVENTORY_MAX_REFERENCE = 100

/** UX mirror of the server's UUID check for the operation identity. */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
