import { Receipt } from 'lucide-react'
import { Link } from 'react-router-dom'
import { EmptyState } from '@/components/common/EmptyState'
import { QueryBoundary } from '@/components/common/QueryBoundary'
import {
  BankTransactionStatusBadge,
  ReconciliationStatusBadge,
  SimulatedBadge,
} from '@/components/common/StatusBadge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { formatDateTime, formatRwf } from '@/lib/format'
import type { BankTransactionView } from '@/types/payment'
import { useRecentTransactions } from '../useDashboardData'

const referenceOf = (t: BankTransactionView) => t.paymentReference ?? 'No reference'
const whoOf = (t: BankTransactionView) =>
  t.verifiedCashierNames.length > 0 ? t.verifiedCashierNames.join(', ') : t.payerDisplayName

/** Bank status first; reconciliation is shown only for confirmed money, where it has meaning. */
function StatusBadges({ transaction }: { transaction: BankTransactionView }) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      <BankTransactionStatusBadge status={transaction.status} />
      {transaction.status === 'CONFIRMED' && (
        <ReconciliationStatusBadge status={transaction.reconciliationStatus} />
      )}
      {transaction.isSimulated && <SimulatedBadge />}
    </span>
  )
}

function TransactionsTable({ transactions }: { transactions: BankTransactionView[] }) {
  return (
    <>
      {/* Phone: stacked rows, no horizontal scrolling */}
      <ul className="divide-y md:hidden">
        {transactions.map((transaction) => (
          <li key={transaction.id} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate font-medium">{referenceOf(transaction)}</span>
              <span className="font-semibold tabular-nums">{formatRwf(transaction.amount)}</span>
            </div>
            <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span className="truncate">
                {whoOf(transaction)} · {formatDateTime(transaction.providerOccurredAt)}
              </span>
              <StatusBadges transaction={transaction} />
            </div>
          </li>
        ))}
      </ul>

      <table className="hidden w-full text-left md:table">
        <caption className="sr-only">Recent transactions</caption>
        <thead className="text-xs text-muted-foreground">
          <tr className="border-b">
            <th scope="col" className="pb-2 font-medium">
              Reference
            </th>
            <th scope="col" className="pb-2 font-medium">
              Cashier or payer
            </th>
            <th scope="col" className="pb-2 font-medium">
              Date and time
            </th>
            <th scope="col" className="pb-2 text-right font-medium">
              Amount
            </th>
            <th scope="col" className="pb-2 pl-4 font-medium">
              Status
            </th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {transactions.map((transaction) => (
            <tr key={transaction.id}>
              <th scope="row" className="py-3 font-medium">
                {referenceOf(transaction)}
              </th>
              <td className="py-3">{whoOf(transaction)}</td>
              <td className="py-3 text-muted-foreground">
                {formatDateTime(transaction.providerOccurredAt)}
              </td>
              <td className="py-3 text-right font-medium tabular-nums">
                {formatRwf(transaction.amount)}
              </td>
              <td className="py-3 pl-4">
                <StatusBadges transaction={transaction} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}

function TransactionsSkeleton() {
  return (
    <div className="space-y-3">
      {[0, 1, 2, 3].map((index) => (
        <Skeleton key={index} className="h-10 w-full" />
      ))}
    </div>
  )
}

export function RecentTransactions({ title = 'Recent transactions' }: { title?: string }) {
  const transactionsQuery = useRecentTransactions()
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>{title}</CardTitle>
        <Link
          to="/transactions"
          className="rounded-sm text-sm font-medium text-primary hover:underline"
        >
          View all <span className="sr-only">transactions</span>
        </Link>
      </CardHeader>
      <CardContent>
        <QueryBoundary
          query={transactionsQuery}
          loadingFallback={<TransactionsSkeleton />}
          errorMessage="Recent transactions could not be loaded."
        >
          {(transactions) =>
            transactions.length === 0 ? (
              <EmptyState
                icon={Receipt}
                title="No transactions yet"
                description="Bank-confirmed payments will appear here as the bank reports them."
              />
            ) : (
              <TransactionsTable transactions={transactions} />
            )
          }
        </QueryBoundary>
      </CardContent>
    </Card>
  )
}
