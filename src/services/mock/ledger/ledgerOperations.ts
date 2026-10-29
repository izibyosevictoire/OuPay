import { sumActiveAllocations, summarizeInvoicePayment, unappliedAmountOf } from '@/lib/ledger'
import type { BusinessMembership, User } from '@/types/auth'
import type { Invoice } from '@/types/invoice'
import type { AppNotification, NotificationKind } from '@/types/notification'
import type {
  AllocationOrigin,
  AuditEntry,
  AuditEntryKind,
  BankTransaction,
  PaymentAllocation,
  ReversalKind,
} from '@/types/payment'
import type { MockAuthStore } from '../mockAuthStore'
import { formatRwf } from '@/lib/format'
import { newId, type LedgerStore } from './mockLedgerStore'

export type LedgerRuleCode =
  | 'transaction_not_confirmed'
  | 'invoice_not_payable'
  | 'code_sale_not_payable'
  | 'exceeds_remaining'
  | 'exceeds_unapplied'
  | 'allocation_not_active'

/** A financial rule refused an operation. These protect the books; they are not bugs. */
export class LedgerRuleError extends Error {
  readonly code: LedgerRuleCode

  constructor(code: LedgerRuleCode, message: string) {
    super(message)
    this.name = 'LedgerRuleError'
    this.code = code
  }
}

/**
 * The only code allowed to change the ledger. Used by the trusted event processor and by
 * authorised manual reconciliation; both go through the same rules, so one transaction can
 * never be counted twice and an invoice can never be overpaid.
 */
