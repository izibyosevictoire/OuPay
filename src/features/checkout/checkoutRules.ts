import type { Invoice, InvoicePaymentStatus } from '@/types/invoice'
import type { PaymentRequestStatus } from '@/types/paymentProfile'

/**
 * Parses what a person typed as an amount of Rwandan francs. WHOLE francs only: spaces and commas are allowed as
 * thousands separators and nothing else is (no decimal point, no sign, no letters), so no floating-point value ever
 * reaches the server. This is a convenience for the form; the server re-validates everything.
 */
export type AmountParse = { ok: true; amount: number } | { ok: false; message: string }

export function parseAmountInput(raw: string, min: number, max: number): AmountParse {
  const compact = raw.replace(/[\s,]/g, '')
  if (compact === '') return { ok: false, message: 'Enter the amount to collect.' }
  if (!/^\d+$/.test(compact)) {
    return { ok: false, message: 'Use whole francs only: digits, with no decimals or symbols.' }
  }
  // More than 15 digits cannot be a safe integer and is far above any limit anyway.
  if (compact.length > 15) return { ok: false, message: rangeMessage(min, max) }
  const amount = Number(compact)
  if (amount < min || amount > max) return { ok: false, message: rangeMessage(min, max) }
  return { ok: true, amount }
}

const rangeMessage = (min: number, max: number) =>
  `Enter an amount between RWF ${min.toLocaleString('en')} and RWF ${max.toLocaleString('en')}.`

/** What the cashier sees. Derived ONLY from what the server reported: never from a timer or a button. */
export type SaleStage =
  'AWAITING_PAYMENT' | 'PARTIALLY_PAID' | 'CONFIRMED' | 'EXPIRED' | 'CANCELLED' | 'NEEDS_ATTENTION'

export interface SaleStatus {
  stage: SaleStage
  label: string
  detail: string
  /** The request still accepts payment: its QR code and link are worth showing. */
  isLive: boolean
  /** The sale is finished one way or another: starting a new one needs no confirmation. */
  isFinished: boolean
}

/**
 * Combines the payment request's status with the invoice's reconciled payment status (both read from the server) into
 * one honest description. "Confirmed" requires the bank-verified ledger to say the invoice is paid; a request that merely
 * exists, or a customer's own claim, never counts.
 */
export function describeSaleStatus(
  request: PaymentRequestStatus,
  invoice: Pick<Invoice, 'status' | 'paymentStatus' | 'payment'> | undefined,
): SaleStatus {
  const payment: InvoicePaymentStatus | undefined = invoice?.paymentStatus
  if (payment === 'REFUNDED' || payment === 'OVERPAID') {
    return attention(
      payment === 'OVERPAID'
        ? 'More than the amount was received. Review it under Payments.'
        : 'This payment was refunded. Review it under Payments.',
    )
  }
  if (invoice?.status === 'VOIDED' || invoice?.status === 'CANCELLED' || request === 'CANCELLED') {
    return {
      stage: 'CANCELLED',
      label: 'Cancelled',
      detail: 'This payment request was cancelled. Nothing more will be collected on it.',
      isLive: false,
      isFinished: true,
    }
  }
  if (request === 'SETTLED' && payment === 'PAID') {
    return {
      stage: 'CONFIRMED',
      label: 'Payment confirmed',
      detail: 'The bank has confirmed this payment.',
      isLive: false,
      isFinished: true,
    }
  }
  if (request === 'SETTLED') {
    // The request says settled but the invoice is not reconciled as paid: never show success on half the evidence.
    return attention(
      'The bank reported a payment that is not fully matched yet. Review it under Payments.',
    )
  }
  if (request === 'PARTIALLY_SETTLED' || payment === 'PARTIALLY_PAID') {
    if (request === 'EXPIRED') {
      return attention(
        'Part of the amount was confirmed before this request expired. Review it under Payments.',
      )
    }
    return {
      stage: 'PARTIALLY_PAID',
      label: 'Partly paid',
      detail: partlyPaidDetail(invoice),
      isLive: true,
      isFinished: false,
    }
  }
  if (request === 'EXPIRED') {
    return {
      stage: 'EXPIRED',
      label: 'Expired',
      detail:
        'No payment was confirmed in time. If the customer still pays, it is matched when the bank confirms it.',
      isLive: false,
      isFinished: true,
    }
  }
  return {
    stage: 'AWAITING_PAYMENT',
    label: 'Awaiting payment',
    detail: 'Waiting for the customer to pay. This updates when the bank confirms it.',
    isLive: true,
    isFinished: false,
  }
}

/** The exact figures, from the bank-reconciled invoice, never worked out here. */
function partlyPaidDetail(invoice: Pick<Invoice, 'payment'> | undefined): string {
  const payment = invoice?.payment
  if (!payment) return 'The bank has confirmed part of the amount. The rest is still due.'
  return `${rwf(payment.allocatedAmount)} confirmed by the bank. ${rwf(payment.remainingBalance)} is still due.`
}

const rwf = (amount: number) => `RWF ${amount.toLocaleString('en')}`

function attention(detail: string): SaleStatus {
  return {
    stage: 'NEEDS_ATTENTION',
    label: 'Needs attention',
    detail,
    isLive: false,
    isFinished: false,
  }
}
