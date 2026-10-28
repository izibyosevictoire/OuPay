import { Copy, ExternalLink, Loader2, Plus, Share2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useToast } from '@/components/common/Toaster'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { PermissionGuard } from '@/features/auth/permissions/PermissionGuard'
import { CUSTOMER_STATUS_LABEL, customerStatusOf, isFinishedStatus } from '@/lib/codeSaleStatus'
import { formatDateTime, formatRwf } from '@/lib/format'
import { buildCodeSaleUrl, buildLocalCodeSalePath } from '@/lib/paymentLinks'
import { cn } from '@/lib/utils'
import type { CodeSaleCustomerStatus } from '@/types/codeCheckout'
import { useCodeSale } from './codeCheckoutQueries'
import { CodePresentationCard } from './CodePresentationCard'

const STATUS_STYLES: Record<CodeSaleCustomerStatus, string> = {
  AWAITING_PAYMENT: 'border-info/30 bg-info-soft text-info',
  PARTIALLY_PAID: 'border-warning/30 bg-warning-soft text-warning',
  PAID: 'border-success/30 bg-success-soft text-success',
  EXPIRED: 'border-border bg-muted text-muted-foreground',
  CANCELLED: 'border-border bg-muted text-muted-foreground',
  REQUIRES_RECONCILIATION: 'border-danger/30 bg-danger-soft text-danger',
}

const STATUS_DETAIL: Record<CodeSaleCustomerStatus, (demo: boolean) => string> = {
  AWAITING_PAYMENT: (demo) =>
    demo
      ? 'Demonstration only: nothing can be paid with a simulated code.'
      : 'Waiting for the bank to confirm a payment. Nothing has been received yet.',
  PARTIALLY_PAID: () => 'The bank has confirmed part of the amount. The rest is still due.',
  PAID: () => 'The bank has confirmed this payment and it has been applied to this sale.',
  EXPIRED: () => 'This request expired. Money the bank confirms later is still matched to it.',
  CANCELLED: () => 'This sale was cancelled.',
  REQUIRES_RECONCILIATION: () =>
    'The bank reported money that is not yet matched to this sale. Review it under Payments.',
}

interface CodeSaleReceiptProps {
  saleId: string
  onNewSale: () => void
  /** The server no longer shows this sale to this person: drop it. */
  onGone: () => void
}

/**
 * The sale just billed: the code and reference to show the customer and its live status. The status is READ from the server and
 * never set by this screen, a timer or a customer's claim: "Paid" appears only after bank-verified money was applied to the sale.
 */
