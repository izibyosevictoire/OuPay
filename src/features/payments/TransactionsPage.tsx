import { Receipt, SearchX } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { EmptyState } from '@/components/common/EmptyState'
import { PageHeader } from '@/components/common/PageHeader'
import { QueryBoundary } from '@/components/common/QueryBoundary'
import { SampleDataNotice } from '@/components/common/SampleDataNotice'
import {
  BankTransactionStatusBadge,
  CodePaymentStageBadge,
  ReconciliationStatusBadge,
  SimulatedBadge,
} from '@/components/common/StatusBadge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input, Select } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { CODE_PAYMENT_STAGE_LABELS, TRANSACTIONS_PAGE_SIZE } from '@/constants/codePayment'
import {
  BANK_TRANSACTION_STATUS_LABELS,
  PROVIDER_LABELS,
  RECONCILIATION_STATUS_LABELS,
} from '@/constants/payment'
import { usePermission } from '@/features/auth/permissions/usePermission'
import { formatDateTime, formatRwf } from '@/lib/format'
import type { BankAttribution, CodePaymentStage } from '@/types/bankAttribution'
import type {
  BankTransactionStatus,
  BankTransactionView,
  ReconciliationStatus,
} from '@/types/payment'
import { isCodePayment } from './codePayment'
import { useBankAttributions, useBankTransactions } from './paymentQueries'
import { invoiceNumbersOf, referenceOf, whoOf } from './transactionHelpers'

type SortKey = 'NEWEST' | 'OLDEST' | 'HIGHEST' | 'LOWEST'
type StageFilter = 'ALL' | 'CODE' | 'NOT_CODE' | CodePaymentStage

const SORTERS: Record<SortKey, (a: BankTransactionView, b: BankTransactionView) => number> = {
  NEWEST: (a, b) => b.providerOccurredAt.localeCompare(a.providerOccurredAt),
  OLDEST: (a, b) => a.providerOccurredAt.localeCompare(b.providerOccurredAt),
  HIGHEST: (a, b) => b.amount - a.amount,
  LOWEST: (a, b) => a.amount - b.amount,
}

type AttributionOf = (transactionId: string) => BankAttribution | undefined

/** The sale and its agent, in the words the evidence allows: an agent is named only when the bank evidence confirms it. */
function saleLine(a: BankAttribution): string {
  const parts = [
    a.saleReference ? `Sale ${a.saleReference}` : null,
    a.collectionCode?.label ?? null,
  ]
  if (a.agentName) parts.push(`Agent ${a.agentName}`)
  return parts.filter(Boolean).join(' · ')
}

function Badges({
  transaction,
  attribution,
}: {
  transaction: BankTransactionView
  attribution: BankAttribution | undefined
}) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      <BankTransactionStatusBadge status={transaction.status} />
      {transaction.status !== 'PENDING' && transaction.status !== 'FAILED' && (
        <ReconciliationStatusBadge status={transaction.reconciliationStatus} />
      )}
      {isCodePayment(attribution) && <CodePaymentStageBadge stage={attribution.stage} />}
      {transaction.isSimulated && <SimulatedBadge />}
    </span>
  )
}

