import { FilePlus2, FileText, SearchX } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { EmptyState } from '@/components/common/EmptyState'
import { PageHeader } from '@/components/common/PageHeader'
import { QueryBoundary } from '@/components/common/QueryBoundary'
import { SampleDataNotice } from '@/components/common/SampleDataNotice'
import {
  InvoicePaymentStatusBadge,
  InvoiceStatusBadge,
  OverdueBadge,
} from '@/components/common/StatusBadge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input, Select } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { INVOICE_PAYMENT_STATUS_LABELS, INVOICE_STATUS_LABELS } from '@/constants/invoice'
import { PermissionGuard } from '@/features/auth/permissions/PermissionGuard'
import { usePermission } from '@/features/auth/permissions/usePermission'
import { formatDate, formatRwf } from '@/lib/format'
import { isInvoiceOverdue, todayInKigali } from '@/lib/invoiceLifecycle'
import type { Invoice, InvoicePaymentStatus, InvoiceStatus } from '@/types/invoice'
import { summarizeInvoices } from './invoiceSummary'
import { useInvoices } from './useInvoiceQueries'

type SortKey = 'NEWEST' | 'OLDEST' | 'HIGHEST' | 'LOWEST'

const SORTERS: Record<SortKey, (a: Invoice, b: Invoice) => number> = {
  NEWEST: (a, b) => b.createdAt.localeCompare(a.createdAt),
  OLDEST: (a, b) => a.createdAt.localeCompare(b.createdAt),
  HIGHEST: (a, b) => b.grandTotal - a.grandTotal,
  LOWEST: (a, b) => a.grandTotal - b.grandTotal,
}

const createdDate = (invoice: Invoice) => todayInKigali(new Date(invoice.createdAt))

function InvoiceBadges({ invoice }: { invoice: Invoice }) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      <InvoiceStatusBadge status={invoice.status} />
      {invoice.status === 'ISSUED' && <InvoicePaymentStatusBadge status={invoice.paymentStatus} />}
      {isInvoiceOverdue(invoice) && <OverdueBadge />}
    </span>
  )
}

