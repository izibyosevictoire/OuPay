import { deriveReconciliationStatus, sumActiveAllocations, unappliedAmountOf } from '@/lib/ledger'
import type { Invoice } from '@/types/invoice'
import type {
  AllocationView,
  BankTransaction,
  BankTransactionView,
  PaymentAllocation,
} from '@/types/payment'
import type { MockAuthStore } from '../mockAuthStore'
import type { LedgerStore } from './mockLedgerStore'

/**
 * Builds the read models the screens use, always from the one ledger. When
 * `restrictToUserId` is given (cashiers), only transactions applied to invoices assigned to
 * that person are included, and only those invoices' links and amounts are shown.
 */
export function buildTransactionViews(
  store: MockAuthStore,
  ledger: LedgerStore,
  merchantId: string,
  restrictToUserId?: string,
): BankTransactionView[] {
  const invoicesById = new Map(store.loadInvoices().map((invoice) => [invoice.id, invoice]))
  const allocations = ledger.allocations.load().filter((a) => a.merchantId === merchantId)

  return ledger.bankTransactions
    .load()
    .filter((transaction) => transaction.merchantId === merchantId)
    .flatMap<BankTransactionView>((transaction) => {
      let own: PaymentAllocation[] = allocations.filter(
        (a) => a.bankTransactionId === transaction.id,
      )
      if (restrictToUserId) {
        own = own.filter(
          (a) => invoicesById.get(a.invoiceId)?.assignedToUserId === restrictToUserId,
        )
        // A cashier never sees money that is not applied to one of their invoices.
        if (own.length === 0) return []
      }
      return [toView(transaction, own, invoicesById, Boolean(restrictToUserId))]
    })
    .sort((a, b) => b.providerOccurredAt.localeCompare(a.providerOccurredAt))
}

export function toView(
  transaction: BankTransaction,
  transactionAllocations: PaymentAllocation[],
  invoicesById: Map<string, Invoice>,
  isScoped = false,
): BankTransactionView {
  const activeInvoices = new Set(
    transactionAllocations.filter((a) => a.allocationStatus === 'ACTIVE').map((a) => a.invoiceId),
  )
  return {
    ...transaction,
    allocatedAmount: sumActiveAllocations(transactionAllocations),
    // For a scoped (cashier) view the unapplied figure would reveal other people's money.
    unappliedAmount: isScoped ? 0 : unappliedAmountOf(transaction, transactionAllocations),
    reconciliationStatus: deriveReconciliationStatus(transaction, transactionAllocations),
    invoices: transactionAllocations.map((allocation) => ({
      invoiceId: allocation.invoiceId,
      invoiceNumber: invoicesById.get(allocation.invoiceId)?.invoiceNumber ?? 'Unknown invoice',
      amount: allocation.amount,
      allocationStatus: allocation.allocationStatus,
    })),
    // Verified by allocation to their invoice, never read off the bank event.
    verifiedCashierNames: [
      ...new Set(
        [...activeInvoices].flatMap((invoiceId) => {
          const name = invoicesById.get(invoiceId)?.assignedToName
          return name ? [name] : []
        }),
      ),
    ],
  }
}

export function buildAllocationViews(
  store: MockAuthStore,
  ledger: LedgerStore,
  merchantId: string,
  restrictToUserId?: string,
): AllocationView[] {
  const invoicesById = new Map(store.loadInvoices().map((invoice) => [invoice.id, invoice]))
  const transactionsById = new Map(ledger.bankTransactions.load().map((t) => [t.id, t]))
  return ledger.allocations
    .load()
    .filter((allocation) => allocation.merchantId === merchantId)
    .flatMap<AllocationView>((allocation) => {
      const invoice = invoicesById.get(allocation.invoiceId)
      const transaction = transactionsById.get(allocation.bankTransactionId)
      if (!invoice || !transaction) return []
      if (restrictToUserId && invoice.assignedToUserId !== restrictToUserId) return []
      return [
        {
          ...allocation,
          invoiceNumber: invoice.invoiceNumber,
          customerName: invoice.customer.name,
          transactionReference: transaction.paymentReference,
          transactionAmount: transaction.amount,
          isSimulated: transaction.isSimulated,
        },
      ]
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}
