import { Receipt, SearchX } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { EmptyState } from '@/components/common/EmptyState'
import { PageHeader } from '@/components/common/PageHeader'
import { QueryBoundary } from '@/components/common/QueryBoundary'
import { SampleDataNotice } from '@/components/common/SampleDataNotice'
import {
  BankTransactionStatusBadge,
  ReconciliationStatusBadge,
  SimulatedBadge,
} from '@/components/common/StatusBadge'
import { Card } from '@/components/ui/card'
import { Input, Select } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import {
  BANK_TRANSACTION_STATUS_LABELS,
  PROVIDER_LABELS,
  RECONCILIATION_STATUS_LABELS,
} from '@/constants/payment'
import { usePermission } from '@/features/auth/permissions/usePermission'
import { formatDateTime, formatRwf } from '@/lib/format'
import type {
  BankTransactionStatus,
  BankTransactionView,
  ReconciliationStatus,
} from '@/types/payment'
import { useBankTransactions } from './paymentQueries'
import { invoiceNumbersOf, referenceOf, whoOf } from './transactionHelpers'

type SortKey = 'NEWEST' | 'OLDEST' | 'HIGHEST' | 'LOWEST'

const SORTERS: Record<SortKey, (a: BankTransactionView, b: BankTransactionView) => number> = {
  NEWEST: (a, b) => b.providerOccurredAt.localeCompare(a.providerOccurredAt),
  OLDEST: (a, b) => a.providerOccurredAt.localeCompare(b.providerOccurredAt),
  HIGHEST: (a, b) => b.amount - a.amount,
  LOWEST: (a, b) => a.amount - b.amount,
}

function Badges({ transaction }: { transaction: BankTransactionView }) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      <BankTransactionStatusBadge status={transaction.status} />
      {transaction.status !== 'PENDING' && transaction.status !== 'FAILED' && (
        <ReconciliationStatusBadge status={transaction.reconciliationStatus} />
      )}
      {transaction.isSimulated && <SimulatedBadge />}
    </span>
  )
}

