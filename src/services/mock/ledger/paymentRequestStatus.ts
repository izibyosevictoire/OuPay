import type { Invoice } from '@/types/invoice'
import type { BankTransaction, PaymentAllocation } from '@/types/payment'
import type { CustomerPaymentStage, PaymentRequestStatus } from '@/types/paymentProfile'
import { summarizeInvoicePayment } from '@/lib/ledger'
import type { StoredPaymentRequest } from '../sampleLedger'

export interface PaymentRequestState {
  status: PaymentRequestStatus
  stage: CustomerPaymentStage
  /** Bank-confirmed money counted for THIS request only (reversed money excluded). */
  confirmedAmount: number
  /** What is still to pay: for invoices the live remaining balance, for open requests the request. */
  amountDue: number
}

interface DerivationContext {
  /** Bank transactions whose reference exactly matched this request. */
  linkedTransactions: BankTransaction[]
  allocations: PaymentAllocation[]
  invoice?: Invoice
  now: Date
}

/**
 * A payment request's status is DERIVED from the ledger on every read, never stored, so it
 * can never disagree with bank transactions or invoice balances.
 *
 * Expiry only means "no longer collecting". It never implies bank money was returned: money
 * that was confirmed stays confirmed and is still counted, even after expiry.
 */
export function derivePaymentRequestState(
  request: StoredPaymentRequest,
  { linkedTransactions, allocations, invoice, now }: DerivationContext,
): PaymentRequestState {
  const confirmed = linkedTransactions.filter(
    (t) => t.status === 'CONFIRMED' && t.direction === 'INCOMING',
  )
  const confirmedAmount = confirmed.reduce((total, t) => total + t.amount, 0)
  const invoiceRemaining = invoice
    ? summarizeInvoicePayment(
        invoice.grandTotal,
        allocations.filter((a) => a.invoiceId === invoice.id),
      ).remainingBalance
    : null
  const amountDue = invoiceRemaining ?? Math.max(request.requestedAmount - confirmedAmount, 0)

  const result = (
    status: PaymentRequestStatus,
    stage: CustomerPaymentStage,
  ): PaymentRequestState => ({
    status,
    stage,
    confirmedAmount,
    amountDue,
  })

  const invoiceIsClosed =
    invoice !== undefined && (invoice.status === 'VOIDED' || invoice.status === 'CANCELLED')
  if (request.cancelledAt || invoiceIsClosed) return result('CANCELLED', 'CANCELLED')

  if (confirmedAmount > 0) {
    const isSettled = invoice ? invoiceRemaining === 0 : confirmedAmount >= request.requestedAmount
    if (!isSettled) return result('PARTIALLY_SETTLED', 'PARTIALLY_SETTLED')
    // Settled. For an invoice it is reconciled by definition; an open payment is only
    // "reconciled" if its money has been applied to something, otherwise it is an unmatched collection.
    const isApplied = invoice
      ? true
      : confirmed.every((t) =>
          allocations.some((a) => a.bankTransactionId === t.id && a.allocationStatus === 'ACTIVE'),
        )
    return result('SETTLED', isApplied ? 'CONFIRMED_AND_RECONCILED' : 'CONFIRMED_UNMATCHED')
  }

  if (linkedTransactions.some((t) => t.status === 'REVERSED'))
    return result('AWAITING_PAYMENT', 'REVERSED')
  if (linkedTransactions.some((t) => t.status === 'PENDING'))
    return result('AWAITING_PAYMENT', 'BANK_CONFIRMATION_PENDING')
  if (linkedTransactions.some((t) => t.status === 'FAILED'))
    return result('AWAITING_PAYMENT', 'FAILED')
  if (new Date(request.expiresAt) <= now) return result('EXPIRED', 'EXPIRED')

  const wasOpened = Boolean(request.instructionsOpenedAt || request.customerClaimedPaymentAt)
  return result(wasOpened ? 'AWAITING_PAYMENT' : 'CREATED', 'AWAITING_PAYMENT')
}
