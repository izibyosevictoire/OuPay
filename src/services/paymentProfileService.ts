import type { PaymentDestination } from '@/types/banking'
import type { PaymentProfile, PaymentRequest } from '@/types/paymentProfile'

export interface PaymentProfileView extends PaymentProfile {
  branchName: string | null
  cashierName: string | null
  destinationLabel: string
  destinationMasked: string
  /** Simulated destinations are demo links, not verified bank connections. */
  isSimulated: boolean
}

/** A request plus the public token of its link, so the merchant can open the customer's page. */
export interface InvoicePaymentRequestView extends PaymentRequest {
  profileToken: string
}

export interface PaymentProfileFormOptions {
  destinations: PaymentDestination[]
  branches: { id: string; name: string }[]
  cashiers: { userId: string; fullName: string; branchIds: string[] }[]
}

export interface CreatePaymentProfileInput {
  label: string
  paymentDestinationId: string
  branchId?: string | null
  assignedCashierId?: string | null
}

/**
 * Merchant-side management of public payment profiles (what QR codes and NFC tags point to)
 * and of invoice payment requests. Public customer pages use PublicPaymentService instead.
 */
export interface PaymentProfileService {
  /** Cashiers see only profiles assigned to them. */
  listProfiles(merchantId: string): Promise<PaymentProfileView[]>
  getProfile(merchantId: string, profileId: string): Promise<PaymentProfileView>
  getFormOptions(merchantId: string): Promise<PaymentProfileFormOptions>
  /** Validates the destination, branch and cashier association at the service boundary. */
  createProfile(merchantId: string, input: CreatePaymentProfileInput): Promise<PaymentProfileView>
  /** Switches a link on or off. A revoked link can never be switched back on. */
  setProfileActive(
    merchantId: string,
    profileId: string,
    isActive: boolean,
  ): Promise<PaymentProfileView>
  /**
   * Replaces an exposed link: the old public token is revoked for good and a new profile with a
   * new token takes its place.
   */
  reissueProfile(merchantId: string, profileId: string): Promise<PaymentProfileView>
  /** A request for an issued invoice, for exactly its outstanding balance. */
  createInvoicePaymentRequest(
    merchantId: string,
    invoiceId: string,
  ): Promise<InvoicePaymentRequestView>
  listInvoicePaymentRequests(
    merchantId: string,
    invoiceId: string,
  ): Promise<InvoicePaymentRequestView[]>
  cancelPaymentRequest(merchantId: string, requestId: string): Promise<PaymentRequest>
}
