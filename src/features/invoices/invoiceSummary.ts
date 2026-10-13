import { isInvoiceOverdue } from '@/lib/invoiceLifecycle'
import type { Invoice } from '@/types/invoice'

export interface InvoiceSummary {
  /** Invoices that have been issued (not drafts, cancelled or voided). */
  issuedCount: number
  /** Sum of the grand totals of ISSUED invoices. This is what was billed, NOT what was received. */
  issuedTotal: number
  /**
   * What issued invoices still owe: the sum of ACTUAL remaining balances (grand total minus
   * bank-confirmed, allocated payments). A partly paid invoice counts only what is left.
   */
  outstandingTotal: number
  /** Issued invoices with some, but not all, of their total bank-confirmed. */
  partiallySettledCount: number
  overdueCount: number
  /** Remaining balances of overdue invoices. */
  overdueTotal: number
  draftCount: number
}

/**
 * Invoice figures for the dashboard. They come only from invoices: bank-verified received
 * payments are a separate figure from a separate source and are never inferred from these.
 */
export function summarizeInvoices(invoices: Invoice[], today?: string): InvoiceSummary {
  const summary: InvoiceSummary = {
    issuedCount: 0,
    issuedTotal: 0,
    outstandingTotal: 0,
    partiallySettledCount: 0,
    overdueCount: 0,
    overdueTotal: 0,
    draftCount: 0,
  }
  for (const invoice of invoices) {
    if (invoice.status === 'DRAFT') summary.draftCount += 1
    if (invoice.status !== 'ISSUED') continue
    summary.issuedCount += 1
    summary.issuedTotal += invoice.grandTotal
    const remaining = invoice.payment?.remainingBalance ?? invoice.grandTotal
    summary.outstandingTotal += remaining
    if (invoice.paymentStatus === 'PARTIALLY_PAID') summary.partiallySettledCount += 1
    if (isInvoiceOverdue(invoice, today)) {
      summary.overdueCount += 1
      summary.overdueTotal += remaining
    }
  }
  return summary
}
