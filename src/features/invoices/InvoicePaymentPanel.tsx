import { ExternalLink, Loader2, QrCode as QrIcon } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { QueryBoundary } from '@/components/common/QueryBoundary'
import { InvoicePaymentStatusBadge } from '@/components/common/StatusBadge'
import { useToast } from '@/components/common/Toaster'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { QrCode } from '@/features/paymentLinks/QrCode'
import {
  useCreateInvoicePaymentRequest,
  useInvoicePaymentRequests,
} from '@/features/payments/paymentQueries'
import { formatDateTime, formatRwf } from '@/lib/format'
import { buildLocalRequestPath, buildRequestUrl } from '@/lib/paymentLinks'
import { PaymentServiceError } from '@/services/paymentServiceError'
import type { Invoice } from '@/types/invoice'

const REQUEST_STATUS_LABELS = {
  CREATED: 'Not opened yet',
  AWAITING_PAYMENT: 'Awaiting payment',
  PARTIALLY_SETTLED: 'Partly settled',
  SETTLED: 'Settled',
  EXPIRED: 'Expired',
  CANCELLED: 'Cancelled',
} as const

/**
 * What the invoice owes right now, derived only from bank-confirmed allocations, plus the
 * customer payment request for exactly the outstanding amount. There is no "mark as paid".
 */
export function InvoicePaymentPanel({ invoice }: { invoice: Invoice }) {
  const { notify } = useToast()
  const payment = invoice.payment
  const requestsQuery = useInvoicePaymentRequests(invoice.id)
  const createRequest = useCreateInvoicePaymentRequest()
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const canRequest = invoice.status === 'ISSUED' && (payment?.remainingBalance ?? 0) > 0

  const create = async () => {
    setErrorMessage(null)
    try {
      await createRequest.mutateAsync(invoice.id)
      notify('success', 'Payment request ready. Share the link or QR code with the customer.')
    } catch (error) {
      setErrorMessage(
        error instanceof PaymentServiceError ? error.message : 'The request could not be created.',
      )
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Payment</CardTitle>
        <CardDescription>
          Figures come from bank-confirmed payments matched to this invoice.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {payment && (
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-xs text-muted-foreground">Invoice total</dt>
              <dd className="font-semibold tabular-nums">{formatRwf(payment.invoiceTotal)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Bank-confirmed</dt>
              <dd className="font-semibold tabular-nums">{formatRwf(payment.allocatedAmount)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Remaining</dt>
              <dd className="font-semibold tabular-nums">{formatRwf(payment.remainingBalance)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Status</dt>
              <dd>
                <InvoicePaymentStatusBadge status={invoice.paymentStatus} />
              </dd>
            </div>
          </dl>
        )}

        {canRequest && (
          <div className="space-y-2">
            <Button onClick={() => void create()} disabled={createRequest.isPending}>
              {createRequest.isPending ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : (
                <QrIcon aria-hidden="true" />
              )}
              Create payment request
            </Button>
            <p className="text-xs text-muted-foreground">
              Asks the customer for exactly the remaining{' '}
              {formatRwf(payment?.remainingBalance ?? 0)}. If a request is already open, it is
              reused.
            </p>
            {errorMessage && (
              <p role="alert" className="text-sm text-danger">
                {errorMessage}{' '}
                {errorMessage.includes('payment link') && (
                  <Link to="/payment-links" className="font-medium text-primary hover:underline">
                    Payment links
                  </Link>
                )}
              </p>
            )}
          </div>
        )}

        <QueryBoundary
          query={requestsQuery}
          loadingFallback={<Skeleton className="h-16 w-full" />}
          errorMessage="Payment requests could not be loaded."
        >
          {(requests) =>
            requests.length === 0 ? null : (
              <section aria-label="Payment requests" className="space-y-3">
                <h3 className="text-sm font-medium">Payment requests</h3>
                <ul className="divide-y">
                  {requests.map((request) => {
                    const url = buildRequestUrl(request.profileToken, request.publicReference)
                    const isLive = request.status !== 'CANCELLED' && request.status !== 'EXPIRED'
                    return (
                      <li key={request.id} className="space-y-2 py-3 first:pt-0 last:pb-0">
                        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                          <span className="font-medium">{request.publicReference}</span>
                          <span className="text-muted-foreground">
                            {REQUEST_STATUS_LABELS[request.status]} ·{' '}
                            {formatRwf(request.requestedAmount)}
                          </span>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Expires {formatDateTime(request.expiresAt)}
                        </p>
                        {isLive && (
                          <div className="flex flex-wrap items-center gap-3">
                            <div className="w-24 rounded border bg-white p-1">
                              <QrCode
                                value={url}
                                label={`QR code for payment request ${request.publicReference}: ${url}`}
                                className="h-auto w-full"
                              />
                            </div>
                            <div className="min-w-0 space-y-1">
                              <p className="break-all text-xs">{url}</p>
                              <Link
                                to={buildLocalRequestPath(
                                  request.profileToken,
                                  request.publicReference,
                                )}
                                target="_blank"
                                className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
                              >
                                Open customer page{' '}
                                <ExternalLink className="size-3.5" aria-hidden="true" />
                              </Link>
                            </div>
                          </div>
                        )}
                      </li>
                    )
                  })}
                </ul>
              </section>
            )
          }
        </QueryBoundary>
      </CardContent>
    </Card>
  )
}
