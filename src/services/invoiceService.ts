import type {
  Invoice,
  InvoiceDraftInput,
  InvoiceFormOptions,
  InvoiceListRequest,
  InvoicePage,
} from '@/types/invoice'

export type InvoiceServiceErrorCode =
  | 'unauthenticated'
  /** Also used for invoices the caller may not see, so existence is never revealed. */
  | 'not_found'
  | 'forbidden'
  | 'validation'
  | 'branch_inactive'
  | 'assignee_not_eligible'
  | 'invalid_transition'
  | 'void_not_allowed'
  | 'version_conflict'
  | 'service_unavailable'

export class InvoiceServiceError extends Error {
  readonly code: InvoiceServiceErrorCode

  constructor(code: InvoiceServiceErrorCode, message: string) {
    super(message)
    this.name = 'InvoiceServiceError'
    this.code = code
  }
}

/**
 * Every method takes the merchant explicitly and must verify the signed-in user's ACTIVE
 * membership, their role's permissions, and (for cashiers) record ownership. The mock does
 * this; a real backend must enforce it independently, because the browser can send anything.
 *
 * The service owns all money arithmetic: it recomputes line and invoice totals from the
 * quantities, prices, discounts and tax rates it is given, and ignores any totals a client
 * might send. Nothing here can mark an invoice as paid.
 */
export interface InvoiceService {
  /** Cashiers receive only invoices assigned to them. Pagination-ready; the mock returns one page. */
  listInvoices(merchantId: string, request?: InvoiceListRequest): Promise<InvoicePage>
  getInvoice(merchantId: string, invoiceId: string): Promise<Invoice>
  /** Branches and assignees the current user may use for a NEW invoice (ACTIVE only). */
  getInvoiceFormOptions(merchantId: string): Promise<InvoiceFormOptions>
  createDraft(merchantId: string, input: InvoiceDraftInput): Promise<Invoice>
  updateDraft(
    merchantId: string,
    invoiceId: string,
    input: InvoiceDraftInput,
    expectedVersion: number,
  ): Promise<Invoice>
  /** DRAFT -> ISSUED, with strict validation. Never implies the invoice has been paid. */
  issueInvoice(merchantId: string, invoiceId: string, expectedVersion: number): Promise<Invoice>
  /** DRAFT -> CANCELLED. The record is kept. */
  cancelDraft(merchantId: string, invoiceId: string, expectedVersion: number): Promise<Invoice>
  /** ISSUED -> VOIDED under the documented correction policy (owner, unpaid, with a reason). */
  voidInvoice(
    merchantId: string,
    invoiceId: string,
    input: { reason: string },
    expectedVersion: number,
  ): Promise<Invoice>
}
