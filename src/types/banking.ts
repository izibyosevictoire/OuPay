import type { MerchantOwned } from './merchant'

/**
 * Providers OuPay can talk to. Only `EQUITY_MOCK` exists, and it is a SIMULATION: it is not
 * Equity Bank's real API. The others are placeholders for approved future partners.
 */
export type ProviderId = 'EQUITY_MOCK' | 'MTN_MOMO' | 'AIRTEL_MONEY'

/**
 * Whether a provider offers an operation. `UNCONFIRMED` is the honest default for any real
 * bank until its integration documentation and approval say otherwise: we never assume.
 */
export type CapabilityStatus = 'SUPPORTED' | 'NOT_SUPPORTED' | 'UNCONFIRMED'

export interface ProviderCapabilities {
  transactionWebhooks: CapabilityStatus
  webhookSignatureVerification: CapabilityStatus
  merchantVerification: CapabilityStatus
  accountLinking: CapabilityStatus
  paymentInitiation: CapabilityStatus
  realtimeNotifications: CapabilityStatus
  ussdMerchantResolution: CapabilityStatus
  /** Whether the bank passes OuPay's payment reference back on the transaction event. */
  paymentReferenceEcho: CapabilityStatus
}

export type CapabilityKey = keyof ProviderCapabilities

export interface ProviderDescription {
  id: ProviderId
  displayName: string
  /** True when this provider is a simulator; its data must never be presented as real. */
  isSimulated: boolean
  /** False for placeholders with no adapter yet. */
  isAvailable: boolean
}

/** What a merchant gives OuPay to link a destination. Never credentials, PINs or OTPs. */
export interface AccountLinkRequest {
  providerId: ProviderId
  /** An opaque reference chosen with the bank, NOT an online-banking login. */
  accountReference: string
  accountNickname: string
}

export interface AccountLinkValidation {
  isValid: boolean
  /** Opaque ID OuPay stores instead of any real account number. */
  bankAccountId?: string
  /** For display only, e.g. "••••4821". */
  maskedAccount?: string
  failureReason?: string
}

/** The one shape the reconciliation core understands, whatever the provider sends. */
export interface NormalizedBankEvent {
  providerId: ProviderId
  providerEventId: string
  providerTransactionId: string
  status: 'PENDING' | 'CONFIRMED' | 'FAILED' | 'REVERSED'
  direction: 'INCOMING' | 'OUTGOING'
  /** Integer RWF. */
  amount: number
  currency: 'RWF'
  /** Exact reference the bank reported, if any. Trusted only when it matches exactly. */
  paymentReference: string | null
  payerDisplayName: string
  providerOccurredAt: string
  /** Opaque ID of the merchant bank account the money reached. */
  bankAccountId: string
  isSimulated: boolean
}

export interface ProviderEventVerificationRequest {
  /** Headers and body exactly as received by the (future) trusted backend. */
  headers: Record<string, string>
  rawBody: string
}

export interface ProviderEventVerificationResult {
  isAuthentic: boolean
  reason?: string
}

export type BankConnectionStatus = 'NOT_CONFIGURED' | 'PENDING' | 'CONNECTED' | 'ERROR' | 'DISABLED'

/** A merchant's link to one provider account. Holds only opaque and masked identifiers. */
export interface BankConnection extends MerchantOwned {
  id: string
  providerId: ProviderId
  status: BankConnectionStatus
  accountNickname: string
  bankAccountId: string | null
  maskedAccount: string | null
  /** True when this connection is a demo: it is NOT a verified bank connection. */
  isSimulated: boolean
  lastError: string | null
  createdAt: string
  updatedAt: string
}

/** Where a customer's money should go, as a payment profile sees it. */
export interface PaymentDestination extends MerchantOwned {
  id: string
  bankConnectionId: string
  label: string
  bankAccountId: string
  maskedAccount: string
  providerId: ProviderId
  isSimulated: boolean
  createdAt: string
}
