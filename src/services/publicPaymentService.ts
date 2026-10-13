import type { PublicProfileView, PublicRequestView } from '@/types/paymentProfile'

/**
 * What an anonymous customer can do. No sign-in, so every method takes only public tokens and
 * returns only what that customer may know: the merchant's display name, the amount, the
 * reference and the status of THIS payment request. Never other transactions, payers, staff
 * or business details, and never any banking detail beyond a generic instruction.
 *
 * Nothing here can confirm a payment. The customer can say they started one, but only a
 * trusted bank event (via the event processor) can establish receipt.
 */
export interface PublicPaymentService {
  /** Unknown tokens fail with `not_found`; inactive or revoked ones return an UNAVAILABLE view. */
  getProfile(paymentProfileId: string): Promise<PublicProfileView>
  /** An "open" request where the customer chooses the amount (e.g. a QR scan or bracelet tap). */
  createOpenRequest(paymentProfileId: string, amountInRwf: number): Promise<PublicRequestView>
  getRequest(paymentProfileId: string, publicReference: string): Promise<PublicRequestView>
  /** Records that the customer opened the payment instructions. */
  markInstructionsOpened(paymentProfileId: string, publicReference: string): Promise<void>
  /**
   * Records the customer's CLAIM that they started a payment. It is shown as a claim and
   * changes nothing about the verified status.
   */
  claimPaymentInitiated(paymentProfileId: string, publicReference: string): Promise<void>
}
