export type PaymentServiceErrorCode =
  | 'unauthenticated'
  /** Also used for records the caller may not see, so existence is never revealed. */
  | 'not_found'
  | 'forbidden'
  | 'validation'
  | 'allocation_conflict'
  | 'transaction_not_confirmed'
  | 'invoice_not_payable'
  | 'exceeds_remaining'
  | 'exceeds_unapplied'
  | 'allocation_not_active'
  | 'not_supported'
  | 'invalid_state'
  | 'profile_unavailable'
  | 'request_unavailable'
  | 'no_active_profile'
  | 'service_unavailable'

/** One error type for the payment-side services (reconciliation, banking, links, public pages). */
export class PaymentServiceError extends Error {
  readonly code: PaymentServiceErrorCode

  constructor(code: PaymentServiceErrorCode, message: string) {
    super(message)
    this.name = 'PaymentServiceError'
    this.code = code
  }
}
