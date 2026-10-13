import type {
  BankTransaction,
  InvoicePaymentSummary,
  PaymentAllocation,
  ReconciliationStatus,
} from '@/types/payment'

/**
 * PURE LEDGER DERIVATIONS. One place defines what "paid", "remaining" and "unmatched" mean,
 * so no screen or service keeps its own, possibly conflicting, total.
 */

const isActive = (allocation: PaymentAllocation) => allocation.allocationStatus === 'ACTIVE'

export const sumActiveAllocations = (allocations: PaymentAllocation[]) =>
  allocations.filter(isActive).reduce((total, allocation) => total + allocation.amount, 0)

/**
 * Invoice payment information, always derived from its ACTIVE allocations:
 * remaining = total - allocated (never negative), status follows the remaining balance.
 * A reversed allocation simply stops counting, which restores the balance.
 */
export function summarizeInvoicePayment(
  invoiceTotal: number,
  invoiceAllocations: PaymentAllocation[],
): InvoicePaymentSummary {
  const allocatedAmount = sumActiveAllocations(invoiceAllocations)
  const remainingBalance = Math.max(invoiceTotal - allocatedAmount, 0)
  const unappliedAmount = Math.max(allocatedAmount - invoiceTotal, 0)
  const paymentStatus =
    allocatedAmount <= 0
      ? 'UNPAID'
      : unappliedAmount > 0
        ? 'OVERPAID'
        : remainingBalance > 0
          ? 'PARTIALLY_PAID'
          : 'PAID'
  return { invoiceTotal, allocatedAmount, remainingBalance, unappliedAmount, paymentStatus }
}

/** Confirmed money not (or no longer) applied to any invoice. Zero for unconfirmed money. */
export function unappliedAmountOf(
  transaction: BankTransaction,
  transactionAllocations: PaymentAllocation[],
): number {
  if (transaction.status !== 'CONFIRMED' || transaction.direction !== 'INCOMING') return 0
  return Math.max(transaction.amount - sumActiveAllocations(transactionAllocations), 0)
}

export function deriveReconciliationStatus(
  transaction: BankTransaction,
  transactionAllocations: PaymentAllocation[],
): ReconciliationStatus {
  if (transaction.status === 'REVERSED') return 'REVERSED'
  if (transaction.status !== 'CONFIRMED') return 'NOT_APPLICABLE'
  const allocated = sumActiveAllocations(transactionAllocations)
  if (allocated <= 0) return transaction.paymentRequestId ? 'COLLECTED' : 'UNMATCHED'
  return allocated >= transaction.amount ? 'FULLY_ALLOCATED' : 'PARTIALLY_ALLOCATED'
}

/** Transactions a person should look at: flagged ones, and confirmed money nobody has matched. */
export function requiresReview(
  transaction: BankTransaction,
  transactionAllocations: PaymentAllocation[],
): boolean {
  if (transaction.status !== 'CONFIRMED') return false
  if (transaction.reviewState === 'NEEDS_REVIEW') return true
  if (transaction.reviewState === 'REVIEWED') return false
  return deriveReconciliationStatus(transaction, transactionAllocations) === 'UNMATCHED'
}
