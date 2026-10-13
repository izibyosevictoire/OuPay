import type {
  AccountLinkRequest,
  AccountLinkValidation,
  NormalizedBankEvent,
  ProviderCapabilities,
  ProviderEventVerificationRequest,
  ProviderEventVerificationResult,
} from '@/types/banking'
import { InvalidProviderEventError, type BankingProviderAdapter } from './bankingProviderAdapter'

/**
 * SIMULATION ONLY. This file is NOT Equity Bank's API. There are no real endpoints, field
 * names, credentials or guarantees here. `SimulatedEquityEventV0` is an invented format used
 * by the demo simulator; a real adapter will be written from Equity's actual documentation
 * once an integration is approved. The `__simulated` marker makes the adapter refuse
 * anything that is not explicitly a simulator payload.
 */
export interface SimulatedEquityEventV0 {
  __simulated: true
  eventId: string
  transactionId: string
  state: 'POSTED' | 'PENDING' | 'REJECTED' | 'REVERSED'
  /** Integer RWF. */
  amount: number
  currency: 'RWF'
  reference?: string | null
  payerName?: string
  occurredAt: string
  /** Opaque ID of the merchant bank account (as stored when the demo link was made). */
  accountRef: string
}

const STATE_TO_STATUS = {
  POSTED: 'CONFIRMED',
  PENDING: 'PENDING',
  REJECTED: 'FAILED',
  REVERSED: 'REVERSED',
} as const

const MAX_AMOUNT = 10_000_000_000

const requireText = (value: unknown, field: string, maxLength = 120): string => {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maxLength) {
    throw new InvalidProviderEventError(`Missing or invalid ${field}.`)
  }
  return value
}

export const equityMockAdapter: BankingProviderAdapter = {
  providerId: 'EQUITY_MOCK',
  displayName: 'Equity Bank (simulated)',
  isSimulated: true,

  // Everything is "supported" because this is a simulator we control. It says nothing
  // about what the real Equity Bank offers; see docs/bank-integration.md.
  getProviderCapabilities(): ProviderCapabilities {
    return {
      transactionWebhooks: 'SUPPORTED',
      webhookSignatureVerification: 'SUPPORTED',
      merchantVerification: 'NOT_SUPPORTED',
      accountLinking: 'SUPPORTED',
      paymentInitiation: 'NOT_SUPPORTED',
      realtimeNotifications: 'SUPPORTED',
      ussdMerchantResolution: 'NOT_SUPPORTED',
      paymentReferenceEcho: 'SUPPORTED',
    }
  },

  async validateAccountLink(request: AccountLinkRequest): Promise<AccountLinkValidation> {
    const reference = request.accountReference.trim().toUpperCase()
    if (reference === 'SIM-ERROR') {
      return {
        isValid: false,
        failureReason: 'Simulated provider error. Try a different demo reference.',
      }
    }
    if (!/^SIM-[A-Z0-9]{4,12}$/.test(reference)) {
      return {
        isValid: false,
        failureReason: 'Demo references look like SIM-1234. Never enter real banking details here.',
      }
    }
    return {
      isValid: true,
      bankAccountId: `bacc-${crypto.randomUUID().slice(0, 8)}`,
      // Display-only hint derived from the demo reference, not a real account number.
      maskedAccount: `••••${reference.slice(-4)}`,
    }
  },

  normalizeTransactionEvent(rawEvent: unknown): NormalizedBankEvent {
    if (typeof rawEvent !== 'object' || rawEvent === null) {
      throw new InvalidProviderEventError('The event is not an object.')
    }
    const event = rawEvent as Partial<SimulatedEquityEventV0>
    if (event.__simulated !== true) {
      throw new InvalidProviderEventError('Only simulator events are accepted by this adapter.')
    }
    const state = event.state
    if (!state || !(state in STATE_TO_STATUS))
      throw new InvalidProviderEventError('Unknown payment state.')
    const amount = event.amount
    if (!Number.isInteger(amount) || (amount as number) <= 0 || (amount as number) > MAX_AMOUNT) {
      throw new InvalidProviderEventError('The amount must be a positive whole number of francs.')
    }
    if (event.currency !== 'RWF') throw new InvalidProviderEventError('Only RWF is supported.')
    const occurredAt = requireText(event.occurredAt, 'timestamp', 40)
    if (Number.isNaN(Date.parse(occurredAt)))
      throw new InvalidProviderEventError('The timestamp is not a date.')

    const reference = typeof event.reference === 'string' ? event.reference.trim() : ''
    return {
      providerId: 'EQUITY_MOCK',
      providerEventId: requireText(event.eventId, 'event ID'),
      providerTransactionId: requireText(event.transactionId, 'transaction ID'),
      status: STATE_TO_STATUS[state],
      direction: 'INCOMING',
      amount: amount as number,
      currency: 'RWF',
      // Kept exactly as sent: matching is exact, so no case folding or guessing.
      paymentReference: reference === '' ? null : reference,
      payerDisplayName:
        (typeof event.payerName === 'string' ? event.payerName.trim() : '').slice(0, 80) ||
        'Unknown payer',
      providerOccurredAt: new Date(occurredAt).toISOString(),
      bankAccountId: requireText(event.accountRef, 'account reference'),
      isSimulated: true,
    }
  },

  async verifyIncomingEvent(
    request: ProviderEventVerificationRequest,
  ): Promise<ProviderEventVerificationResult> {
    // A stand-in for signature verification. A real adapter verifies the bank's signature or
    // approved authentication scheme on the SERVER; nothing here is a real signature check.
    const isFromSimulator = request.headers['x-oupay-simulator'] === 'true'
    return isFromSimulator
      ? { isAuthentic: true }
      : { isAuthentic: false, reason: 'Missing simulator marker.' }
  },
}
