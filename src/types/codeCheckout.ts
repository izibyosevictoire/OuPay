/**
 * Agent code checkout: an authorised agent bills an amount through the merchant's collection code.
 *
 * MONEY: `amountRwf` is a whole number of Rwandan francs, never a float. The server is authoritative. It decides which code the
 * sale uses, whether the sale is a DEMONSTRATION or LIVE, the expiry and the status. Nothing here can mark anything as paid:
 * a payment is confirmed only from bank-verified events, and only after it has been applied to the sale.
 */

/** What is needed before billing can work. READY, or the first thing that is missing. */
export type CodeCheckoutReadiness =
  'READY' | 'NO_ASSIGNED_CODE' | 'CODE_NOT_AVAILABLE' | 'NO_PAYMENT_LINK'

/** DEMONSTRATION: a simulated or not-yet-approved code (no real payment can be made). LIVE: a bank-approved code. */
export type CodeSaleMode = 'DEMONSTRATION' | 'LIVE'

export interface CodeChoice {
  id: string
  label: string
  /** UNAVAILABLE codes are listed with the reason, so the agent knows why they cannot bill with them. */
  mode: CodeSaleMode | 'UNAVAILABLE'
  reason: string | null
  /** A payment link on this code's own settlement account exists right now. */
  paymentReady: boolean
  branchName: string | null
}

export interface CodeCheckoutOptions {
  readiness: CodeCheckoutReadiness
  /** Only the codes THIS person holds. */
  codes: CodeChoice[]
  minAmountRwf: number
  maxAmountRwf: number
  paymentLifetimeMinutes: number
  liveCollectionEnabled: boolean
  note: string | null
}

/**
 * One billing attempt. `clientRequestId` is the sale's permanent identifier and `idempotencyKey` the transport retry key. Both are
 * created once per attempt and reused when the SAME sale is retried (a lost response), so a retry never creates a second sale.
 */
export interface CodeSaleInput {
  amountRwf: number
  description?: string
  /** Required only when the person holds more than one code. */
  collectionCodeId?: string
  branchId?: string
  clientRequestId: string
  idempotencyKey: string
}

/** What the customer is shown to pay with. `bankCode` exists ONLY for a LIVE sale. */
export interface CodePresentation {
  mode: CodeSaleMode
  label: string
  bankCode: string | null
  /** OuPay's internal reference of a demonstration code. It is never a payment code. */
  demoReference: string | null
  notice: string | null
}

export type CodeSaleRequestStatus =
  'CREATED' | 'AWAITING_PAYMENT' | 'PARTIALLY_SETTLED' | 'SETTLED' | 'EXPIRED' | 'CANCELLED'

export type CodeSaleStage =
  | 'AWAITING_PAYMENT'
  | 'BANK_CONFIRMATION_PENDING'
  | 'CONFIRMED_AND_RECONCILED'
  | 'CONFIRMED_UNMATCHED'
  | 'PARTIALLY_SETTLED'
  | 'FAILED'
  | 'EXPIRED'
  | 'REVERSED'
  | 'CANCELLED'

export interface CodeSale {
  saleId: string
  invoiceId: string
  invoiceNumber: string
  /** The reference the sale is known by (the payment request's public reference). */
  saleReference: string
  amountRwf: number
  currency: 'RWF'
  description: string
  status: CodeSaleRequestStatus
  stage: CodeSaleStage
  confirmedAmount: number
  amountDue: number
  expiresAt: string
  createdAt: string
  merchantDisplayName: string
  branchName: string
  agentName: string
  code: CodePresentation
}

/** What the customer sees, in plain words. PAID only after verified money has been applied to the sale. */
export type CodeSaleCustomerStatus =
  | 'AWAITING_PAYMENT'
  | 'PARTIALLY_PAID'
  | 'PAID'
  | 'EXPIRED'
  | 'CANCELLED'
  | 'REQUIRES_RECONCILIATION'

/** The customer's page: no agent, no staff, no account, no internal identifier. */
export interface PublicCodeSale {
  merchantDisplayName: string
  saleReference: string
  amountRwf: number
  currency: 'RWF'
  description: string | null
  status: CodeSaleCustomerStatus
  confirmedAmount: number
  amountDue: number
  expiresAt: string
  code: CodePresentation
  /** Only wording Equity has confirmed; empty until then. */
  instructions: string[]
  statusNote: string
}
