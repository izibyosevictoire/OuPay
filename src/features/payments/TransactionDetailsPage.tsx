import { ArrowLeft, FileSearch } from 'lucide-react'
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { DescriptionList } from '@/components/common/DescriptionList'
import { EmptyState } from '@/components/common/EmptyState'
import { PageHeader } from '@/components/common/PageHeader'
import { QueryBoundary } from '@/components/common/QueryBoundary'
import {
  BankTransactionStatusBadge,
  ReconciliationStatusBadge,
  SimulatedBadge,
} from '@/components/common/StatusBadge'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { ALLOCATION_STATUS_LABELS, AUDIT_KIND_LABELS, PROVIDER_LABELS } from '@/constants/payment'
import { PermissionGuard } from '@/features/auth/permissions/PermissionGuard'
import { formatDateTime, formatRwf } from '@/lib/format'
import { PaymentServiceError } from '@/services/paymentServiceError'
import type { AllocationView, BankTransactionDetails } from '@/types/payment'
import {
  ManualAllocationDialog,
  MarkReviewedDialog,
  ReverseAllocationDialog,
} from './ReconciliationDialogs'
import { useBankTransaction } from './paymentQueries'
import { referenceOf, viewNeedsReview, whoOf } from './transactionHelpers'

function NotFound() {
  return (
    <Card>
      <EmptyState
        icon={FileSearch}
        title="We could not find that transaction"
        description="It may belong to a different business, or it is not applied to one of your invoices."
      />
      <div className="flex justify-center pb-8">
        <Button asChild variant="outline">
          <Link to="/transactions">All transactions</Link>
        </Button>
      </div>
    </Card>
  )
}

type Dialog =
  { kind: 'allocate' } | { kind: 'review' } | { kind: 'reverse'; allocation: AllocationView } | null

function Details({ details }: { details: BankTransactionDetails }) {
  const { transaction, allocations, auditHistory } = details
  const [dialog, setDialog] = useState<Dialog>(null)
  const needsReview = viewNeedsReview(transaction)
  const canAllocate = transaction.status === 'CONFIRMED' && transaction.unappliedAmount > 0

  return (
    <>
      <PageHeader
        title={referenceOf(transaction)}
        description={`${formatRwf(transaction.amount)} from ${whoOf(transaction)}`}
        actions={
          <PermissionGuard permission="payments:reconcile">
            {canAllocate && (
              <Button onClick={() => setDialog({ kind: 'allocate' })}>Apply to invoices</Button>
            )}
            {needsReview && (
              <Button variant="outline" onClick={() => setDialog({ kind: 'review' })}>
                Mark as reviewed
              </Button>
            )}
          </PermissionGuard>
        }
      />
      <Card className="space-y-2 p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-2">
          <BankTransactionStatusBadge status={transaction.status} />
          <ReconciliationStatusBadge status={transaction.reconciliationStatus} />
          {transaction.isSimulated && <SimulatedBadge />}
        </div>
        <p className="text-xs text-muted-foreground">
          The bank status says what the bank reported. The reconciliation status says what OuPay has
          done with confirmed money. Only the bank can confirm a payment.
        </p>
        {transaction.reviewReason && needsReview && (
          <p className="rounded-md bg-muted px-3 py-2 text-sm">
            <span className="font-medium">Needs review:</span> {transaction.reviewReason}
          </p>
        )}
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <DescriptionList
          rows={[
            { label: 'Amount', value: formatRwf(transaction.amount) },
            { label: 'Applied to invoices', value: formatRwf(transaction.allocatedAmount) },
            { label: 'Not applied', value: formatRwf(transaction.unappliedAmount) },
            { label: 'Provider', value: PROVIDER_LABELS[transaction.provider] },
            { label: 'Payer (from the bank)', value: transaction.payerDisplayName },
            { label: 'Reference', value: transaction.paymentReference ?? undefined },
            {
              label: 'Verified cashier',
              value: transaction.verifiedCashierNames.join(', ') || undefined,
            },
            {
              label: 'Reported by the bank',
              value: formatDateTime(transaction.providerOccurredAt),
            },
            { label: 'Received by OuPay', value: formatDateTime(transaction.receivedAt) },
          ]}
        />
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Allocations</CardTitle>
          <CardDescription>
            Where this money was applied. Reversed ones stay on record.
          </CardDescription>
        </CardHeader>
        <div className="px-4 pb-4 sm:px-5">
          {allocations.length === 0 ? (
            <p className="text-sm text-muted-foreground">Not applied to any invoice.</p>
          ) : (
            <ul className="divide-y">
              {allocations.map((allocation) => (
                <li
                  key={allocation.id}
                  className="flex flex-wrap items-center justify-between gap-2 py-2.5"
                >
                  <div className="min-w-0 text-sm">
                    <Link
                      to={`/invoices/${allocation.invoiceId}`}
                      className="rounded-sm font-medium text-primary hover:underline"
                    >
                      {allocation.invoiceNumber}
                    </Link>{' '}
                    · {formatRwf(allocation.amount)} ·{' '}
                    {ALLOCATION_STATUS_LABELS[allocation.allocationStatus]}
                    {allocation.reversalReason && (
                      <span className="block text-xs text-muted-foreground">
                        {allocation.reversalReason}
                      </span>
                    )}
                  </div>
                  {allocation.allocationStatus === 'ACTIVE' && (
                    <PermissionGuard permission="payments:reconcile">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setDialog({ kind: 'reverse', allocation })}
                      >
                        Reverse
                        <span className="sr-only"> allocation to {allocation.invoiceNumber}</span>
                      </Button>
                    </PermissionGuard>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>History</CardTitle>
          <CardDescription>An append-only record of everything that happened.</CardDescription>
        </CardHeader>
        <ol className="divide-y px-4 pb-4 sm:px-5">
          {auditHistory.map((entry) => (
            <li key={entry.id} className="py-2.5 text-sm">
              <p className="font-medium">{AUDIT_KIND_LABELS[entry.kind]}</p>
              <p className="text-muted-foreground">{entry.message}</p>
              <p className="text-xs text-muted-foreground">{formatDateTime(entry.createdAt)}</p>
            </li>
          ))}
        </ol>
      </Card>

      {dialog?.kind === 'allocate' && (
        <ManualAllocationDialog
          open
          transaction={transaction}
          onOpenChange={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'review' && (
        <MarkReviewedDialog open transaction={transaction} onOpenChange={() => setDialog(null)} />
      )}
      {dialog?.kind === 'reverse' && (
        <ReverseAllocationDialog
          open
          allocation={dialog.allocation}
          onOpenChange={() => setDialog(null)}
        />
      )}
    </>
  )
}

export function TransactionDetailsPage() {
  const { transactionId = '' } = useParams()
  const query = useBankTransaction(transactionId)
  if (query.error instanceof PaymentServiceError && query.error.code === 'not_found') {
    return (
      <div className="space-y-4 sm:space-y-6">
        <PageHeader title="Transaction not found" />
        <NotFound />
      </div>
    )
  }
  return (
    <div className="space-y-4 sm:space-y-6">
      <Link
        to="/transactions"
        className="inline-flex items-center gap-1 rounded-sm text-sm font-medium text-primary hover:underline"
      >
        <ArrowLeft className="size-4" aria-hidden="true" /> All transactions
      </Link>
      <QueryBoundary
        query={query}
        loadingFallback={<Skeleton className="h-96 w-full" />}
        errorMessage="This transaction could not be loaded."
      >
        {(details) => <Details details={details} />}
      </QueryBoundary>
    </div>
  )
}