export function createLedgerOperations(
  store: MockAuthStore,
  ledger: LedgerStore,
  now: () => Date = () => new Date(),
) {
  const timestamp = () => now().toISOString()

  const invoiceById = (invoiceId: string): Invoice | undefined =>
    store.loadInvoices().find((invoice) => invoice.id === invoiceId)

  const allocationsOfInvoice = (invoiceId: string) =>
    ledger.allocations.load().filter((allocation) => allocation.invoiceId === invoiceId)

  const allocationsOfTransaction = (transactionId: string) =>
    ledger.allocations.load().filter((allocation) => allocation.bankTransactionId === transactionId)

  /** The invoice with payment information DERIVED from its allocations (the only source). */
  const decorate = (invoice: Invoice): Invoice => {
    const payment = summarizeInvoicePayment(invoice.grandTotal, allocationsOfInvoice(invoice.id))
    return { ...invoice, payment, paymentStatus: payment.paymentStatus }
  }

  const audit = (
    merchantId: string,
    kind: AuditEntryKind,
    message: string,
    details: {
      bankTransactionId?: string | null
      invoiceId?: string | null
      actorUserId?: string | null
    } = {},
  ) => {
    const entry: AuditEntry = {
      id: newId('aud'),
      merchantId,
      bankTransactionId: details.bankTransactionId ?? null,
      invoiceId: details.invoiceId ?? null,
      kind,
      actorUserId: details.actorUserId ?? null,
      message,
      createdAt: timestamp(),
    }
    ledger.auditEntries.save([...ledger.auditEntries.load(), entry])
  }

  const findTransaction = (transactionId: string) =>
    ledger.bankTransactions.load().find((transaction) => transaction.id === transactionId)

  /** Persists a transaction change and bumps its version (used for conflict detection). */
  const saveTransaction = (updated: BankTransaction): BankTransaction => {
    const saved = { ...updated, updatedAt: timestamp(), version: updated.version + 1 }
    ledger.bankTransactions.save(
      ledger.bankTransactions
        .load()
        .map((transaction) => (transaction.id === saved.id ? saved : transaction)),
    )
    return saved
  }

  // ---- recipients and notifications -------------------------------------------------------

  const activeUsersWithMembership = (
    merchantId: string,
  ): { user: User; membership: BusinessMembership }[] => {
    const users = store.loadUsers()
    return store
      .loadMemberships()
      .filter(
        (membership) => membership.merchantId === merchantId && membership.status === 'ACTIVE',
      )
      .flatMap((membership) => {
        const user = users.find((candidate) => candidate.id === membership.userId)
        return user && user.status === 'ACTIVE' ? [{ user, membership }] : []
      })
  }

  const managerIds = (merchantId: string) =>
    activeUsersWithMembership(merchantId)
      .filter(({ membership }) => membership.role === 'OWNER' || membership.role === 'MANAGER')
      .map(({ user }) => user.id)

  /** The cashier responsible for an invoice, if they still have active access. */
  const responsibleCashierId = (invoice: Invoice | undefined): string[] => {
    if (!invoice) return []
    return activeUsersWithMembership(invoice.merchantId)
      .filter(({ user }) => user.id === invoice.assignedToUserId)
      .map(({ user }) => user.id)
  }

  /**
   * Creates at most ONE notification per recipient per dedupe key, so a replayed bank event
   * or a repeated operation never produces a duplicate.
   */
  const notify = (params: {
    merchantId: string
    kind: NotificationKind
    title: string
    body: string
    recipientUserIds: string[]
    dedupeKey: string
    transaction?: BankTransaction
    invoiceId?: string | null
  }) => {
    const existing = ledger.notifications.load()
    const created: AppNotification[] = []
    for (const recipientUserId of new Set(params.recipientUserIds)) {
      const dedupeKey = `${params.dedupeKey}:${recipientUserId}`
      if (existing.some((notification) => notification.dedupeKey === dedupeKey)) continue
      created.push({
        id: newId('ntf'),
        merchantId: params.merchantId,
        recipientUserId,
        kind: params.kind,
        title: params.title,
        body: params.body,
        relatedBankTransactionId: params.transaction?.id ?? null,
        relatedInvoiceId: params.invoiceId ?? null,
        dedupeKey,
        isSimulated: params.transaction?.isSimulated ?? false,
        readAt: null,
        createdAt: timestamp(),
      })
    }
    if (created.length > 0) ledger.notifications.save([...existing, ...created])
  }

  const simulatedTag = (transaction: BankTransaction) =>
    transaction.isSimulated ? ' (simulated)' : ''

  const notifyAllocation = (transaction: BankTransaction, invoice: Invoice, amount: number) => {
    const summary = decorate(invoice).payment!
    const settled = summary.remainingBalance === 0
    notify({
      merchantId: transaction.merchantId,
      kind: settled ? 'INVOICE_SETTLED' : 'INVOICE_PARTIALLY_SETTLED',
      title: settled
        ? `Invoice ${invoice.invoiceNumber} settled`
        : `Invoice ${invoice.invoiceNumber} partly paid`,
      body: settled
        ? `${formatRwf(amount)} bank-confirmed${simulatedTag(transaction)}. The invoice is fully paid.`
        : `${formatRwf(amount)} bank-confirmed${simulatedTag(transaction)}. ${formatRwf(summary.remainingBalance)} still to pay.`,
      recipientUserIds: [...managerIds(transaction.merchantId), ...responsibleCashierId(invoice)],
      dedupeKey: `${settled ? 'settled' : 'partial'}:${transaction.id}:${invoice.id}:${summary.allocatedAmount}`,
      transaction,
      invoiceId: invoice.id,
    })
  }

  const notifyUnmatched = (transaction: BankTransaction) => {
    notify({
      merchantId: transaction.merchantId,
      kind: 'PAYMENT_UNMATCHED',
      title: 'Unmatched bank confirmation',
      body: `${formatRwf(transaction.amount)} from ${transaction.payerDisplayName} was confirmed${simulatedTag(transaction)} but not matched to an invoice. It needs review.`,
      // Unmatched money is only ever shown to people who may reconcile it.
      recipientUserIds: managerIds(transaction.merchantId),
      dedupeKey: `unmatched:${transaction.id}`,
      transaction,
    })
  }

  const notifyNeedsReview = (transaction: BankTransaction, reason: string) => {
    notify({
      merchantId: transaction.merchantId,
      kind: 'NEEDS_REVIEW',
      title: 'Transaction needs review',
      body: `${formatRwf(transaction.amount)} from ${transaction.payerDisplayName}${simulatedTag(transaction)}: ${reason}`,
      recipientUserIds: managerIds(transaction.merchantId),
      dedupeKey: `review:${transaction.id}:${reason}`,
      transaction,
    })
  }

  const notifyCollected = (transaction: BankTransaction) => {
    notify({
      merchantId: transaction.merchantId,
      kind: 'PAYMENT_MATCHED',
      title: 'Payment received',
      body: `${formatRwf(transaction.amount)} bank-confirmed${simulatedTag(transaction)} against a payment request, not yet applied to an invoice.`,
      recipientUserIds: managerIds(transaction.merchantId),
      dedupeKey: `collected:${transaction.id}`,
      transaction,
    })
  }

  const notifyReversal = (transaction: BankTransaction, affectedInvoices: Invoice[]) => {
    notify({
      merchantId: transaction.merchantId,
      kind: 'PAYMENT_REVERSED',
      title: 'Payment reversed by the bank',
      body: `${formatRwf(transaction.amount)} from ${transaction.payerDisplayName}${simulatedTag(transaction)} was reversed.${
        affectedInvoices.length > 0
          ? ` Affected: ${affectedInvoices.map((i) => i.invoiceNumber).join(', ')}.`
          : ''
      }`,
      recipientUserIds: [
        ...managerIds(transaction.merchantId),
        ...affectedInvoices.flatMap((invoice) => responsibleCashierId(invoice)),
      ],
      dedupeKey: `reversed:${transaction.id}`,
      transaction,
      invoiceId: affectedInvoices[0]?.id ?? null,
    })
  }

  // ---- allocation rules -------------------------------------------------------------------

  /**
   * Applies confirmed money to an invoice, enforcing the rules that keep the books right:
   * the money must be CONFIRMED, the invoice ISSUED, and the amount must fit both what is
   * left of the transaction and what the invoice still owes. Overpayment is impossible.
   */
  const allocate = (params: {
    transaction: BankTransaction
    invoice: Invoice
    amount: number
    origin: AllocationOrigin
    actorUserId: string | null
    note?: string
  }): PaymentAllocation => {
    const { transaction, invoice, amount, origin, actorUserId } = params
    if (transaction.status !== 'CONFIRMED' || transaction.direction !== 'INCOMING') {
      throw new LedgerRuleError(
        'transaction_not_confirmed',
        'Only bank-confirmed money can be applied to an invoice.',
      )
    }
    if (invoice.merchantId !== transaction.merchantId || invoice.status !== 'ISSUED') {
      throw new LedgerRuleError(
        'invoice_not_payable',
        `Invoice ${invoice.invoiceNumber} cannot receive payments.`,
      )
    }
    // A demonstration code sale never takes bank money (every mock code sale is one), by any route; the server enforces the same rule.
    if (invoice.saleChannel === 'CODE') {
      throw new LedgerRuleError(
        'code_sale_not_payable',
        `Invoice ${invoice.invoiceNumber} is a demonstration sale. It takes no real payment, so no bank money can be applied to it.`,
      )
    }
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new LedgerRuleError(
        'exceeds_unapplied',
        'The amount must be a positive whole number of francs.',
      )
    }
    const remaining = decorate(invoice).payment!.remainingBalance
    if (amount > remaining) {
      throw new LedgerRuleError(
        'exceeds_remaining',
        `Invoice ${invoice.invoiceNumber} only has ${formatRwf(remaining)} left to pay.`,
      )
    }
    if (amount > unappliedAmountOf(transaction, allocationsOfTransaction(transaction.id))) {
      throw new LedgerRuleError(
        'exceeds_unapplied',
        'That is more than the unapplied amount of this transaction.',
      )
    }

    const allocation: PaymentAllocation = {
      id: newId('alc'),
      merchantId: transaction.merchantId,
      bankTransactionId: transaction.id,
      invoiceId: invoice.id,
      amount,
      allocationStatus: 'ACTIVE',
      origin,
      createdByUserId: actorUserId,
      createdAt: timestamp(),
    }
    ledger.allocations.save([...ledger.allocations.load(), allocation])
    saveTransaction(transaction)
    audit(
      transaction.merchantId,
      origin === 'MANUAL' ? 'MANUAL_ALLOCATED' : 'AUTO_ALLOCATED',
      `${origin === 'MANUAL' ? 'Manually' : 'Automatically'} applied ${formatRwf(amount)} to invoice ${invoice.invoiceNumber}.${params.note ? ` Note: ${params.note}` : ''}`,
      { bankTransactionId: transaction.id, invoiceId: invoice.id, actorUserId },
    )
    return allocation
  }

  /** Reverses one allocation (it stops counting), restoring the invoice balance. */
  const reverseAllocation = (
    allocationId: string,
    details: { kind: ReversalKind; reason: string; actorUserId: string | null },
  ): PaymentAllocation => {
    const existing = ledger.allocations.load().find((allocation) => allocation.id === allocationId)
    if (!existing || existing.allocationStatus !== 'ACTIVE') {
      throw new LedgerRuleError(
        'allocation_not_active',
        'That allocation has already been reversed.',
      )
    }
    const reversed: PaymentAllocation = {
      ...existing,
      allocationStatus: 'REVERSED',
      reversedAt: timestamp(),
      reversedByUserId: details.actorUserId,
      reversalKind: details.kind,
      reversalReason: details.reason,
    }
    ledger.allocations.save(
      ledger.allocations
        .load()
        .map((allocation) => (allocation.id === allocationId ? reversed : allocation)),
    )
    const transaction = findTransaction(existing.bankTransactionId)
    if (transaction) saveTransaction(transaction)
    audit(
      existing.merchantId,
      'ALLOCATION_REVERSED',
      `Reversed the allocation of ${formatRwf(existing.amount)} (${details.reason}).`,
      {
        bankTransactionId: existing.bankTransactionId,
        invoiceId: existing.invoiceId,
        actorUserId: details.actorUserId,
      },
    )
    return reversed
  }

  const flagForReview = (transaction: BankTransaction, reason: string): BankTransaction => {
    const flagged = saveTransaction({
      ...transaction,
      reviewState: 'NEEDS_REVIEW',
      reviewReason: reason,
    })
    audit(transaction.merchantId, 'FLAGGED_FOR_REVIEW', reason, {
      bankTransactionId: transaction.id,
    })
    notifyNeedsReview(flagged, reason)
    return flagged
  }

  return {
    timestamp,
    invoiceById,
    allocationsOfInvoice,
    allocationsOfTransaction,
    findTransaction,
    decorate,
    audit,
    saveTransaction,
    allocate,
    reverseAllocation,
    flagForReview,
    notifyAllocation,
    notifyUnmatched,
    notifyCollected,
    notifyReversal,
    activeAllocationTotal: (transactionId: string) =>
      sumActiveAllocations(allocationsOfTransaction(transactionId)),
  }
}

export type LedgerOperations = ReturnType<typeof createLedgerOperations>
