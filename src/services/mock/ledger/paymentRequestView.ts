import type { PaymentRequest } from '@/types/paymentProfile'
import type { MockAuthStore } from '../mockAuthStore'
import type { StoredPaymentRequest } from '../sampleLedger'
import { derivePaymentRequestState, type PaymentRequestState } from './paymentRequestStatus'
import type { LedgerStore } from './mockLedgerStore'

/**
 * Resolves a stored request against the ledger: which bank transactions belong to it (an EXACT
 * reference match, never amount or time), and the status derived from them.
 */
export function resolvePaymentRequest(
  store: MockAuthStore,
  ledger: LedgerStore,
  stored: StoredPaymentRequest,
  now: Date = new Date(),
): { request: PaymentRequest; state: PaymentRequestState } {
  const linkedTransactions = ledger.bankTransactions
    .load()
    .filter(
      (transaction) =>
        transaction.merchantId === stored.merchantId &&
        (transaction.paymentRequestId === stored.id ||
          transaction.paymentReference === stored.publicReference),
    )
  const allocations = ledger.allocations
    .load()
    .filter((allocation) => allocation.merchantId === stored.merchantId)
  const invoice = stored.invoiceId
    ? store.loadInvoices().find((candidate) => candidate.id === stored.invoiceId)
    : undefined
  const state = derivePaymentRequestState(stored, { linkedTransactions, allocations, invoice, now })
  return { request: { ...stored, status: state.status }, state }
}
