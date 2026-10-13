import { FileText } from 'lucide-react'
import { Link } from 'react-router-dom'
import { EmptyState } from '@/components/common/EmptyState'
import { QueryBoundary } from '@/components/common/QueryBoundary'
import { InvoicePaymentStatusBadge, InvoiceStatusBadge } from '@/components/common/StatusBadge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { formatDate, formatRwf } from '@/lib/format'
import { useRecentInvoices } from '../useDashboardData'

export function RecentInvoices({ title = 'Recent invoices' }: { title?: string }) {
  const invoicesQuery = useRecentInvoices()
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>{title}</CardTitle>
        <Link
          to="/invoices"
          className="rounded-sm text-sm font-medium text-primary hover:underline"
        >
          View all <span className="sr-only">invoices</span>
        </Link>
      </CardHeader>
      <CardContent>
        <QueryBoundary
          query={invoicesQuery}
          loadingFallback={
            <div className="space-y-3">
              {[0, 1, 2].map((index) => (
                <Skeleton key={index} className="h-10 w-full" />
              ))}
            </div>
          }
          errorMessage="Recent invoices could not be loaded."
        >
          {(invoices) =>
            invoices.length === 0 ? (
              <EmptyState
                icon={FileText}
                title="No invoices yet"
                description="Create your first invoice to start tracking what customers owe."
              />
            ) : (
              <ul className="divide-y">
                {invoices.map((invoice) => (
                  <li
                    key={invoice.id}
                    className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
                  >
                    <div className="min-w-0">
                      <Link
                        to={`/invoices/${invoice.id}`}
                        className="block truncate rounded-sm font-medium hover:underline"
                      >
                        {invoice.customer.name}
                      </Link>
                      <p className="text-xs text-muted-foreground">
                        {invoice.invoiceNumber} · Due {formatDate(invoice.dueAt)}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <span className="font-semibold tabular-nums">
                        {formatRwf(invoice.grandTotal)}
                      </span>
                      <div className="flex flex-wrap justify-end gap-1">
                        <InvoiceStatusBadge status={invoice.status} />
                        {invoice.status === 'ISSUED' && (
                          <InvoicePaymentStatusBadge status={invoice.paymentStatus} />
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )
          }
        </QueryBoundary>
      </CardContent>
    </Card>
  )
}
