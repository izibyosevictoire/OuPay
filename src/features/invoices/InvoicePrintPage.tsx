import { ArrowLeft, Printer } from 'lucide-react'
import { Link, useParams } from 'react-router-dom'
import { QueryBoundary } from '@/components/common/QueryBoundary'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  DEMONSTRATION_INVOICE_NOTICE,
  FISCAL_DISCLAIMER,
  INVOICE_PAYMENT_STATUS_LABELS,
  INVOICE_STATUS_LABELS,
  TAX_MODE_LABELS,
} from '@/constants/invoice'
import { formatLongDate, formatPlainDate, formatRwf } from '@/lib/format'
import { InvoiceServiceError } from '@/services/invoiceService'
import type { Invoice } from '@/types/invoice'
import { InvoiceNotFound } from './InvoiceDetailsPage'
import { InvoiceItemsTable } from './InvoiceItemsTable'
import { InvoiceTotalsBlock } from './InvoiceTotals'
import { useInvoice } from './useInvoiceQueries'

/** Large status mark so a draft, cancelled or voided invoice can never pass for a live one. */
function statusMark(invoice: Invoice): string | null {
  switch (invoice.status) {
    case 'DRAFT':
      return 'DRAFT: NOT ISSUED'
    case 'CANCELLED':
      return 'CANCELLED'
    case 'VOIDED':
      return 'VOID'
    case 'ISSUED':
      return null
  }
}

function PrintableInvoice({ invoice }: { invoice: Invoice }) {
  const { merchantSnapshot: merchant, branchSnapshot: branch, customer } = invoice
  const mark = statusMark(invoice)

  return (
    <article
      aria-label={`Invoice ${invoice.invoiceNumber}`}
      className="relative mx-auto w-full max-w-[210mm] bg-white p-6 text-sm text-black shadow-card sm:p-10 print:max-w-none print:p-0 print:shadow-none"
    >
      {mark && (
        <p
          aria-hidden="true"
          className="pointer-events-none absolute right-6 top-6 rotate-[-8deg] rounded-md border-4 border-neutral px-3 py-1 text-2xl font-bold tracking-widest text-neutral opacity-60 sm:right-10 sm:top-10 print:border-black print:text-black"
        >
          {mark}
        </p>
      )}

      <header className="flex flex-col gap-4 border-b pb-6 sm:flex-row sm:justify-between">
        <div>
          <h1 className="text-xl font-bold">{merchant.tradingName ?? merchant.legalName}</h1>
          {merchant.tradingName && <p>{merchant.legalName}</p>}
          <p className="max-w-xs text-muted-foreground print:text-black">{merchant.address}</p>
          {merchant.tin && <p>TIN: {merchant.tin}</p>}
          {merchant.registrationNumber && <p>Reg. no.: {merchant.registrationNumber}</p>}
          {merchant.phoneNumber && <p>{merchant.phoneNumber}</p>}
          {merchant.email && <p>{merchant.email}</p>}
        </div>
        <div className="sm:text-right">
          <p className="text-2xl font-bold tracking-wide">INVOICE</p>
          <p className="font-mono text-base font-semibold">{invoice.invoiceNumber}</p>
          <dl className="mt-3 space-y-0.5">
            <div className="flex gap-2 sm:justify-end">
              <dt className="text-muted-foreground print:text-black">Created:</dt>
              <dd>{formatLongDate(invoice.createdAt)}</dd>
            </div>
            <div className="flex gap-2 sm:justify-end">
              <dt className="text-muted-foreground print:text-black">Issued:</dt>
              <dd>{invoice.issuedAt ? formatLongDate(invoice.issuedAt) : 'Not issued'}</dd>
            </div>
            <div className="flex gap-2 sm:justify-end">
              <dt className="text-muted-foreground print:text-black">Due:</dt>
              <dd>{formatPlainDate(invoice.dueAt)}</dd>
            </div>
          </dl>
        </div>
      </header>

      <section className="grid gap-6 border-b py-6 sm:grid-cols-2" aria-label="Parties">
        <div>
          <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground print:text-black">
            Bill to
          </h2>
          <p className="font-semibold">{customer.name}</p>
          {customer.address && <p>{customer.address}</p>}
          {customer.phoneNumber && <p>{customer.phoneNumber}</p>}
          {customer.email && <p>{customer.email}</p>}
          {customer.tin && <p>TIN: {customer.tin}</p>}
        </div>
        <div>
          <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground print:text-black">
            Details
          </h2>
          <p>
            Branch: {branch.name} ({branch.code})
          </p>
          <p>Served by: {invoice.assignedToName}</p>
          <p>Status: {INVOICE_STATUS_LABELS[invoice.status]}</p>
          <p>
            Payment: {INVOICE_PAYMENT_STATUS_LABELS[invoice.paymentStatus]}{' '}
            <span className="text-xs text-muted-foreground print:text-black">
              (bank-confirmed payments only)
            </span>
          </p>
          {invoice.payment && invoice.status === 'ISSUED' && (
            <p>
              Bank-confirmed: {formatRwf(invoice.payment.allocatedAmount)} · Remaining:{' '}
              {formatRwf(invoice.payment.remainingBalance)}
            </p>
          )}
        </div>
      </section>

      <section className="space-y-4 py-6" aria-label="Items and totals">
        <p className="text-xs text-muted-foreground print:text-black">
          {TAX_MODE_LABELS[invoice.taxMode]} · amounts in RWF
        </p>
        <InvoiceItemsTable items={invoice.items} taxMode={invoice.taxMode} forPrint />
        <InvoiceTotalsBlock
          totals={invoice}
          taxMode={invoice.taxMode}
          className="ml-auto max-w-xs"
        />
      </section>

      {invoice.notes && (
        <section className="border-t py-4" aria-label="Notes">
          <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground print:text-black">
            Notes
          </h2>
          <p className="whitespace-pre-wrap">{invoice.notes}</p>
        </section>
      )}
      {invoice.voidReason && (
        <p className="border-t py-4">
          <strong>Void reason:</strong> {invoice.voidReason}
        </p>
      )}

      <footer className="mt-4 border-t pt-4 text-xs text-muted-foreground print:text-black">
        {invoice.demonstration && <p className="font-semibold">{DEMONSTRATION_INVOICE_NOTICE}</p>}
        <p>{FISCAL_DISCLAIMER}</p>
      </footer>
    </article>
  )
}

export function InvoicePrintPage() {
  const { invoiceId = '' } = useParams()
  const invoiceQuery = useInvoice(invoiceId)

  if (
    invoiceQuery.error instanceof InvoiceServiceError &&
    invoiceQuery.error.code === 'not_found'
  ) {
    return <InvoiceNotFound />
  }

  return (
    <div className="space-y-4">
      {/* The toolbar is for the screen only; it never appears on paper. */}
      <div className="mx-auto flex max-w-[210mm] items-center justify-between gap-2 print:hidden">
        <Button asChild variant="outline">
          <Link to={`/invoices/${invoiceId}`}>
            <ArrowLeft aria-hidden="true" /> Back to invoice
          </Link>
        </Button>
        <Button onClick={() => window.print()}>
          <Printer aria-hidden="true" /> Print
        </Button>
      </div>
      <QueryBoundary
        query={invoiceQuery}
        loadingFallback={<Skeleton className="mx-auto h-[60vh] w-full max-w-[210mm]" />}
        errorMessage="This invoice could not be loaded."
      >
        {(invoice) => <PrintableInvoice invoice={invoice} />}
      </QueryBoundary>
    </div>
  )
}
