import { CreditCard, FlaskConical } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { EmptyState } from '@/components/common/EmptyState'
import { PageHeader } from '@/components/common/PageHeader'
import { QueryBoundary } from '@/components/common/QueryBoundary'
import { SampleDataNotice } from '@/components/common/SampleDataNotice'
import { ReconciliationStatusBadge, SimulatedBadge } from '@/components/common/StatusBadge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { ALLOCATION_STATUS_LABELS } from '@/constants/payment'
import { PermissionGuard } from '@/features/auth/permissions/PermissionGuard'
import { usePermission } from '@/features/auth/permissions/usePermission'
import { DEMO_TOOLS_BUILD } from '@/lib/demoTools'
import { cn } from '@/lib/utils'
import { formatDateTime, formatRwf } from '@/lib/format'
import type { AllocationView, BankTransactionView } from '@/types/payment'
import {
  ManualAllocationDialog,
  MarkReviewedDialog,
  ReverseAllocationDialog,
} from './ReconciliationDialogs'
import { useAllocations, useBankTransactions } from './paymentQueries'
import { hasUnappliedMoney, referenceOf, viewNeedsReview, whoOf } from './transactionHelpers'

type TabId = 'review' | 'unapplied' | 'partial' | 'history'

const TABS: { id: TabId; label: string; reconcileOnly: boolean }[] = [
  { id: 'review', label: 'Needs review', reconcileOnly: true },
  { id: 'unapplied', label: 'Unmatched money', reconcileOnly: true },
  { id: 'partial', label: 'Partly allocated', reconcileOnly: true },
  { id: 'history', label: 'Allocation history', reconcileOnly: false },
]

type Dialog =
  | { kind: 'allocate'; transaction: BankTransactionView }
  | { kind: 'review'; transaction: BankTransactionView }
  | { kind: 'reverse'; allocation: AllocationView }
  | null

function TransactionCards({
  transactions,
  onDialog,
  empty,
}: {
  transactions: BankTransactionView[]
  onDialog: (dialog: Dialog) => void
  empty: string
}) {
  if (transactions.length === 0) {
    return <EmptyState icon={CreditCard} title="Nothing here" description={empty} />
  }
  return (
    <ul className="divide-y">
      {transactions.map((t) => (
        <li key={t.id} className="space-y-2 py-3 first:pt-0 last:pb-0">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <Link
                to={`/transactions/${t.id}`}
                className="block truncate rounded-sm font-medium text-primary hover:underline"
              >
                {referenceOf(t)}
              </Link>
              <p className="text-xs text-muted-foreground">
                {whoOf(t)} · {formatDateTime(t.providerOccurredAt)}
              </p>
            </div>
            <div className="shrink-0 text-right">
              <p className="font-semibold tabular-nums">{formatRwf(t.amount)}</p>
              <p className="text-xs text-muted-foreground">
                {formatRwf(t.unappliedAmount)} not applied
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <ReconciliationStatusBadge status={t.reconciliationStatus} />
            {t.isSimulated && <SimulatedBadge />}
          </div>
          {t.reviewReason && viewNeedsReview(t) && (
            <p className="text-xs text-muted-foreground">{t.reviewReason}</p>
          )}
          <PermissionGuard permission="payments:reconcile">
            <div className="flex flex-wrap gap-2">
              {hasUnappliedMoney(t) && (
                <Button size="sm" onClick={() => onDialog({ kind: 'allocate', transaction: t })}>
                  Apply to invoices
                  <span className="sr-only"> for {referenceOf(t)}</span>
                </Button>
              )}
              {viewNeedsReview(t) && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onDialog({ kind: 'review', transaction: t })}
                >
                  Mark as reviewed<span className="sr-only"> for {referenceOf(t)}</span>
                </Button>
              )}
            </div>
          </PermissionGuard>
        </li>
      ))}
    </ul>
  )
}