export function CodeSaleReceipt({ saleId, onNewSale, onGone }: CodeSaleReceiptProps) {
  const { notify } = useToast()
  const query = useCodeSale(saleId)
  const [confirmingNew, setConfirmingNew] = useState(false)
  const errorCode = (query.error as { code?: string } | null)?.code
  useEffect(() => {
    if (errorCode === 'not_found' || errorCode === 'forbidden') onGone()
  }, [errorCode, onGone])

  const sale = query.data
  if (!sale) {
    return (
      <Card>
        <CardContent className="p-4 text-sm sm:p-6" role="status" aria-live="polite">
          {query.isError ? (
            <div className="space-y-3">
              <p>The sale could not be loaded. It was not lost: it is kept on the server.</p>
              <Button type="button" variant="outline" onClick={() => void query.refetch()}>
                Try again
              </Button>
            </div>
          ) : (
            <p className="flex items-center gap-2">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              Loading the sale…
            </p>
          )}
        </CardContent>
      </Card>
    )
  }

  const status = customerStatusOf(sale.status, sale.stage)
  const finished = isFinishedStatus(status)
  const demo = sale.code.mode === 'DEMONSTRATION'
  const url = buildCodeSaleUrl(sale.saleReference)
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'

  const copy = async (text: string, message: string) => {
    try {
      await navigator.clipboard.writeText(text)
      notify('success', message)
    } catch {
      notify('error', 'Your browser blocked copying. Select the text and copy it manually.')
    }
  }

  const share = async () => {
    try {
      await navigator.share({
        title: `Pay ${sale.merchantDisplayName}`,
        text: `${sale.merchantDisplayName}: ${formatRwf(sale.amountRwf)} (reference ${sale.saleReference})`,
        url,
      })
    } catch {
      // Closing the share sheet is not an error.
    }
  }

  const startNew = () => {
    if (finished || confirmingNew) {
      onNewSale()
      return
    }
    setConfirmingNew(true)
  }

  return (
    <Card>
      <CardContent className="space-y-5 p-4 sm:p-6">
        <section aria-labelledby="code-sale-summary" className="space-y-1 text-center">
          <h2 id="code-sale-summary" className="sr-only">
            Sale summary
          </h2>
          <p className="text-sm font-medium text-muted-foreground">{sale.merchantDisplayName}</p>
          <p className="text-4xl font-semibold tabular-nums">{formatRwf(sale.amountRwf)}</p>
          <p className="text-sm text-muted-foreground">
            {sale.description} · {sale.invoiceNumber} · {sale.branchName}
          </p>
        </section>

        <div
          role="status"
          aria-live="polite"
          data-status={status}
          className={cn('rounded-lg border px-4 py-3 text-center', STATUS_STYLES[status])}
        >
          <p className="flex items-center justify-center gap-2 text-base font-semibold">
            {query.isFetching && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
            {CUSTOMER_STATUS_LABEL[status]}
          </p>
          <p className="mt-1 text-sm">{STATUS_DETAIL[status](demo)}</p>
          {query.isError && (
            <p className="mt-2 text-xs">
              The latest status could not be loaded, so this may be out of date.
            </p>
          )}
          <button
            type="button"
            className="mt-2 text-xs font-medium underline disabled:opacity-60"
            onClick={() => void query.refetch()}
            disabled={query.isFetching}
          >
            Check now
          </button>
        </div>

        {!finished && <CodePresentationCard code={sale.code} saleReference={sale.saleReference} />}

        {!finished && (
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-center">
            <Button
              type="button"
              variant="outline"
              onClick={() => void copy(sale.saleReference, 'Sale reference copied.')}
            >
              <Copy aria-hidden="true" />
              Copy reference
            </Button>
            {!demo && sale.code.bankCode && (
              <Button
                type="button"
                variant="outline"
                onClick={() => void copy(sale.code.bankCode ?? '', 'Code copied.')}
              >
                <Copy aria-hidden="true" />
                Copy code
              </Button>
            )}
            {canShare && (
              <Button type="button" variant="outline" onClick={() => void share()}>
                <Share2 aria-hidden="true" />
                Share
              </Button>
            )}
            <Button asChild variant="outline">
              <Link to={buildLocalCodeSalePath(sale.saleReference)} target="_blank">
                <ExternalLink aria-hidden="true" />
                Open customer page
              </Link>
            </Button>
          </div>
        )}

        <dl className="grid grid-cols-2 gap-3 border-t pt-4 text-sm">
          <div>
            <dt className="text-xs text-muted-foreground">Reference</dt>
            <dd className="font-medium">{sale.saleReference}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Expires</dt>
            <dd className="font-medium">{formatDateTime(sale.expiresAt)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Confirmed so far</dt>
            <dd className="font-medium">{formatRwf(sale.confirmedAmount)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Still due</dt>
            <dd className="font-medium">{formatRwf(sale.amountDue)}</dd>
          </div>
        </dl>

        <div className="space-y-2 border-t pt-4">
          {confirmingNew && !finished && (
            <p role="alert" className="rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">
              This sale is still open, and the customer can still pay it. Start a new one anyway?
              You can find this one later under Invoices.
            </p>
          )}
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button type="button" onClick={startNew} className="sm:flex-1">
              <Plus aria-hidden="true" />
              {confirmingNew && !finished ? 'Yes, start a new sale' : 'New sale'}
            </Button>
            {confirmingNew && !finished && (
              <Button type="button" variant="outline" onClick={() => setConfirmingNew(false)}>
                Keep this sale
              </Button>
            )}
            <PermissionGuard permission="invoices:view">
              <Button asChild variant="ghost">
                <Link to={`/invoices/${sale.invoiceId}`}>View invoice</Link>
              </Button>
            </PermissionGuard>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
