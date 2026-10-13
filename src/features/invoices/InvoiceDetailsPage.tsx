import { ArrowLeft, Ban, Copy, FileSearch, Pencil, Printer, Send, XCircle } from 'lucide-react'
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useAuth } from '@/app/providers/AuthProvider'
import { DescriptionList } from '@/components/common/DescriptionList'
import { EmptyState } from '@/components/common/EmptyState'
import { PageHeader } from '@/components/common/PageHeader'
import { QueryBoundary } from '@/components/common/QueryBoundary'
import {
  InvoicePaymentStatusBadge,
  InvoiceStatusBadge,
  OverdueBadge,
} from '@/components/common/StatusBadge'
import { useToast } from '@/components/common/Toaster'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { INVOICE_STATUS_DESCRIPTIONS, TAX_MODE_LABELS } from '@/constants/invoice'
import { useCurrentRole } from '@/features/auth/permissions/usePermission'
import { formatLongDate, formatPlainDate } from '@/lib/format'
import { isInvoiceOverdue } from '@/lib/invoiceLifecycle'
import { InvoiceServiceError } from '@/services/invoiceService'
import type { Invoice } from '@/types/invoice'
import { CancelDraftDialog, IssueInvoiceDialog, VoidInvoiceDialog } from './InvoiceActionDialogs'
import { InvoiceItemsTable } from './InvoiceItemsTable'
import { InvoicePaymentPanel } from './InvoicePaymentPanel'
import { InvoiceTotalsBlock } from './InvoiceTotals'
import { canPerformInvoiceAction } from './invoicePolicy'
import { useInvoice } from './useInvoiceQueries'

type Dialog = 'issue' | 'cancel' | 'void' | null

export function InvoiceNotFound() {
  return (
    <div className="space-y-4 sm:space-y-6">
      <PageHeader title="Invoice not found" />
      <Card>
        <EmptyState
          icon={FileSearch}
          title="We could not find that invoice"
          description="It may belong to a different business, or it is not assigned to you."
        />
        <div className="flex justify-center pb-8">
          <Button asChild variant="outline">
            <Link to="/invoices">All invoices</Link>
          </Button>
        </div>
      </Card>
    </div>
  )
}