function TransactionsList({ transactions }: { transactions: BankTransactionView[] }) {
  return (
    <>
      <ul className="divide-y lg:hidden">
        {transactions.map((t) => (
          <li key={t.id} className="space-y-1.5 py-3 first:pt-0 last:pb-0">
            <div className="flex items-start justify-between gap-3">
              <Link
                to={`/transactions/${t.id}`}
                className="min-w-0 truncate rounded-sm font-medium text-primary hover:underline"
              >
                {referenceOf(t)}
              </Link>
              <span className="shrink-0 font-semibold tabular-nums">{formatRwf(t.amount)}</span>
            </div>
            <Badges transaction={t} />
            <p className="text-xs text-muted-foreground">
              {PROVIDER_LABELS[t.provider]} · Invoice: {invoiceNumbersOf(t)} · {whoOf(t)} ·{' '}
              {formatDateTime(t.providerOccurredAt)}
            </p>
          </li>
        ))}
      </ul>
      <table className="hidden w-full text-left lg:table">
        <caption className="sr-only">Bank transactions</caption>
        <thead className="text-xs text-muted-foreground">
          <tr className="border-b">
            {['Reference', 'Provider', 'Invoice', 'Cashier or payer', 'Date and time'].map((h) => (
              <th key={h} scope="col" className="pb-2 font-medium">
                {h}
              </th>
            ))}
            <th scope="col" className="pb-2 text-right font-medium">
              Amount
            </th>
            <th scope="col" className="pb-2 pl-4 font-medium">
              Status
            </th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {transactions.map((t) => (
            <tr key={t.id}>
              <th scope="row" className="whitespace-nowrap py-3 pr-3 font-medium">
                <Link
                  to={`/transactions/${t.id}`}
                  className="rounded-sm text-primary hover:underline"
                >
                  {referenceOf(t)}
                </Link>
              </th>
              <td className="py-3 pr-3 text-muted-foreground">{PROVIDER_LABELS[t.provider]}</td>
              <td className="py-3 pr-3">{invoiceNumbersOf(t)}</td>
              <td className="py-3 pr-3 text-muted-foreground">{whoOf(t)}</td>
              <td className="whitespace-nowrap py-3 pr-3 text-muted-foreground">
                {formatDateTime(t.providerOccurredAt)}
              </td>
              <td className="whitespace-nowrap py-3 text-right font-medium tabular-nums">
                {formatRwf(t.amount)}
              </td>
              <td className="py-3 pl-4">
                <Badges transaction={t} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}

export function TransactionsPage() {
  const query = useBankTransactions()
  const { scope } = usePermission('transactions:view')
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<'ALL' | BankTransactionStatus>('ALL')
  const [reconciliation, setReconciliation] = useState<'ALL' | ReconciliationStatus>('ALL')
  const [provider, setProvider] = useState('ALL')
  const [sort, setSort] = useState<SortKey>('NEWEST')

  const all = useMemo(() => query.data ?? [], [query.data])
  const providers = useMemo(() => [...new Set(all.map((t) => t.provider))], [all])
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    return all
      .filter(
        (t) =>
          (status === 'ALL' || t.status === status) &&
          (reconciliation === 'ALL' || t.reconciliationStatus === reconciliation) &&
          (provider === 'ALL' || t.provider === provider) &&
          (!term ||
            `${t.paymentReference ?? ''} ${t.payerDisplayName} ${invoiceNumbersOf(t)} ${t.providerTransactionId}`
              .toLowerCase()
              .includes(term)),
      )
      .sort(SORTERS[sort])
  }, [all, search, status, reconciliation, provider, sort])

  return (
    <div className="space-y-4 sm:space-y-6">
      <PageHeader
        title="Transactions"
        description={
          scope === 'limited'
            ? 'Bank-confirmed payments applied to your invoices.'
            : 'Every payment the bank has reported, and what happened to it.'
        }
      />
      <SampleDataNotice />
      <Card className="p-4 sm:p-5">
        <form
          role="search"
          aria-label="Filter transactions"
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5"
          onSubmit={(event) => event.preventDefault()}
        >
          <div className="sm:col-span-2 lg:col-span-1">
            <label htmlFor="tx-search" className="mb-1 block text-xs font-medium">
              Search
            </label>
            <Input
              id="tx-search"
              type="search"
              placeholder="Reference, payer or invoice"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="tx-status" className="mb-1 block text-xs font-medium">
              Bank status
            </label>
            <Select
              id="tx-status"
              value={status}
              onChange={(e) => setStatus(e.target.value as typeof status)}
            >
              <option value="ALL">All</option>
              {Object.entries(BANK_TRANSACTION_STATUS_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label htmlFor="tx-recon" className="mb-1 block text-xs font-medium">
              Reconciliation
            </label>
            <Select
              id="tx-recon"
              value={reconciliation}
              onChange={(e) => setReconciliation(e.target.value as typeof reconciliation)}
            >
              <option value="ALL">All</option>
              {Object.entries(RECONCILIATION_STATUS_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label htmlFor="tx-provider" className="mb-1 block text-xs font-medium">
              Provider
            </label>
            <Select id="tx-provider" value={provider} onChange={(e) => setProvider(e.target.value)}>
              <option value="ALL">All</option>
              {providers.map((id) => (
                <option key={id} value={id}>
                  {PROVIDER_LABELS[id]}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label htmlFor="tx-sort" className="mb-1 block text-xs font-medium">
              Sort by
            </label>
            <Select id="tx-sort" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
              <option value="NEWEST">Newest first</option>
              <option value="OLDEST">Oldest first</option>
              <option value="HIGHEST">Highest amount</option>
              <option value="LOWEST">Lowest amount</option>
            </Select>
          </div>
        </form>
      </Card>
      <Card className="p-4 sm:p-5">
        <QueryBoundary
          query={query}
          loadingFallback={
            <div className="space-y-3">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          }
          errorMessage="Transactions could not be loaded."
        >
          {() =>
            all.length === 0 ? (
              <EmptyState
                icon={Receipt}
                title="No transactions yet"
                description="Payments appear here once the bank reports them."
              />
            ) : filtered.length === 0 ? (
              <EmptyState
                icon={SearchX}
                title="No transactions match"
                description="Try clearing a filter or searching for something else."
              />
            ) : (
              <TransactionsList transactions={filtered} />
            )
          }
        </QueryBoundary>
      </Card>
    </div>
  )
}
