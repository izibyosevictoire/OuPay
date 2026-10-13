import { BarChart3 } from 'lucide-react'
import { EmptyState } from '@/components/common/EmptyState'
import { QueryBoundary } from '@/components/common/QueryBoundary'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { formatCompactNumber, formatDate, formatRwf } from '@/lib/format'
import type { DailyPaymentActivity } from '@/types/business'
import { useDailyPaymentActivity } from '../useDashboardData'

const CHART_HEIGHT = 160

const weekdayLabel = (isoDate: string) =>
  new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: 'Africa/Kigali' }).format(
    new Date(isoDate),
  )

function ActivityBars({ activity }: { activity: DailyPaymentActivity[] }) {
  const highestDailyTotal = Math.max(
    ...activity.map((day) => day.confirmedAmountInRwf + day.pendingAmountInRwf),
  )
  const scaleTop = Math.ceil(highestDailyTotal / 250_000) * 250_000
  const heightFor = (amount: number) => (amount / scaleTop) * CHART_HEIGHT

  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-chart-1" aria-hidden="true" /> Confirmed
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="size-2.5 rounded-sm bg-chart-3 [background-image:repeating-linear-gradient(45deg,transparent_0_2px,rgb(255_255_255/0.6)_2px_4px)]"
            aria-hidden="true"
          />
          Pending
        </span>
      </div>

      <div className="flex gap-2" aria-hidden="true">
        <div
          className="flex flex-col justify-between text-right text-xs tabular-nums text-muted-foreground"
          style={{ height: CHART_HEIGHT }}
        >
          <span>{formatCompactNumber(scaleTop)}</span>
          <span>{formatCompactNumber(scaleTop / 2)}</span>
          <span>0</span>
        </div>
        <div className="relative flex-1">
          <div
            className="pointer-events-none absolute inset-0 flex flex-col justify-between"
            style={{ height: CHART_HEIGHT }}
          >
            <div className="border-t border-dashed" />
            <div className="border-t border-dashed" />
            <div className="border-t" />
          </div>
          <div
            className="relative flex items-end justify-between gap-1.5 sm:gap-3"
            style={{ height: CHART_HEIGHT }}
          >
            {activity.map((day) => (
              <div key={day.date} className="flex h-full flex-1 flex-col-reverse items-stretch">
                <div
                  className="rounded-b-[2px] bg-chart-1 transition-[height] duration-500"
                  style={{ height: heightFor(day.confirmedAmountInRwf) }}
                />
                <div
                  className="rounded-t-[3px] bg-chart-3 [background-image:repeating-linear-gradient(45deg,transparent_0_2px,rgb(255_255_255/0.6)_2px_4px)] transition-[height] duration-500"
                  style={{ height: heightFor(day.pendingAmountInRwf) }}
                />
              </div>
            ))}
          </div>
          <div className="mt-2 flex justify-between gap-1.5 text-xs text-muted-foreground sm:gap-3">
            {activity.map((day) => (
              <span key={day.date} className="flex-1 text-center">
                {weekdayLabel(day.date)}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Exact values for assistive technology and anyone who prefers numbers. */}
      <table className="sr-only">
        <caption>Daily payment activity in RWF</caption>
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">Confirmed</th>
            <th scope="col">Pending</th>
          </tr>
        </thead>
        <tbody>
          {activity.map((day) => (
            <tr key={day.date}>
              <th scope="row">{formatDate(day.date)}</th>
              <td>{formatRwf(day.confirmedAmountInRwf)}</td>
              <td>{formatRwf(day.pendingAmountInRwf)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function PaymentActivityChart() {
  const activityQuery = useDailyPaymentActivity()
  return (
    <Card>
      <CardHeader>
        <CardTitle>Payment activity</CardTitle>
        <CardDescription>Last 7 days, in RWF (simulated data)</CardDescription>
      </CardHeader>
      <CardContent>
        <QueryBoundary
          query={activityQuery}
          loadingFallback={<Skeleton className="h-52 w-full" />}
          errorMessage="Payment activity could not be loaded."
        >
          {(activity) =>
            activity.length === 0 ? (
              <EmptyState
                icon={BarChart3}
                title="No activity yet"
                description="Daily payment totals will be charted here."
              />
            ) : (
              <ActivityBars activity={activity} />
            )
          }
        </QueryBoundary>
      </CardContent>
    </Card>
  )
}