function InvoiceDetails({ invoice }: { invoice: Invoice }) {
  const role = useCurrentRole()
  const { user } = useAuth()
  const { notify } = useToast()
  const [dialog, setDialog] = useState<Dialog>(null)
  const can = (action: Parameters<typeof canPerformInvoiceAction>[3]) =>
    canPerformInvoiceAction(role, user?.id, invoice, action)

  const copyReference = async () => {
    try {
      await navigator.clipboard.writeText(invoice.invoiceNumber)
      notify('success', `Invoice reference ${invoice.invoiceNumber} copied.`)
    } catch {
      notify('error', 'Your browser blocked copying. Select the reference and copy it manually.')
    }
  }

  return (
    <>
      <PageHeader
        title={invoice.invoiceNumber}
        description={`For ${invoice.customer.name}`}
        actions={
          <>
            <Button variant="outline" onClick={() => void copyReference()}>
              <Copy aria-hidden="true" /> Copy reference
            </Button>
            <Button asChild variant="outline">
              <Link to={`/invoices/${invoice.id}/print`}>
                <Printer aria-hidden="true" /> Printable view
              </Link>
            </Button>
          </>
        }
      />

      {(can('edit_draft') || can('issue') || can('cancel_draft') || can('void')) && (
        <Card className="flex flex-wrap items-center gap-2 p-4">
          {can('edit_draft') && (
            <Button asChild variant="outline">
              <Link to={`/invoices/${invoice.id}/edit`}>
                <Pencil aria-hidden="true" /> Edit draft
              </Link>
            </Button>
          )}
          {can('issue') && (
            <Button onClick={() => setDialog('issue')}>
              <Send aria-hidden="true" /> Issue invoice
            </Button>
          )}
          {can('cancel_draft') && (
            <Button variant="outline" onClick={() => setDialog('cancel')}>
              <XCircle aria-hidden="true" /> Cancel draft
            </Button>
          )}
          {can('void') && (
            <Button variant="outline" onClick={() => setDialog('void')}>
              <Ban aria-hidden="true" /> Void invoice
            </Button>
          )}
        </Card>
      )}

      <Card className="space-y-3 p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <div>
            <p className="mb-1 text-xs text-muted-foreground">Invoice status</p>
            <div className="flex items-center gap-2">
              <InvoiceStatusBadge status={invoice.status} />
              {isInvoiceOverdue(invoice) && <OverdueBadge />}
            </div>
          </div>
          <div>
            <p className="mb-1 text-xs text-muted-foreground">Payment verification</p>
            <InvoicePaymentStatusBadge status={invoice.paymentStatus} />
          </div>
        </div>
        <p className="text-sm text-muted-foreground">
          {INVOICE_STATUS_DESCRIPTIONS[invoice.status]}
        </p>
        <p className="text-xs text-muted-foreground">
          Payment status changes only when a bank-confirmed payment is matched to this invoice. It
          cannot be changed by hand, and issuing an invoice never means it has been paid.
        </p>
        {invoice.voidReason && (
          <p className="rounded-md bg-muted px-3 py-2 text-sm">
            <span className="font-medium">Void reason:</span> {invoice.voidReason}
          </p>
        )}
      </Card>

      {invoice.status === 'ISSUED' && <InvoicePaymentPanel invoice={invoice} />}

      <div className="grid gap-4 sm:gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Customer</CardTitle>
          </CardHeader>
          <DescriptionList
            rows={[
              { label: 'Name', value: invoice.customer.name },
              { label: 'Email', value: invoice.customer.email },
              { label: 'Phone', value: invoice.customer.phoneNumber },
              { label: 'Address', value: invoice.customer.address },
              { label: 'TIN', value: invoice.customer.tin },
            ]}
          />
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Issued by</CardTitle>
            <CardDescription>Details as they were when the invoice was written.</CardDescription>
          </CardHeader>
          <DescriptionList
            rows={[
              {
                label: 'Business',
                value: invoice.merchantSnapshot.tradingName ?? invoice.merchantSnapshot.legalName,
              },
              { label: 'Legal name', value: invoice.merchantSnapshot.legalName },
              { label: 'TIN', value: invoice.merchantSnapshot.tin },
              {
                label: 'Branch',
                value: `${invoice.branchSnapshot.name} (${invoice.branchSnapshot.code})`,
              },
              { label: 'Created by', value: invoice.createdByName },
              { label: 'Assigned cashier', value: invoice.assignedToName },
            ]}
          />
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Dates</CardTitle>
        </CardHeader>
        <DescriptionList
          rows={[
            { label: 'Created', value: formatLongDate(invoice.createdAt) },
            {
              label: 'Issued',
              value: invoice.issuedAt ? formatLongDate(invoice.issuedAt) : 'Not issued yet',
            },
            { label: 'Due', value: formatPlainDate(invoice.dueAt) },
          ]}
        />
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Items</CardTitle>
          <CardDescription>{TAX_MODE_LABELS[invoice.taxMode]} · amounts in RWF</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <InvoiceItemsTable items={invoice.items} taxMode={invoice.taxMode} />
          <InvoiceTotalsBlock
            totals={invoice}
            taxMode={invoice.taxMode}
            className="ml-auto max-w-xs"
          />
        </CardContent>
      </Card>

      {invoice.notes && (
        <Card>
          <CardHeader>
            <CardTitle>Notes</CardTitle>
          </CardHeader>
          <CardContent className="whitespace-pre-wrap text-sm">{invoice.notes}</CardContent>
        </Card>
      )}

      {dialog === 'issue' && (
        <IssueInvoiceDialog open invoice={invoice} onOpenChange={() => setDialog(null)} />
      )}
      {dialog === 'cancel' && (
        <CancelDraftDialog open invoice={invoice} onOpenChange={() => setDialog(null)} />
      )}
      {dialog === 'void' && (
        <VoidInvoiceDialog open invoice={invoice} onOpenChange={() => setDialog(null)} />
      )}
    </>
  )
}

export function InvoiceDetailsPage() {
  const { invoiceId = '' } = useParams()
  const invoiceQuery = useInvoice(invoiceId)

  if (
    invoiceQuery.error instanceof InvoiceServiceError &&
    invoiceQuery.error.code === 'not_found'
  ) {
    return <InvoiceNotFound />
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      <Link
        to="/invoices"
        className="inline-flex items-center gap-1 rounded-sm text-sm font-medium text-primary hover:underline"
      >
        <ArrowLeft className="size-4" aria-hidden="true" /> All invoices
      </Link>
      <QueryBoundary
        query={invoiceQuery}
        loadingFallback={<Skeleton className="h-96 w-full" />}
        errorMessage="This invoice could not be loaded."
      >
        {(invoice) => <InvoiceDetails invoice={invoice} />}
      </QueryBoundary>
    </div>
  )
}
