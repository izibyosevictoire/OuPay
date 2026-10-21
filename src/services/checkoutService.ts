import type {
  SimpleCheckoutInput,
  SimpleCheckoutOptions,
  SimpleCheckoutResult,
} from '@/types/checkout'

export type CheckoutServiceErrorCode =
  | 'unauthenticated'
  /** Also used for businesses the caller does not belong to. */
  | 'not_found'
  | 'forbidden'
  | 'validation'
  | 'checkout_not_available'
  | 'no_eligible_branch'
  | 'branch_required'
  | 'branch_not_eligible'
  | 'branch_inactive'
  | 'assignee_not_eligible'
  | 'no_active_profile'
  | 'client_request_id_reuse'
  | 'idempotency_key_reuse'
  | 'request_in_progress'
  | 'service_unavailable'

export class CheckoutServiceError extends Error {
  readonly code: CheckoutServiceErrorCode

  constructor(code: CheckoutServiceErrorCode, message: string) {
    super(message)
    this.name = 'CheckoutServiceError'
    this.code = code
  }
}

/**
 * Amount-only billing for SIMPLIFIED businesses. The signed-in person's membership, permission, branch
 * eligibility and the business's operating mode are verified by the service itself; the server (or the
 * mock) is authoritative and the browser can send anything.
 */
export interface CheckoutService {
  /** What the checkout page needs before it shows the form. A business in another mode is told so, not hidden. */
  getSimpleCheckoutOptions(merchantId: string): Promise<SimpleCheckoutOptions>
  /**
   * Creates and issues one invoice and a fixed-amount payment request for it, atomically. Repeating the same
   * attempt (same ids, same sale) returns the original result; the same `clientRequestId` with a different
   * sale is refused (`client_request_id_reuse`).
   */
  billSimpleCheckout(merchantId: string, input: SimpleCheckoutInput): Promise<SimpleCheckoutResult>
}
