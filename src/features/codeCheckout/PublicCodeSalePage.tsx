import { Loader2 } from 'lucide-react'
import { useParams } from 'react-router-dom'
import { Card, CardContent } from '@/components/ui/card'
import { CUSTOMER_STATUS_LABEL } from '@/lib/codeSaleStatus'
import { formatDateTime, formatRwf } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { CodeSaleCustomerStatus } from '@/types/codeCheckout'
import { usePublicCodeSale } from './codeCheckoutQueries'
import { CodePresentationCard } from './CodePresentationCard'

const STATUS_STYLES: Record<CodeSaleCustomerStatus, string> = {
  AWAITING_PAYMENT: 'border-info/30 bg-info-soft text-info',
  PARTIALLY_PAID: 'border-warning/30 bg-warning-soft text-warning',
  PAID: 'border-success/30 bg-success-soft text-success',
  EXPIRED: 'border-border bg-muted text-muted-foreground',
  CANCELLED: 'border-border bg-muted text-muted-foreground',
  REQUIRES_RECONCILIATION: 'border-danger/30 bg-danger-soft text-danger',
}

/**
 * The customer's page for a code sale: mobile first, anonymous, read-only. It names the business, the amount, the sale reference and
 * the code, and the honest status. It offers no other way to pay, shows no agent or account, and never asks for a PIN or OTP.
 */
export function PublicCodeSalePage() {
  const { reference = '' } = useParams()
  const query = usePublicCodeSale(reference)

  if (query.isPending) {
    return (
      <Card>
        <CardContent className="p-4 text-sm" role="status" aria-live="polite">
          <p className="flex items-center gap-2">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            Loading your payment…
          </p>
        </CardContent>
      </Card>
    )
  }
  const sale = query.data
  if (query.isError || !sale) {
    return (
      <Card>
        <CardContent className="space-y-3 p-4 text-sm" role="alert">
          <h1 className="text-base font-semibold">This payment page could not be found</h1>
          <p>Check the reference with the business that gave it to you.</p>
          <button
            type="button"
            className="font-medium underline"
            onClick={() => void query.refetch()}
          >
            Try again
          </button>
        </CardContent>
      </Card>
    )
  }

  const open = sale.status === 'AWAITING_PAYMENT' || sale.status === 'PARTIALLY_PAID'
  return (
    <Card>
      <CardContent className="space-y-5 p-4 sm:p-6">
        <header className="space-y-1 text-center">
          <h1 className="text-sm font-medium text-muted-foreground">{sale.merchantDisplayName}</h1>
          <p className="text-4xl font-semibold tabular-nums">{formatRwf(sale.amountRwf)}</p>
          {sale.description && <p className="text-sm text-muted-foreground">{sale.description}</p>}
        </header>

        <div
          role="status"
          aria-live="polite"
          data-status={sale.status}
          className={cn('rounded-lg border px-4 py-3 text-center', STATUS_STYLES[sale.status])}
        >
          <p className="text-base font-semibold">{CUSTOMER_STATUS_LABEL[sale.status]}</p>
          <p className="mt-1 text-sm">{sale.statusNote}</p>
        </div>

        {open && (
          <CodePresentationCard
            code={sale.code}
            instructions={sale.instructions}
            saleReference={sale.saleReference}
          />
        )}

        <dl className="grid grid-cols-2 gap-3 border-t pt-4 text-sm">
          <div>
            <dt className="text-xs text-muted-foreground">Sale reference</dt>
            <dd className="font-medium">{sale.saleReference}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Expires</dt>
            <dd className="font-medium">{formatDateTime(sale.expiresAt)}</dd>
          </div>
          {sale.confirmedAmount > 0 && (
            <>
              <div>
                <dt className="text-xs text-muted-foreground">Confirmed by the bank</dt>
                <dd className="font-medium">{formatRwf(sale.confirmedAmount)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Still due</dt>
                <dd className="font-medium">{formatRwf(sale.amountDue)}</dd>
              </div>
            </>
          )}
        </dl>
      </CardContent>
    </Card>
  )
}
