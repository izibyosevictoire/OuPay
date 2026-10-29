import type {
  PosBillInput,
  PosBilledSale,
  PosBillingReview,
  PosCatalogItem,
  PosDraft,
  PosDraftInput,
  PosDraftPage,
  PosDraftUpdateInput,
  PosFulfilmentException,
  PosOptions,
  PosQuote,
  PosQuoteInput,
} from '@/types/pos'

export type PosServiceErrorCode =
  | 'unauthenticated'
  /** Also used for businesses, branches and drafts the caller may not see. */
  | 'not_found'
  | 'forbidden'
  | 'validation'
  | 'pos_unavailable'
  | 'no_eligible_branch'
  | 'branch_not_eligible'
  | 'invalid_cart'
  | 'version_conflict'
  | 'draft_not_open'
  | 'draft_already_billed'
  | 'bill_conflict'
  | 'review_changed'
  | 'tax_not_configured'
  | 'tax_not_approved'
  | 'insufficient_stock'
  | 'amount_out_of_range'
  | 'price_zero_not_billable'
  | 'no_assigned_code'
  | 'code_not_available'
  | 'code_not_assigned'
  | 'code_required'
  | 'live_collection_unavailable'
  | 'too_many_lines'
  | 'pricing_mismatch'
  | 'client_request_id_reuse'
  | 'idempotency_key_reuse'
  | 'request_in_progress'
  | 'service_unavailable'

export class PosServiceError extends Error {
  readonly code: PosServiceErrorCode

  constructor(code: PosServiceErrorCode, message: string) {
    super(message)
    this.name = 'PosServiceError'
    this.code = code
  }
}

/**
 * The business POS: prices a cart of goods and services from the catalog and saves it as a draft. A draft is NOT a sale: it issues
 * no invoice, opens no payment request and reserves or deducts no stock (R7b does that on "Bill"). Membership, permission,
 * operating mode and branch eligibility are verified by the service itself.
 */
export interface PosService {
  getPosOptions(merchantId: string): Promise<PosOptions>
  /** The active goods and services a cart can hold, with current prices and the branch's informational stock. */
  searchPosItems(merchantId: string, branchId: string, query?: string): Promise<PosCatalogItem[]>
  /** Prices a cart without saving anything. Lines that can not be priced are explained in `problems`, never rounded or guessed. */
  quotePosCart(merchantId: string, input: PosQuoteInput): Promise<PosQuote>
  /** Saves a cart as a draft. Repeating the same attempt (same ids, same cart) returns the original draft, never a second one. */
  createPosDraft(merchantId: string, input: PosDraftInput): Promise<PosDraft>
  listPosDrafts(merchantId: string, cursor?: string | null): Promise<PosDraftPage>
  getPosDraft(merchantId: string, draftId: string): Promise<PosDraft>
  /** Replaces the whole cart of an open draft (re-priced at the current catalog prices). */
  updatePosDraft(merchantId: string, draftId: string, input: PosDraftUpdateInput): Promise<PosDraft>
  discardPosDraft(merchantId: string, draftId: string, expectedVersion: number): Promise<PosDraft>
  /**
   * The FINAL review of an open draft: current catalog prices, tax and availability as the server sees them now. Changes nothing.
   * Billing is only offered for a review the server calls billable.
   */
  getBillingReview(
    merchantId: string,
    draftId: string,
    collectionCodeId?: string | null,
  ): Promise<PosBillingReview>
  /**
   * Bills a draft atomically (invoice, payment request through the cashier's code, goods reserved). Repeating the same attempt returns the
   * original sale, never a second one. Refused with `review_changed` when price, tax or total differ from what was reviewed.
   */
  billPosDraft(merchantId: string, draftId: string, input: PosBillInput): Promise<PosBilledSale>
  /** One POS sale with its lines, tax and reservation: safe recovery after a refresh. */
  getPosSale(merchantId: string, saleId: string): Promise<PosBilledSale>
  /** The OPEN fulfilment exceptions of the business (paid sales that need an owner's decision). Owners only. Read-only. */
  listFulfilmentExceptions(merchantId: string): Promise<PosFulfilmentException[]>
}
