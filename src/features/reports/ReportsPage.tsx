import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Download, FileText, Landmark, Wallet } from 'lucide-react'
import { PageHeader } from '@/components/common/PageHeader'
import { SampleDataNotice } from '@/components/common/SampleDataNotice'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { useSelectedMerchantId } from '@/features/branches/useBranchQueries'
import { formatRwf } from '@/lib/format'
import { reportsService } from '@/services'
import type { ReportSummary } from '@/services/reportsService'

function kigaliToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Kigali',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

function initialRange() {
  const today = kigaliToday()
  return { from: `${today.slice(0, 7)}-01`, to: today }
}

function exportSummary(report: ReportSummary) {
  const rows = [
    ['Metric', 'Amount or count'],
    ['Date from', report.from],
    ['Date to', report.to],
    ['Issued invoice count', report.issuedInvoiceCount],
    ['Issued total (RWF)', report.issuedTotalRwf],
    ['Currently allocated to selected invoices (RWF)',
      report.activeAllocatedToIssuedInvoicesRwf],
    ['Current outstanding for selected invoices (RWF)',
      report.outstandingForIssuedInvoicesRwf],
    ['Currently confirmed incoming in period (RWF)',
      report.confirmedIncomingDuringPeriodRwf],
    ['Currently unapplied confirmed incoming in period (RWF)',
      report.unappliedConfirmedDuringPeriodRwf],
  ]

  const escapeCsv = (value: string | number) =>
    `"${String(value).replace(/^[=+\-@\t\r]/, "'").replace(/"/g, '""')}"`

  const csv = rows.map((row) => row.map(escapeCsv).join(',')).join('\r\n')
  const blob = new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `oupay-report-${report.from}-to-${report.to}.csv`
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

function Metric({
  label,
  value,
  description,
}: {
  label: string
  value: string
  description: string
}) {
  return (
    <Card className="min-w-0 space-y-2 p-4 sm:p-5">
      <p className="text-sm font-medium text-muted-foreground">{label}</p>
      <p className="break-words text-xl font-semibold tabular-nums sm:text-2xl">
        {value}
      </p>
      <p className="text-xs text-muted-foreground">{description}</p>
    </Card>
  )
}

export function ReportsPage() {
  const merchantId = useSelectedMerchantId()
  const [range, setRange] = useState(initialRange)
  const [appliedRange, setAppliedRange] = useState(initialRange)

  const validRange = range.from !== '' &&
    range.to !== '' &&
    range.from <= range.to

  const report = useQuery({
    queryKey: ['reports', merchantId, 'summary', appliedRange],
    queryFn: () => reportsService!.getSummary(merchantId, appliedRange),
    enabled: reportsService !== null,
    retry: false,
  })

  return (
    <div className="space-y-4 sm:space-y-6">
      <PageHeader
        title="Reports"
        description="Review invoicing, bank-confirmed collections, and outstanding balances."
        actions={
          <Button
            type="button"
            variant="outline"
            disabled={!report.data || report.isFetching}
            onClick={() => report.data && exportSummary(report.data)}
          >
            <Download className="size-4" aria-hidden="true" />
            Export CSV
          </Button>
        }
      />
      <SampleDataNotice />

      <Card className="p-4 sm:p-5">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            if (validRange) setAppliedRange({ ...range })
          }}
        >
          <label className="flex min-w-0 flex-col gap-1 text-sm">
            From
            <Input
              type="date"
              value={range.from}
              max={range.to || undefined}
              onChange={(event) =>
                setRange((previous) => ({ ...previous, from: event.target.value }))
              }
            />
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-sm">
            To
            <Input
              type="date"
              value={range.to}
              min={range.from || undefined}
              onChange={(event) =>
                setRange((previous) => ({ ...previous, to: event.target.value }))
              }
            />
          </label>
          <Button type="submit" disabled={!validRange}>Apply filters</Button>
        </form>
        {!validRange && (
          <p role="alert" className="mt-2 text-sm text-destructive">
            Select a valid date range.
          </p>
        )}
      </Card>

      {reportsService === null ? (
        <Card className="p-5">
          Reports require the server-backed application.
          Demo mode does not display financial reports.
        </Card>
      ) : report.isPending ? (
        <p role="status">Loading financial report…</p>
      ) : report.isError ? (
        <Card className="space-y-3 p-5">
          <p role="alert">The financial report could not be loaded.</p>
          <Button variant="outline" onClick={() => void report.refetch()}>
            Try again
          </Button>
        </Card>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            Reporting period: {report.data.from} to {report.data.to}
          </p>
          <section
            aria-label="Financial report summary"
            className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
          >
            <Metric
              label="Issued invoices"
              value={String(report.data.issuedInvoiceCount)}
              description="Currently issued invoices within the date range."
            />
            <Metric
              label="Total invoiced"
              value={formatRwf(report.data.issuedTotalRwf)}
              description="Billed amount, not necessarily collected."
            />
            <Metric
              label="Allocated to selected invoices"
              value={formatRwf(
                report.data.activeAllocatedToIssuedInvoicesRwf,
              )}
              description="Current active allocations, regardless of allocation date."
            />
            <Metric
              label="Outstanding"
              value={formatRwf(
                report.data.outstandingForIssuedInvoicesRwf,
              )}
              description="Current remaining balance on selected invoices."
            />
            <Metric
              label="Confirmed incoming"
              value={formatRwf(
                report.data.confirmedIncomingDuringPeriodRwf,
              )}
              description="Currently confirmed incoming transactions dated within the period."
            />
            <Metric
              label="Unapplied collections"
              value={formatRwf(
                report.data.unappliedConfirmedDuringPeriodRwf,
              )}
              description="Current unallocated balance of those confirmed transactions."
            />
          </section>
          <Card className="space-y-2 p-4 sm:p-5">
            <div className="flex items-center gap-2 font-medium">
              <FileText className="size-4" aria-hidden="true" />
              Reporting definitions
            </div>
            <p className="text-sm text-muted-foreground">
              Invoice totals use the issuance period. Outstanding and
              allocated balances reflect current active allocations.
              Bank collections use the provider transaction date and
              currently confirmed status.
            </p>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Landmark className="size-4" aria-hidden="true" />
              Reversed bank payments are excluded from current confirmed totals.
            </div>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Wallet className="size-4" aria-hidden="true" />
              All amounts are expressed in Rwandan francs.
            </div>
          </Card>
        </>
      )}
    </div>
  )
}
