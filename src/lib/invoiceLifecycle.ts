import type { Invoice, InvoiceStatus } from '@/types/invoice'

/**
 * Documented lifecycle (the single source of truth for allowed status changes):
 *
 *   DRAFT  --issue-->   ISSUED
 *   DRAFT  --cancel-->  CANCELLED     (a draft that was never issued)
 *   ISSUED --void-->    VOIDED        (correction policy below)
 *   CANCELLED, VOIDED                 final
 *
 * Deliberately absent: ISSUED -> CANCELLED (an issued invoice is a record sent to a
 * customer; it is voided with a reason instead), and anything back to DRAFT.
 *
 * Correction policy for voiding: only an owner may void, a reason is mandatory, and only
 * while the payment status is UNPAID. Once any payment activity exists the invoice must be
 * corrected through a future credit-note / refund flow, never by voiding. A voided invoice
 * stays on file with its number, amounts and reason.
 *
 * PAYMENT is independent: issuing, cancelling or voiding never changes `paymentStatus`,
 * and nothing in the UI can set it to PAID.
 */
export const INVOICE_STATUS_TRANSITIONS: Record<InvoiceStatus, InvoiceStatus[]> = {
  DRAFT: ['ISSUED', 'CANCELLED'],
  ISSUED: ['VOIDED'],
  CANCELLED: [],
  VOIDED: [],
}

export const canTransitionInvoice = (from: InvoiceStatus, to: InvoiceStatus) =>
  INVOICE_STATUS_TRANSITIONS[from].includes(to)

/** Only drafts may change their content. Issued invoices are immutable. */
export const isInvoiceEditable = (invoice: Pick<Invoice, 'status'>) => invoice.status === 'DRAFT'

/** True when the void correction policy would allow voiding (ignoring who is asking). */
export const isVoidAllowedByPolicy = (invoice: Pick<Invoice, 'status' | 'paymentStatus'>) =>
  canTransitionInvoice(invoice.status, 'VOIDED') && invoice.paymentStatus === 'UNPAID'

/** Overdue is derived, not stored: issued, still unsettled, and past its due date. */
export function isInvoiceOverdue(
  invoice: Pick<Invoice, 'status' | 'paymentStatus' | 'dueAt'>,
  today: string = todayInKigali(),
): boolean {
  return (
    invoice.status === 'ISSUED' &&
    (invoice.paymentStatus === 'UNPAID' || invoice.paymentStatus === 'PARTIALLY_PAID') &&
    invoice.dueAt < today
  )
}

/** Today's date (YYYY-MM-DD) in Rwanda's time zone. */
export function todayInKigali(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kigali' }).format(now)
}
