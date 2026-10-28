import type {
  CodeCheckoutOptions,
  CodeSale,
  CodeSaleInput,
  PublicCodeSale,
} from '@/types/codeCheckout'

export type CodeCheckoutServiceErrorCode =
  | 'unauthenticated'
  /** Also used for businesses and sales the caller may not see. */
  | 'not_found'
  | 'forbidden'
  | 'validation'
  /** The person holds no collection code. */
  | 'no_assigned_code'
  /** The chosen code is not one of the person's own. */
  | 'code_not_assigned'
  | 'code_required'
  /** The code is not eligible right now (suspended, branch or account unavailable...). */
  | 'code_not_available'
  /** A bank-approved code, but live collection is not enabled: nothing is billed. */
  | 'live_collection_unavailable'
  | 'no_eligible_branch'
  | 'branch_required'
  | 'branch_not_eligible'
  | 'no_active_profile'
  | 'client_request_id_reuse'
  | 'idempotency_key_reuse'
  | 'request_in_progress'
  | 'service_unavailable'

export class CodeCheckoutServiceError extends Error {
  readonly code: CodeCheckoutServiceErrorCode

  constructor(code: CodeCheckoutServiceErrorCode, message: string) {
    super(message)
    this.name = 'CodeCheckoutServiceError'
    this.code = code
  }
}

/**
 * Billing through a collection code. The signed-in person's membership, permission, code assignment and eligibility are verified
 * by the service itself; the server (or the mock) is authoritative and the browser can send anything. Nothing here can claim a
 * payment: status is read, never set.
 */
export interface CodeCheckoutService {
  /** The caller's own codes and whether each can bill right now, with the reason when not. */
  getCodeCheckoutOptions(merchantId: string): Promise<CodeCheckoutOptions>
  /**
   * Creates the invoice, the payment request and the sale record atomically. Repeating the same attempt returns the original sale;
   * the same `clientRequestId` with a different sale is refused (`client_request_id_reuse`).
   */
  billCodeSale(merchantId: string, input: CodeSaleInput): Promise<CodeSale>
  /** The same sale again, with its current status (a refresh, a lost response). */
  getCodeSale(merchantId: string, saleId: string): Promise<CodeSale>
}

/** The customer's page: anonymous and read-only. The sale reference is the only key. */
export interface PublicCodeSaleService {
  getPublicCodeSale(saleReference: string): Promise<PublicCodeSale>
}
