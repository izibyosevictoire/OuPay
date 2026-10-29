import { PosServiceError } from '@/services/posService'
import type { PosAvailability, PosTaxCategory } from '@/types/pos'
import { friendlyQuantity } from './posRules'

const TAX_LABEL: Record<PosTaxCategory, string> = {
  NOT_APPLICABLE: 'Not applicable',
  EXEMPT: 'Exempt',
  ZERO_RATED: 'Zero-rated',
  STANDARD: 'Standard',
}

export const taxLabelOf = (category: PosTaxCategory | null, rateBp: number | null) => {
  if (!category) return 'Not configured'
  return category === 'STANDARD' && rateBp !== null
    ? `${TAX_LABEL.STANDARD} ${(rateBp / 100).toFixed(2)}%`
    : TAX_LABEL[category]
}

/** Physical, reserved and available stock are kept apart, in words. */
export function availabilityText(a: PosAvailability): string {
  switch (a.state) {
    case 'NOT_TRACKED':
      return 'Service: no stock needed'
    case 'NO_STOCK_RECORD':
      return 'No stock recorded at this branch'
    default:
      return (
        `Physical ${friendlyQuantity(a.physical, a.canonicalUnit)} · ` +
        `reserved ${friendlyQuantity(a.reserved, a.canonicalUnit)} · ` +
        `available ${friendlyQuantity(a.available, a.canonicalUnit)}` +
        (a.state === 'INSUFFICIENT'
          ? `, ${friendlyQuantity(a.requested, a.canonicalUnit)} needed`
          : '')
      )
  }
}

/** What a failed bill means for the cashier, in plain words, and whether pressing Bill again is safe. */
export function billFailure(error: unknown): {
  message: string
  retrySafe: boolean
  review: boolean
} {
  if (error instanceof PosServiceError) {
    if (error.code === 'service_unavailable') {
      return {
        message:
          'We could not confirm whether this sale was billed. Press Bill again: the same bill is never made twice.',
        retrySafe: true,
        review: false,
      }
    }
    return {
      message: error.message,
      retrySafe: error.code === 'request_in_progress',
      review: ['review_changed', 'version_conflict', 'insufficient_stock'].includes(error.code),
    }
  }
  return {
    message: 'The sale could not be billed. Please try again.',
    retrySafe: true,
    review: false,
  }
}
