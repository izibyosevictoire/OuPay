import { ExternalLink, Loader2, Plus, Share2, Copy } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useToast } from '@/components/common/Toaster'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { PermissionGuard } from '@/features/auth/permissions/PermissionGuard'
import { QrCode } from '@/features/paymentLinks/QrCode'
import { formatDateTime, formatRwf } from '@/lib/format'
import { buildLocalRequestPath, buildRequestUrl } from '@/lib/paymentLinks'
import { cn } from '@/lib/utils'
import type { SimpleCheckoutResult } from '@/types/checkout'
import { describeSaleStatus, type SaleStage } from './checkoutRules'
import { useSaleStatus } from './checkoutQueries'

const STAGE_STYLES: Record<SaleStage, string> = {
  AWAITING_PAYMENT: 'border-info/30 bg-info-soft text-info',
  PARTIALLY_PAID: 'border-warning/30 bg-warning-soft text-warning',
  CONFIRMED: 'border-success/30 bg-success-soft text-success',
  EXPIRED: 'border-border bg-muted text-muted-foreground',
  CANCELLED: 'border-border bg-muted text-muted-foreground',
  NEEDS_ATTENTION: 'border-danger/30 bg-danger-soft text-danger',
}

interface SaleReceiptProps {
  sale: SimpleCheckoutResult
  /** Leaves this sale (it stays in Invoices and Payments) and shows an empty form. */
  onNewPayment: () => void
  /** The server says this sale is not visible to the signed-in person (not found, or no longer allowed). */
  onGone: () => void
}

/**
 * The sale just billed: what to show or send the customer, and its live status. The status is READ from the server (the
 * invoice's bank-reconciled payment status and the request's derived status); it is never set by this screen, a timer or a
 * customer's claim, so "Payment confirmed" appears only after the bank-verified ledger says so.
 */
export function SaleReceipt({ sale, onNewPayment, onGone }: SaleReceiptProps) {
  const { notify } = useToast()
  const status = useSaleStatus(sale)
  const [confirmingNew, setConfirmingNew] = useState(false)

  const errorCode = (status.error as { code?: string } | null)?.code
  useEffect(() => {
    if (errorCode === 'not_found' || errorCode === 'forbidden') onGone()
  }, [errorCode, onGone])

  const request = status.data?.request
  const invoice = status.data?.invoice
  // Until the first read arrives, describe the sale as the server's answer to the bill described it.
  const description = describeSaleStatus(request?.status ?? sale.status, invoice)
  const expiresAt = request?.expiresAt ?? sale.expiresAt
  const url = buildRequestUrl(sale.profileToken, sale.publicReference)
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(url)
      notify('success', 'Payment link copied.')
    } catch {
      notify('error', 'Your browser blocked copying. Select the link and copy it manually.')
    }
  }

  const shareLink = async () => {
    try {
      await navigator.share({
        title: `Pay ${sale.merchantDisplayName}`,
        text: `${sale.merchantDisplayName}: ${formatRwf(sale.amountRwf)}`,
        url,
      })
    } catch {
      // Closing the share sheet is not an error.
    }
  }

  const startNew = () => {
    if (description.isFinished || confirmingNew) {
      onNewPayment()
      return
    }
    setConfirmingNew(true)
  }

  return (
    <Card>
      <CardContent className="space-y-5 p-4 sm:p-6">
        <section aria-labelledby="sale-summary-heading" className="space-y-1 text-center">
          <h2 id="sale-summary-heading" className="sr-only">
            Payment summary
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
          data-stage={description.stage}
          className={cn('rounded-lg border px-4 py-3 text-center', STAGE_STYLES[description.stage])}
        >
          <p className="flex items-center justify-center gap-2 text-base font-semibold">
            {status.isFetching && !status.isPending && (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            )}
            {description.label}
          </p>
          <p className="mt-1 text-sm">{description.detail}</p>
          {status.isError && (
            <p className="mt-2 text-xs">
              The latest status could not be loaded, so this may be out of date.
            </p>
          )}
          <button
            type="button"
            className="mt-2 text-xs font-medium underline disabled:opacity-60"
            onClick={() => void status.refetch()}
            disabled={status.isFetching}
          >
            Check now
          </button>
        </div>

        {description.isLive && (
          <section aria-labelledby="sale-pay-heading" className="space-y-4">
            <h2 id="sale-pay-heading" className="text-sm font-medium">
              Show this to the customer
            </h2>
            <div className="mx-auto w-full max-w-64 rounded-lg border bg-white p-2">
              <QrCode
                value={url}
                label={`QR code for the payment of ${formatRwf(sale.amountRwf)} to ${sale.merchantDisplayName}: ${url}`}
                className="h-auto w-full"
              />
            </div>
            <p className="break-all text-center text-xs text-muted-foreground">{url}</p>
            <div className="flex flex-col gap-2 sm:flex-row sm:justify-center">
              <Button type="button" variant="outline" onClick={() => void copyLink()}>
                <Copy aria-hidden="true" />
                Copy payment link
              </Button>
              {canShare && (
                <Button type="button" variant="outline" onClick={() => void shareLink()}>
                  <Share2 aria-hidden="true" />
                  Share link
                </Button>
              )}
              <Button asChild variant="outline">
                <Link
                  to={buildLocalRequestPath(sale.profileToken, sale.publicReference)}
                  target="_blank"
                >
                  <ExternalLink aria-hidden="true" />
                  Open customer page
                </Link>
              </Button>
            </div>
          </section>
        )}

        <dl className="grid grid-cols-2 gap-3 border-t pt-4 text-sm">
          <div>
            <dt className="text-xs text-muted-foreground">Reference</dt>
            <dd className="font-medium">{sale.publicReference}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">
              {description.isLive ? 'Expires' : 'Expiry'}
            </dt>
            <dd className="font-medium">{formatDateTime(expiresAt)}</dd>
          </div>
        </dl>

        <div className="space-y-2 border-t pt-4">
          {confirmingNew && !description.isFinished && (
            <p role="alert" className="rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">
              This payment is still open, and the customer can still pay it. Start a new one anyway?
              You can find this one later under Invoices.
            </p>
          )}
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button type="button" onClick={startNew} className="sm:flex-1">
              <Plus aria-hidden="true" />
              {confirmingNew && !description.isFinished
                ? 'Yes, start a new payment'
                : 'New payment'}
            </Button>
            {confirmingNew && !description.isFinished && (
              <Button type="button" variant="outline" onClick={() => setConfirmingNew(false)}>
                Keep this payment
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
