import type {
  AccountLinkRequest,
  AccountLinkValidation,
  NormalizedBankEvent,
  ProviderCapabilities,
  ProviderEventVerificationRequest,
  ProviderEventVerificationResult,
  ProviderId,
} from '@/types/banking'

/** Thrown when a provider payload cannot be turned into a trustworthy normalized event. */
export class InvalidProviderEventError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidProviderEventError'
  }
}

/**
 * The boundary between OuPay and any bank. Reconciliation only ever sees
 * `NormalizedBankEvent`, so adding a bank means adding an adapter, not touching the ledger.
 *
 * Operations a real bank may not offer are OPTIONAL: an adapter implements only what that
 * bank's documented API actually provides, and `getProviderCapabilities` says so honestly.
 * Callers must check for the method (and the capability) before using it.
 *
 * IMPORTANT: in production these adapters run on a trusted SERVER. This frontend only
 * contains a simulated one, used by the demo simulator. Real bank credentials never belong
 * in browser code.
 */
export interface BankingProviderAdapter {
  readonly providerId: ProviderId
  readonly displayName: string
  /** True for simulators: everything they produce must be labelled as simulated. */
  readonly isSimulated: boolean

  getProviderCapabilities(): ProviderCapabilities

  /** Only for providers that offer account linking. */
  validateAccountLink?(request: AccountLinkRequest): Promise<AccountLinkValidation>

  /** Pure and synchronous: turns a raw payload into the one shape the ledger understands. */
  normalizeTransactionEvent(rawEvent: unknown): NormalizedBankEvent

  /**
   * Only for providers that sign or otherwise authenticate their events. When present, the
   * trusted backend must call it BEFORE normalizing and reject anything not authentic.
   */
  verifyIncomingEvent?(
    request: ProviderEventVerificationRequest,
  ): Promise<ProviderEventVerificationResult>
}
