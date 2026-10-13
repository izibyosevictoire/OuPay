import type {
  AccountLinkRequest,
  BankConnection,
  PaymentDestination,
  ProviderCapabilities,
  ProviderDescription,
} from '@/types/banking'

export interface ProviderOverview extends ProviderDescription {
  capabilities: ProviderCapabilities
}

/**
 * A merchant's banking configuration: which providers are linked and where customer money
 * should go. Owners only. It stores opaque account references and masked display values, and
 * must never ask for, transmit or store a PIN, password, OTP or online-banking credential.
 *
 * A connection made here with the simulated provider is a DEMO, not a verified bank connection.
 */
export interface BankingConfigurationService {
  listProviders(): Promise<ProviderOverview[]>
  listConnections(merchantId: string): Promise<BankConnection[]>
  listPaymentDestinations(merchantId: string): Promise<PaymentDestination[]>
  /**
   * Starts linking an account. A valid link becomes PENDING until the (simulated) check is
   * completed; an invalid one becomes ERROR with the reason, so the problem stays visible.
   */
  startAccountLink(merchantId: string, request: AccountLinkRequest): Promise<BankConnection>
  completeAccountLink(merchantId: string, connectionId: string): Promise<BankConnection>
  /** Stops using a connection: its payment links stop working and its events are refused. */
  disableConnection(merchantId: string, connectionId: string): Promise<BankConnection>
}
