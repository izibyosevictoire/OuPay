import {
  AlertTriangle,
  CheckCircle2,
  CircleDollarSign,
  FileClock,
  FileText,
  HelpCircle,
  Link2,
  Users,
  type LucideIcon,
} from 'lucide-react'
import { QueryBoundary } from '@/components/common/QueryBoundary'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { usePermission } from '@/features/auth/permissions/usePermission'
import type { InvoiceSummary } from '@/features/invoices/invoiceSummary'
import { formatRwf } from '@/lib/format'
import type { DashboardSummary } from '@/types/business'
import { useDashboardSummary, useInvoiceSummary } from '../useDashboardData'

interface KpiCardProps {
  label: string
  value: string
  icon: LucideIcon
  hint?: string
}

function KpiCard({ label, value, icon: Icon, hint }: KpiCardProps) {
  return (
    <Card className="p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm text-muted-foreground">{label}</p>
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-accent text-accent-foreground">
          <Icon className="size-4" aria-hidden="true" />
        </span>
      </div>
      <p className="mt-1 text-xl font-semibold tabular-nums sm:mt-2 sm:text-metric">{value}</p>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </Card>
  )
}

function KpiCardsSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3 xl:grid-cols-4">
      {[0, 1, 2, 3, 4, 5, 6, 7].map((index) => (
        <Card key={index} className="space-y-3 p-4 sm:p-5">
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-8 w-3/4" />
        </Card>
      ))}
    </div>
  )
}

interface KpiData {
  payments: DashboardSummary
  invoices: InvoiceSummary
}

function LimitedKpiCardGrid({ payments, invoices }: KpiData) {
  return (
    <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4">
      <li>
        <KpiCard
          label="My verified payments"
          value={formatRwf(payments.allocatedTotal)}
          icon={CheckCircle2}
          hint="Bank-confirmed money applied to your invoices"
        />
      </li>
      <li>
        <KpiCard
          label="My issued invoices"
          value={formatRwf(invoices.issuedTotal)}
          icon={FileText}
          hint={`${invoices.issuedCount} issued · billed, not received`}
        />
      </li>
      <li>
        <KpiCard
          label="My outstanding balances"
          value={formatRwf(invoices.outstandingTotal)}
          icon={FileClock}
          hint="What your issued invoices still owe"
        />
      </li>
      <li>
        <KpiCard
          label="My partly paid invoices"
          value={invoices.partiallySettledCount.toString()}
          icon={CircleDollarSign}
          hint="Some, but not all, bank-confirmed"
        />
      </li>
    </ul>
  )
}

/**
 * Each figure states exactly what it means and where it comes from: bank-confirmed money,
 * invoices, or staff. Verified incoming = allocated + unmatched collections, so nothing is
 * counted twice.
 */
function KpiCardGrid({ payments, invoices }: KpiData) {
  return (
    <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3 xl:grid-cols-4">
      <li>
        <KpiCard
          label="Verified incoming"
          value={formatRwf(payments.verifiedIncomingTotal)}
          icon={CheckCircle2}
          hint={`Bank-confirmed, each payment counted once · ${payments.confirmedTransactionCount} transactions`}
        />
      </li>
      <li>
        <KpiCard
          label="Allocated to invoices"
          value={formatRwf(payments.allocatedTotal)}
          icon={Link2}
          hint="Confirmed money applied to invoices"
        />
      </li>
      <li>
        <KpiCard
          label="Unmatched collections"
          value={formatRwf(payments.unappliedConfirmedTotal)}
          icon={HelpCircle}
          hint="Confirmed, not applied to any invoice"
        />
      </li>
      <li>
        <KpiCard
          label="Outstanding balances"
          value={formatRwf(invoices.outstandingTotal)}
          icon={FileClock}
          hint={
            invoices.overdueCount > 0
              ? `Remaining on issued invoices · ${invoices.overdueCount} overdue`
              : 'Remaining on issued invoices'
          }
        />
      </li>
      <li>
        <KpiCard
          label="Partly paid invoices"
          value={invoices.partiallySettledCount.toString()}
          icon={CircleDollarSign}
          hint="Some, but not all, bank-confirmed"
        />
      </li>
      <li>
        <KpiCard
          label="Needs review"
          value={payments.requiresReviewCount.toString()}
          icon={AlertTriangle}
          hint="Flagged or unmatched confirmed payments"
        />
      </li>
      <li>
        <KpiCard
          label="Issued invoices"
          value={formatRwf(invoices.issuedTotal)}
          icon={FileText}
          hint={`${invoices.issuedCount} issued · billed, not received`}
        />
      </li>
      <li>
        <KpiCard
          label="Active cashiers"
          value={payments.activeCashierCount.toString()}
          icon={Users}
        />
      </li>
    </ul>
  )
}

export function KpiCards() {
  const paymentsQuery = useDashboardSummary()
  const invoicesQuery = useInvoiceSummary()
  const { scope } = usePermission('dashboard:view')

  // One boundary for both sources: show the grid only when both have answered.
  const combined = {
    data:
      paymentsQuery.data && invoicesQuery.data
        ? { payments: paymentsQuery.data, invoices: invoicesQuery.data }
        : undefined,
    isPending: paymentsQuery.isPending || invoicesQuery.isPending,
    isError: paymentsQuery.isError || invoicesQuery.isError,
    refetch: () => Promise.all([paymentsQuery.refetch(), invoicesQuery.refetch()]),
  }

  return (
    <section aria-label="Key figures">
      <QueryBoundary
        query={combined}
        loadingFallback={<KpiCardsSkeleton />}
        errorMessage="Key figures could not be loaded."
      >
        {(data) =>
          scope === 'limited' ? <LimitedKpiCardGrid {...data} /> : <KpiCardGrid {...data} />
        }
      </QueryBoundary>
    </section>
  )
}
