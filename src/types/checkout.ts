import type { PaymentRequestStatus } from './paymentProfile'

/**
 * Simplified checkout: amount-only billing for a business in SIMPLIFIED mode.
 *
 * MONEY: `amountRwf` is a whole number of Rwandan francs, never a float. The server is authoritative:
 * it re-validates the amount, chooses the sale channel, tax, payment lifetime and status, and confirms
 * payment only from bank-verified events. Nothing here can mark anything as paid.
 */

/** What is needed before billing can work. READY, or the first thing the business must set up. */
export type CheckoutReadiness = 'READY' | 'NOT_SIMPLIFIED' | 'NO_BRANCH' | 'NO_PAYMENT_LINK'

export interface CheckoutBranchChoice {
  id: string
  name: string
  code: string
  /** A payment link that can collect for this branch (and this person) exists right now. */
  paymentReady: boolean
}

export interface SimpleCheckoutOptions {
  operatingMode: 'BUSINESS' | 'SIMPLIFIED'
  readiness: CheckoutReadiness
  /** Branches THIS person may bill at. */
  branches: CheckoutBranchChoice[]
  minAmountRwf: number
  maxAmountRwf: number
  /** How long a payment request stays open, decided by the server. */
  paymentLifetimeMinutes: number
  defaultDescription: string
}

/**
 * One billing attempt. `clientRequestId` is the sale's permanent identifier and `idempotencyKey` the
 * transport-level retry key: both are created once per attempt and reused when the SAME sale is retried
 * (a lost response), so a retry can never create a second sale. Change the sale, get new ones.
 */
export interface SimpleCheckoutInput {
  amountRwf: number
  description?: string
  /** Required only when the person may bill at more than one branch. */
  branchId?: string
  clientRequestId: string
  idempotencyKey: string
}

export interface SimpleCheckoutResult {
  invoiceId: string
  invoiceNumber: string
  paymentRequestId: string
  publicReference: string
  amountRwf: number
  currency: 'RWF'
  description: string
  /** The status at the time of the answer. Live status always comes from reading the request again. */
  status: PaymentRequestStatus
  expiresAt: string
  createdAt: string
  merchantDisplayName: string
  branchId: string
  branchName: string
  /** The public token of the payment link the customer pays through. */
  profileToken: string
  /** Where the customer's page lives, relative to the public payment site. */
  paymentPath: string
}