function InvoicesList({ invoices }: { invoices: Invoice[] }) {
  return (
    <>
      {/* Phones and tablets: cards, so nothing scrolls sideways. */}
      <ul className="divide-y lg:hidden">
        {invoices.map((invoice) => (
          <li key={invoice.id} className="space-y-1.5 py-3 first:pt-0 last:pb-0">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <Link
                  to={`/invoices/${invoice.id}`}
                  className="block truncate rounded-sm font-medium text-primary hover:underline"
                >
                  {invoice.invoiceNumber}
                </Link>
                <p className="truncate text-sm">{invoice.customer.name}</p>
              </div>
              <p className="shrink-0 font-semibold tabular-nums">{formatRwf(invoice.grandTotal)}</p>
            </div>
            <InvoiceBadges invoice={invoice} />
            <p className="text-xs text-muted-foreground">
              {invoice.branchSnapshot.name} · {invoice.assignedToName} · Due{' '}
              {formatDate(invoice.dueAt)}
            </p>
          </li>
        ))}
      </ul>

      <table className="hidden w-full text-left lg:table">
        <caption className="sr-only">Invoices</caption>
        <thead className="text-xs text-muted-foreground">
          <tr className="border-b">
            <th scope="col" className="pb-2 font-medium">
              Invoice
            </th>
            <th scope="col" className="pb-2 font-medium">
              Customer
            </th>
            <th scope="col" className="pb-2 font-medium">
              Branch
            </th>
            <th scope="col" className="pb-2 font-medium">
              Cashier
            </th>
            <th scope="col" className="pb-2 font-medium">
              Created
            </th>
            <th scope="col" className="pb-2 font-medium">
              Due
            </th>
            <th scope="col" className="pb-2 text-right font-medium">
              Total
            </th>
            <th scope="col" className="pb-2 pl-4 font-medium">
              Status
            </th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {invoices.map((invoice) => (
            <tr key={invoice.id}>
              <th scope="row" className="whitespace-nowrap py-3 pr-3 font-medium">
                <Link
                  to={`/invoices/${invoice.id}`}
                  className="rounded-sm text-primary hover:underline"
                >
                  {invoice.invoiceNumber}
                </Link>
              </th>
              <td className="py-3 pr-3">{invoice.customer.name}</td>
              <td className="py-3 pr-3 text-muted-foreground">{invoice.branchSnapshot.name}</td>
              <td className="py-3 pr-3 text-muted-foreground">{invoice.assignedToName}</td>
              <td className="whitespace-nowrap py-3 pr-3 text-muted-foreground">
                {formatDate(invoice.createdAt)}
              </td>
              <td className="whitespace-nowrap py-3 pr-3 text-muted-foreground">
                {formatDate(invoice.dueAt)}
              </td>
              <td className="whitespace-nowrap py-3 text-right font-medium tabular-nums">
                {formatRwf(invoice.grandTotal)}
              </td>
              <td className="py-3 pl-4">
                <InvoiceBadges invoice={invoice} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}

export function InvoicesPage() {
  const invoicesQuery = useInvoices()
  const { scope } = usePermission('invoices:view')
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<'ALL' | InvoiceStatus>('ALL')
  const [payment, setPayment] = useState<'ALL' | InvoicePaymentStatus>('ALL')
  const [branch, setBranch] = useState('ALL')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [sort, setSort] = useState<SortKey>('NEWEST')

  const allInvoices = useMemo(() => invoicesQuery.data ?? [], [invoicesQuery.data])

  // Branch options come from the invoices themselves, so cashiers (who cannot list branches) see theirs.
  const branches = useMemo(() => {
    const byId = new Map(
      allInvoices.map((invoice) => [invoice.branchId, invoice.branchSnapshot.name]),
    )
    return [...byId].sort((a, b) => a[1].localeCompare(b[1]))
  }, [allInvoices])

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    return allInvoices
      .filter(
        (invoice) =>
          (status === 'ALL' || invoice.status === status) &&
          (payment === 'ALL' || invoice.paymentStatus === payment) &&
          (branch === 'ALL' || invoice.branchId === branch) &&
          (!from || createdDate(invoice) >= from) &&
          (!to || createdDate(invoice) <= to) &&
          (!term ||
            `${invoice.invoiceNumber} ${invoice.customer.name}`.toLowerCase().includes(term)),
      )
      .sort(SORTERS[sort])
  }, [allInvoices, search, status, payment, branch, from, to, sort])

  const summary = useMemo(() => summarizeInvoices(filtered), [filtered])

  return (
    <div className="space-y-4 sm:space-y-6">
      <PageHeader
        title="Invoices"
        description={
          scope === 'limited'
            ? 'Invoices assigned to you.'
            : 'Create invoices and follow what customers owe.'
        }
        actions={
          <PermissionGuard permission="invoices:create">
            <Button asChild>
              <Link to="/invoices/new">
                <FilePlus2 aria-hidden="true" />
                New invoice
              </Link>
            </Button>
          </PermissionGuard>
        }
      />
      <SampleDataNotice />

      <Card className="p-4 sm:p-5">
        <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Input
            type="search"
            aria-label="Search invoices"
            placeholder="Search invoice number or customer"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="col-span-2 lg:col-span-4"
          />
          <Select
            aria-label="Filter by invoice status"
            value={status}
            onChange={(e) => setStatus(e.target.value as 'ALL' | InvoiceStatus)}
          >
            <option value="ALL">All invoice statuses</option>
            {(Object.keys(INVOICE_STATUS_LABELS) as InvoiceStatus[]).map((value) => (
              <option key={value} value={value}>
                {INVOICE_STATUS_LABELS[value]}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Filter by payment status"
            value={payment}
            onChange={(e) => setPayment(e.target.value as 'ALL' | InvoicePaymentStatus)}
          >
            <option value="ALL">All payment statuses</option>
            {(Object.keys(INVOICE_PAYMENT_STATUS_LABELS) as InvoicePaymentStatus[]).map((value) => (
              <option key={value} value={value}>
                {INVOICE_PAYMENT_STATUS_LABELS[value]}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Filter by branch"
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
          >
            <option value="ALL">All branches</option>
            {branches.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Sort invoices"
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
          >
            <option value="NEWEST">Newest first</option>
            <option value="OLDEST">Oldest first</option>
            <option value="HIGHEST">Highest amount</option>
            <option value="LOWEST">Lowest amount</option>
          </Select>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Created from
            <Input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Created to
            <Input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </label>
        </div>

        <QueryBoundary
          query={invoicesQuery}
          loadingFallback={
            <div className="space-y-3">
              {[0, 1, 2, 3].map((index) => (
                <Skeleton key={index} className="h-14 w-full" />
              ))}
            </div>
          }
          errorMessage="Invoices could not be loaded."
        >
          {(invoices) =>
            invoices.length === 0 ? (
              <EmptyState
                icon={FileText}
                title="No invoices yet"
                description="Create an invoice to start tracking what customers owe."
              />
            ) : filtered.length === 0 ? (
              <EmptyState
                icon={SearchX}
                title="No invoices match"
                description="Try a different search or clear a filter."
              />
            ) : (
              <>
                <p className="mb-3 text-sm text-muted-foreground" aria-live="polite">
                  {filtered.length} of {invoices.length} invoices · Billed{' '}
                  {formatRwf(summary.issuedTotal)} · Not yet paid{' '}
                  {formatRwf(summary.outstandingTotal)}
                  <span className="block text-xs">
                    Totals count issued invoices only. Billed is not money received.
                  </span>
                </p>
                <InvoicesList invoices={filtered} />
              </>
            )
          }
        </QueryBoundary>
      </Card>
    </div>
  )
}
