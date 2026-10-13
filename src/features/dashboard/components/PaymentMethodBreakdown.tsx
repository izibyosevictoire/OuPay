import { Wallet } from 'lucide-react'
import { EmptyState } from '@/components/common/EmptyState'
import { QueryBoundary } from '@/components/common/QueryBoundary'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { PROVIDER_LABELS } from '@/constants/payment'
import { formatRwf } from '@/lib/format'
import { useProviderBreakdown } from '../useDashboardData'

export function PaymentMethodBreakdown() {
  const breakdownQuery = useProviderBreakdown()
  return (
    <Card>
      <CardHeader>
        <CardTitle>By bank or provider</CardTitle>
        <CardDescription>Share of verified incoming money (simulated data)</CardDescription>
      </CardHeader>
      <CardContent>
        <QueryBoundary
          query={breakdownQuery}
          loadingFallback={<Skeleton className="h-32 w-full" />}
          errorMessage="The provider breakdown could not be loaded."
        >
          {(shares) => {
            const grandTotal = shares.reduce((total, share) => total + share.amountInRwf, 0)
            if (shares.length === 0 || grandTotal === 0) {
              return (
                <EmptyState
                  icon={Wallet}
                  title="No confirmed payments"
                  description="Providers customers pay through will be summarised here."
                />
              )
            }
            return (
              <ul className="space-y-3">
                {shares.map((share) => {
                  const percentage = Math.round((share.amountInRwf / grandTotal) * 100)
                  return (
                    <li key={share.providerId}>
                      <div className="mb-1 flex justify-between gap-2 text-sm">
                        <span>{PROVIDER_LABELS[share.providerId]}</span>
                        <span className="tabular-nums text-muted-foreground">
                          {formatRwf(share.amountInRwf)} · {percentage}%
                        </span>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                        <div
                          className="h-full rounded-full bg-chart-1 transition-[width] duration-500"
                          style={{ width: `${percentage}%` }}
                        />
                      </div>
                    </li>
                  )
                })}
              </ul>
            )
          }}
        </QueryBoundary>
      </CardContent>
    </Card>
  )
}
