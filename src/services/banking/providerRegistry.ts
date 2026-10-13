import type {
  CapabilityKey,
  ProviderCapabilities,
  ProviderDescription,
  ProviderId,
} from '@/types/banking'
import type { BankingProviderAdapter } from './bankingProviderAdapter'
import { equityMockAdapter } from './equityMockAdapter'

const ADAPTERS: Partial<Record<ProviderId, BankingProviderAdapter>> = {
  EQUITY_MOCK: equityMockAdapter,
}

/** Provider IDs that have a working adapter. Everything else is a placeholder. */
export function getAdapter(providerId: ProviderId): BankingProviderAdapter | null {
  return ADAPTERS[providerId] ?? null
}

export const PROVIDER_DESCRIPTIONS: ProviderDescription[] = [
  {
    id: 'EQUITY_MOCK',
    displayName: 'Equity Bank (simulated)',
    isSimulated: true,
    isAvailable: true,
  },
  { id: 'MTN_MOMO', displayName: 'MTN MoMo', isSimulated: false, isAvailable: false },
  { id: 'AIRTEL_MONEY', displayName: 'Airtel Money', isSimulated: false, isAvailable: false },
]

export const getProviderDescription = (providerId: ProviderId) =>
  PROVIDER_DESCRIPTIONS.find((description) => description.id === providerId)!

/** Capabilities for providers without an adapter: nothing is assumed. */
const ALL_UNCONFIRMED: ProviderCapabilities = {
  transactionWebhooks: 'UNCONFIRMED',
  webhookSignatureVerification: 'UNCONFIRMED',
  merchantVerification: 'UNCONFIRMED',
  accountLinking: 'UNCONFIRMED',
  paymentInitiation: 'UNCONFIRMED',
  realtimeNotifications: 'UNCONFIRMED',
  ussdMerchantResolution: 'UNCONFIRMED',
  paymentReferenceEcho: 'UNCONFIRMED',
}

export const getCapabilities = (providerId: ProviderId): ProviderCapabilities =>
  getAdapter(providerId)?.getProviderCapabilities() ?? ALL_UNCONFIRMED

export const hasCapability = (providerId: ProviderId, capability: CapabilityKey) =>
  getCapabilities(providerId)[capability] === 'SUPPORTED'

/**
 * The REAL Equity Bank Rwanda integration: not built, not approved, nothing confirmed.
 * Shown to merchants so a simulated connection is never mistaken for it.
 */
export const REAL_EQUITY_READINESS = {
  displayName: 'Equity Bank Rwanda (real integration)',
  status: 'NOT INTEGRATED: pending bank documentation and approval',
  capabilities: ALL_UNCONFIRMED,
} as const

export const CAPABILITY_LABELS: Record<CapabilityKey, string> = {
  transactionWebhooks: 'Transaction notifications to OuPay (webhooks)',
  webhookSignatureVerification: 'Signed / authenticated events',
  merchantVerification: 'Merchant verification',
  accountLinking: 'Merchant account linking',
  paymentInitiation: 'Payment initiation',
  realtimeNotifications: 'Real-time notifications',
  ussdMerchantResolution: 'USSD merchant-code resolution',
  paymentReferenceEcho: 'Passes OuPay’s payment reference back',
}