function TransactionsList({
  transactions,
  attributionOf,
}: {
  transactions: BankTransactionView[]
  attributionOf: AttributionOf
}) {
  return (
    <>
      <ul className="divide-y lg:hidden" aria-label="Bank transactions">
        {transactions.map((t) => {
          const attribution = attributionOf(t.id)
          return (
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
              <Badges transaction={t} attribution={attribution} />
              <p className="text-xs text-muted-foreground">
                {PROVIDER_LABELS[t.provider]} · Invoice: {invoiceNumbersOf(t)} · {whoOf(t)} ·{' '}
                {formatDateTime(t.providerOccurredAt)}
              </p>
              {isCodePayment(attribution) && (
                <p className="text-xs text-muted-foreground">{saleLine(attribution)}</p>
              )}
            </li>
          )
        })}
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
          {transactions.map((t) => {
            const attribution = attributionOf(t.id)
            return (
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
                  <Badges transaction={t} attribution={attribution} />
                  {isCodePayment(attribution) && (
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {saleLine(attribution)}
                    </span>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </>
  )
}

function Pagination({
  page,
  pageCount,
  total,
  onPage,
}: {
  page: number
  pageCount: number
  total: number
  onPage: (page: number) => void
}) {
  if (total <= TRANSACTIONS_PAGE_SIZE) return null
  const from = page * TRANSACTIONS_PAGE_SIZE + 1
  const to = Math.min(total, (page + 1) * TRANSACTIONS_PAGE_SIZE)
  return (
    <nav
      aria-label="Transactions pages"
      className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t pt-3"
    >
      <p className="text-xs text-muted-foreground" aria-live="polite">
        Showing {from}–{to} of {total}
      </p>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" disabled={page === 0} onClick={() => onPage(page - 1)}>
          Previous
        </Button>
        <span className="text-xs text-muted-foreground">
          Page {page + 1} of {pageCount}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={page >= pageCount - 1}
          onClick={() => onPage(page + 1)}
        >
          Next
        </Button>
      </div>
    </nav>
  )
}

export function TransactionsPage() {
  const query = useBankTransactions()
  const attributions = useBankAttributions()
  const { scope } = usePermission('transactions:view')
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<'ALL' | BankTransactionStatus>('ALL')
  const [reconciliation, setReconciliation] = useState<'ALL' | ReconciliationStatus>('ALL')
  const [provider, setProvider] = useState('ALL')
  const [stage, setStage] = useState<StageFilter>('ALL')
  const [sort, setSort] = useState<SortKey>('NEWEST')
  // The page belongs to the filters it was chosen under: a different filter is a different list, which starts again from its first page.
  const filterKey = [search, status, reconciliation, provider, stage, sort].join('|')
  const [pageState, setPageState] = useState({ key: filterKey, page: 0 })
  const page = pageState.key === filterKey ? pageState.page : 0
  const setPage = (next: number) => setPageState({ key: filterKey, page: next })

  const all = useMemo(() => query.data ?? [], [query.data])
  const byTransaction = useMemo(
    () => new Map((attributions.data ?? []).map((a) => [a.transactionId, a])),
    [attributions.data],
  )
  const attributionOf = useMemo<AttributionOf>(
    () => (transactionId) => byTransaction.get(transactionId),
    [byTransaction],
  )
  const providers = useMemo(() => [...new Set(all.map((t) => t.provider))], [all])
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    return all
      .filter((t) => {
        const attribution = attributionOf(t.id)
        const code = isCodePayment(attribution)
        const codeText = attribution
          ? `${attribution.saleReference ?? ''} ${attribution.agentName ?? ''} ${attribution.collectionCode?.label ?? ''}`
          : ''
        return (
          (status === 'ALL' || t.status === status) &&
          (reconciliation === 'ALL' || t.reconciliationStatus === reconciliation) &&
          (provider === 'ALL' || t.provider === provider) &&
          (stage === 'ALL' ||
            (stage === 'CODE' && code) ||
            (stage === 'NOT_CODE' && !code) ||
            (code && attribution?.stage === stage)) &&
          (!term ||
            `${t.paymentReference ?? ''} ${t.payerDisplayName} ${invoiceNumbersOf(t)} ${t.providerTransactionId} ${codeText}`
              .toLowerCase()
              .includes(term))
        )
      })
      .sort(SORTERS[sort])
  }, [all, attributionOf, search, status, reconciliation, provider, stage, sort])

  const pageCount = Math.max(1, Math.ceil(filtered.length / TRANSACTIONS_PAGE_SIZE))
  const safePage = Math.min(page, pageCount - 1)
  const visible = filtered.slice(
    safePage * TRANSACTIONS_PAGE_SIZE,
    (safePage + 1) * TRANSACTIONS_PAGE_SIZE,
  )

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
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6"
          onSubmit={(event) => event.preventDefault()}
        >
          <div className="sm:col-span-2 lg:col-span-1">
            <label htmlFor="tx-search" className="mb-1 block text-xs font-medium">
              Search
            </label>
            <Input
              id="tx-search"
              type="search"
              placeholder="Reference, payer, invoice or sale"
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
            <label htmlFor="tx-stage" className="mb-1 block text-xs font-medium">
              Code payment
            </label>
            <Select
              id="tx-stage"
              value={stage}
              onChange={(e) => setStage(e.target.value as StageFilter)}
            >
              <option value="ALL">All transactions</option>
              <option value="CODE">Code payments only</option>
              <option value="NOT_CODE">Not code payments</option>
              {Object.entries(CODE_PAYMENT_STAGE_LABELS).map(([value, label]) => (
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
      {attributions.isError && (
        <p role="status" className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
          Code payment details could not be loaded, so only the bank status and reconciliation are
          shown.
        </p>
      )}
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
              <>
                <TransactionsList transactions={visible} attributionOf={attributionOf} />
                <Pagination
                  page={safePage}
                  pageCount={pageCount}
                  total={filtered.length}
                  onPage={setPage}
                />
              </>
            )
          }
        </QueryBoundary>
      </Card>
    </div>
  )
}