function AllocationHistory({
  allocations,
  onDialog,
}: {
  allocations: AllocationView[]
  onDialog: (dialog: Dialog) => void
}) {
  if (allocations.length === 0) {
    return (
      <EmptyState
        icon={CreditCard}
        title="No allocations yet"
        description="When confirmed money is applied to an invoice it is listed here."
      />
    )
  }
  return (
    <ul className="divide-y">
      {allocations.map((a) => (
        <li
          key={a.id}
          className="flex flex-wrap items-center justify-between gap-2 py-3 first:pt-0 last:pb-0"
        >
          <div className="min-w-0 text-sm">
            <p>
              <Link
                to={`/invoices/${a.invoiceId}`}
                className="rounded-sm font-medium text-primary hover:underline"
              >
                {a.invoiceNumber}
              </Link>{' '}
              · {a.customerName}
            </p>
            <p className="text-xs text-muted-foreground">
              {formatRwf(a.amount)} of {formatRwf(a.transactionAmount)} ·{' '}
              {a.origin === 'MANUAL' ? 'Applied manually' : 'Matched by exact reference'} ·{' '}
              {ALLOCATION_STATUS_LABELS[a.allocationStatus]} · {formatDateTime(a.createdAt)}
            </p>
            {a.reversalReason && (
              <p className="text-xs text-muted-foreground">{a.reversalReason}</p>
            )}
          </div>
          {a.allocationStatus === 'ACTIVE' && (
            <PermissionGuard permission="payments:reconcile">
              <Button
                size="sm"
                variant="outline"
                onClick={() => onDialog({ kind: 'reverse', allocation: a })}
              >
                Reverse<span className="sr-only"> allocation to {a.invoiceNumber}</span>
              </Button>
            </PermissionGuard>
          )}
        </li>
      ))}
    </ul>
  )
}

export function PaymentsPage() {
  const { scope } = usePermission('payments:view_confirmations')
  const reconcile = usePermission('payments:reconcile').isAllowed
  const transactionsQuery = useBankTransactions()
  const allocationsQuery = useAllocations()
  const [tab, setTab] = useState<TabId>(reconcile ? 'review' : 'history')
  const [dialog, setDialog] = useState<Dialog>(null)

  const visibleTabs = TABS.filter((t) => reconcile || !t.reconcileOnly)
  const transactions = useMemo(() => transactionsQuery.data ?? [], [transactionsQuery.data])
  const counts = {
    review: transactions.filter(viewNeedsReview).length,
    unapplied: transactions.filter(hasUnappliedMoney).length,
    partial: transactions.filter((t) => t.reconciliationStatus === 'PARTIALLY_ALLOCATED').length,
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      <PageHeader
        title="Payments"
        description={
          scope === 'limited'
            ? 'Bank-confirmed payments applied to your invoices.'
            : 'Reconcile bank-confirmed money with invoices.'
        }
        actions={
          DEMO_TOOLS_BUILD && reconcile ? (
            <Button asChild variant="outline">
              <Link to="/demo/bank-simulator">
                <FlaskConical aria-hidden="true" /> Bank simulator (demo)
              </Link>
            </Button>
          ) : undefined
        }
      />
      <SampleDataNotice />
      <div
        role="tablist"
        aria-label="Payment views"
        className="flex gap-1 overflow-x-auto border-b"
      >
        {visibleTabs.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`tab-${id}`}
            aria-selected={tab === id}
            aria-controls="payments-panel"
            tabIndex={tab === id ? 0 : -1}
            onClick={() => setTab(id)}
            className={cn(
              'shrink-0 whitespace-nowrap rounded-t-md border-b-2 px-3 py-2.5 text-sm font-medium',
              tab === id
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {label}
            {id !== 'history' && <span className="ml-1.5 tabular-nums">({counts[id]})</span>}
          </button>
        ))}
      </div>
      <Card
        id="payments-panel"
        role="tabpanel"
        aria-labelledby={`tab-${tab}`}
        className="p-4 sm:p-5"
      >
        {tab === 'history' ? (
          <QueryBoundary
            query={allocationsQuery}
            loadingFallback={<Skeleton className="h-32 w-full" />}
            errorMessage="Allocation history could not be loaded."
          >
            {(allocations) => <AllocationHistory allocations={allocations} onDialog={setDialog} />}
          </QueryBoundary>
        ) : (
          <QueryBoundary
            query={transactionsQuery}
            loadingFallback={<Skeleton className="h-32 w-full" />}
            errorMessage="Payments could not be loaded."
          >
            {() => (
              <TransactionCards
                onDialog={setDialog}
                transactions={
                  tab === 'review'
                    ? transactions.filter(viewNeedsReview)
                    : tab === 'unapplied'
                      ? transactions.filter(hasUnappliedMoney)
                      : transactions.filter((t) => t.reconciliationStatus === 'PARTIALLY_ALLOCATED')
                }
                empty={
                  tab === 'review'
                    ? 'No payment needs review right now.'
                    : tab === 'unapplied'
                      ? 'All confirmed money has been applied to invoices.'
                      : 'No payment is partly allocated.'
                }
              />
            )}
          </QueryBoundary>
        )}
      </Card>
      {dialog?.kind === 'allocate' && (
        <ManualAllocationDialog
          open
          transaction={dialog.transaction}
          onOpenChange={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'review' && (
        <MarkReviewedDialog
          open
          transaction={dialog.transaction}
          onOpenChange={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'reverse' && (
        <ReverseAllocationDialog
          open
          allocation={dialog.allocation}
          onOpenChange={() => setDialog(null)}
        />
      )}
    </div>
  )
}
