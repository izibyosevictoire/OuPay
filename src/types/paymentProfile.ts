import type { ProviderId } from './banking'
import type { MerchantOwned } from './merchant'

export type PaymentProfileStatus = 'ACTIVE' | 'INACTIVE' | 'REVOKED'

/**
 * A merchant's public payment identity: what a QR code or NFC tag points at. The public
 * token is an opaque, unpredictable identifier. It is NOT a secret or an authentication
 * credential: anyone holding the URL can open the page, so it must reveal nothing private.
 */
export interface PaymentProfile extends MerchantOwned {
  /** Internal ID. Never shown publicly. */
  id: string
  /** The public, opaque token used in the payment URL. */
  paymentProfileId: string
  merchantDisplayName: string
  label: string
  branchId: string | null
  assignedCashierId: string | null
  paymentDestinationId: string
  status: PaymentProfileStatus
  createdAt: string
  updatedAt: string
  /** When a link was replaced after exposure, the profile that superseded this one. */
  replacedByProfileId?: string
  /**
   * Future: cards and bracelets assigned to this profile. Hardware UIDs are NEVER used as
   * authentication; a tag only carries the public URL.
   */
  deviceAssignments?: PaymentDeviceAssignment[]
}

export interface PaymentDeviceAssignment {
  id: string
  kind: 'CARD' | 'BRACELET'
  /** Human label (e.g. "Bracelet 12"). Not a trust anchor. */
  label: string
  assignedAt: string
}

export type PaymentRequestStatus =
  'CREATED' | 'AWAITING_PAYMENT' | 'PARTIALLY_SETTLED' | 'SETTLED' | 'EXPIRED' | 'CANCELLED'

/**
 * A request to collect money. Separate from the Invoice (a commercial document) and from
 * BankTransaction (what the bank confirms). `status` is derived on every read from linked
 * bank transactions, so it can never disagree with the ledger.
 */
export interface PaymentRequest extends MerchantOwned {
  id: string
  paymentProfileId: string
  invoiceId: string | null
  /** Integer RWF requested at creation. For invoices the live amount due is the remaining balance. */
  requestedAmount: number
  currency: 'RWF'
  /** High-entropy reference shown to the customer. The bank may or may not pass it back. */
  publicReference: string
  status: PaymentRequestStatus
  expiresAt: string
  createdAt: string
  updatedAt: string
  cancelledAt?: string
  /** The customer opened the payment instructions. */
  instructionsOpenedAt?: string
  /** The customer SAYS they started a payment. A claim only, never confirmation. */
  customerClaimedPaymentAt?: string
}

export type PaymentMethodId = 'EQUITY_MERCHANT' | 'MTN_MOMO' | 'AIRTEL_MONEY'

export interface PaymentMethodDefinition {
  id: PaymentMethodId
  label: string
  providerId: ProviderId
}

export interface PublicPaymentMethod {
  id: PaymentMethodId
  label: string
  /** Usable only when the provider's capabilities and the merchant's configuration support it. */
  isUsable: boolean
  unavailableReason?: string
  isSimulated: boolean
  /** Plain-language steps. Never a made-up USSD code, deep link or payment endpoint. */
  instructions: string[]
}

/** What an anonymous customer may learn about a profile. Deliberately minimal. */
export interface PublicProfileView {
  merchantDisplayName: string
  branchName: string | null
  /** First name and initial only. */
  cashierDisplayName: string | null
  /** True only when the merchant has actually been verified by OuPay. */
  isMerchantVerified: boolean
  status: 'ACTIVE' | 'UNAVAILABLE'
  paymentMethods: PublicPaymentMethod[]
}

/** The four things the customer must never confuse. */
export type CustomerPaymentStage =
  | 'AWAITING_PAYMENT'
  | 'BANK_CONFIRMATION_PENDING'
  | 'CONFIRMED_AND_RECONCILED'
  | 'CONFIRMED_UNMATCHED'
  | 'PARTIALLY_SETTLED'
  | 'FAILED'
  | 'EXPIRED'
  | 'REVERSED'
  | 'CANCELLED'

export interface PublicRequestView {
  profile: PublicProfileView
  /** The invoice number, only for invoice-linked requests. */
  invoiceReference: string | null
  requestedAmount: number
  /** What is still to pay. For invoices this is the actual remaining balance. */
  amountDue: number
  currency: 'RWF'
  /** Bank-confirmed money counted for THIS request only. */
  confirmedAmount: number
  publicReference: string
  isAmountFixed: boolean
  stage: CustomerPaymentStage
  expiresAt: string
  instructionsOpened: boolean
  customerClaimedPayment: boolean
  isSimulated: boolean
}
