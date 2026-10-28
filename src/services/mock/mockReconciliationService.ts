import { getPermissionScope } from '@/features/auth/permissions/permissions'
import { requiresReview, unappliedAmountOf } from '@/lib/ledger'
import { PaymentServiceError } from '@/services/paymentServiceError'
import type { PayableInvoice, ReconciliationService } from '@/services/reconciliationService'
import type { BankTransactionDetails } from '@/types/payment'
import { createMockAuthStore, type MockAuthStore } from './mockAuthStore'
import { createLedgerOperations, LedgerRuleError } from './ledger/ledgerOperations'
import { buildAllocationViews, buildTransactionViews } from './ledger/ledgerViews'
import { createLedgerStore, type LedgerStore } from './ledger/mockLedgerStore'
import { requirePaymentActor, scopeUserId } from './mockPaymentAccess'
import { createOperationRunner } from './mockOrganizationAccess'
import { buildAttributionViews } from './ledger/mockAttributionViews'

interface MockReconciliationServiceOptions {
  authStore?: MockAuthStore
  ledger?: LedgerStore
  delayInMilliseconds?: number
}

export function createMockReconciliationService(
  options: MockReconciliationServiceOptions = {},
): ReconciliationService {
  const store = options.authStore ?? createMockAuthStore()
  const ledger = options.ledger ?? createLedgerStore(store)
  const ops = createLedgerOperations(store, ledger)
  const run = createOperationRunner(options.delayInMilliseconds ?? 400)

  const detailsOf = (
    merchantId: string,
    transactionId: string,
    restrictToUserId?: string,
  ): BankTransactionDetails => {
    const transaction = buildTransactionViews(store, ledger, merchantId, restrictToUserId).find(
      (view) => view.id === transactionId,
    )
    if (!transaction)
      throw new PaymentServiceError('not_found', 'This transaction could not be found.')
    const allocations = buildAllocationViews(store, ledger, merchantId, restrictToUserId).filter(
      (allocation) => allocation.bankTransactionId === transactionId,
    )
    // Cashiers see the audit entries of their own invoices only; staff-level history stays private.
    const auditHistory = ledger.auditEntries
      .load()
      .filter(
        (entry) =>
          entry.merchantId === merchantId &&
          entry.bankTransactionId === transactionId &&
          (!restrictToUserId ||
            (entry.invoiceId !== null && allocations.some((a) => a.invoiceId === entry.invoiceId))),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    return { transaction, allocations, auditHistory }
  }

  const translateRuleError = (error: unknown): never => {
    if (error instanceof LedgerRuleError) throw new PaymentServiceError(error.code, error.message)
    throw error
  }

  const attributionsOf = (merchantId: string) => {
    const actor = requirePaymentActor(store, merchantId, 'transactions:view')
    return buildAttributionViews(store, ledger, merchantId, actor)
  }

  return {
    listBankAttributions: (merchantId) => run(() => attributionsOf(merchantId)),

    getBankAttribution: (merchantId, bankTransactionId) =>
      run(() => {
        const found = attributionsOf(merchantId).find((a) => a.transactionId === bankTransactionId)
        if (!found) {
          throw new PaymentServiceError('not_found', 'This transaction could not be found.')
        }
        return found
      }),

    listBankTransactions: (merchantId) =>
      run(() => {
        const actor = requirePaymentActor(store, merchantId, 'transactions:view')
        const full = getPermissionScope(actor.membership.role, 'transactions:view') === 'all'
        return buildTransactionViews(store, ledger, merchantId, scopeUserId(actor, full))
      }),

    getBankTransaction: (merchantId, bankTransactionId) =>
      run(() => {
        const actor = requirePaymentActor(store, merchantId, 'transactions:view')
        const full = getPermissionScope(actor.membership.role, 'transactions:view') === 'all'
        return detailsOf(merchantId, bankTransactionId, scopeUserId(actor, full))
      }),

    listAllocations: (merchantId) =>
      run(() => {
        const actor = requirePaymentActor(store, merchantId, 'payments:view_confirmations')
        const full =
          getPermissionScope(actor.membership.role, 'payments:view_confirmations') === 'all'
        return buildAllocationViews(store, ledger, merchantId, scopeUserId(actor, full))
      }),

    listPayableInvoices: (merchantId) =>
      run<PayableInvoice[]>(() => {
        requirePaymentActor(store, merchantId, 'payments:reconcile')
        return (
          store
            .loadInvoices()
            // A demonstration code sale takes no real payment, so it is never offered here.
            .filter(
              (invoice) =>
                invoice.merchantId === merchantId &&
                invoice.status === 'ISSUED' &&
                invoice.saleChannel !== 'CODE',
            )
            .map((invoice) => ops.decorate(invoice))
            .filter((invoice) => invoice.payment!.remainingBalance > 0)
            .map((invoice) => ({
              invoiceId: invoice.id,
              invoiceNumber: invoice.invoiceNumber,
              customerName: invoice.customer.name,
              grandTotal: invoice.grandTotal,
              remainingBalance: invoice.payment!.remainingBalance,
            }))
            .sort((a, b) => a.invoiceNumber.localeCompare(b.invoiceNumber))
        )
      }),

    allocateManually: (merchantId, input) =>
      run(() => {
        const actor = requirePaymentActor(store, merchantId, 'payments:reconcile')
        const transaction = ops.findTransaction(input.bankTransactionId)
        if (!transaction || transaction.merchantId !== merchantId) {
          throw new PaymentServiceError('not_found', 'This transaction could not be found.')
        }
        if (transaction.version !== input.expectedTransactionVersion) {
          throw new PaymentServiceError(
            'allocation_conflict',
            'This transaction changed since you opened it. Reload it and check the figures again.',
          )
        }
        if (input.allocations.length === 0) {
          throw new PaymentServiceError('validation', 'Choose at least one invoice.')
        }
        const invoiceIds = input.allocations.map((line) => line.invoiceId)
        if (new Set(invoiceIds).size !== invoiceIds.length) {
          throw new PaymentServiceError('validation', 'An invoice can only appear once.')
        }

        // Validate EVERYTHING before changing anything, so a failure never leaves a half-applied split.
        const unapplied = unappliedAmountOf(
          transaction,
          ops.allocationsOfTransaction(transaction.id),
        )
        const lines = input.allocations.map((line) => {
          const invoice = ops.invoiceById(line.invoiceId)
          if (!invoice || invoice.merchantId !== merchantId) {
            throw new PaymentServiceError('not_found', 'An invoice could not be found.')
          }
          if (ops.decorate(invoice).payment!.remainingBalance !== line.expectedRemainingBalance) {
            throw new PaymentServiceError(
              'allocation_conflict',
              `Invoice ${invoice.invoiceNumber} changed since you opened it. Reload and check its balance.`,
            )
          }
          // Every rule is checked here, before anything is applied, so a bad line can never
          // leave an earlier line half-applied.
          if (invoice.status !== 'ISSUED') {
            throw new PaymentServiceError(
              'invoice_not_payable',
              `Invoice ${invoice.invoiceNumber} cannot receive payments.`,
            )
          }
          if (invoice.saleChannel === 'CODE') {
            throw new PaymentServiceError(
              'code_sale_not_payable',
              `Invoice ${invoice.invoiceNumber} is a demonstration sale. It takes no real payment, so no bank money can be applied to it.`,
            )
          }
          if (!Number.isInteger(line.amount) || line.amount <= 0) {
            throw new PaymentServiceError(
              'validation',
              'Amounts must be positive whole numbers of francs.',
            )
          }
          if (line.amount > line.expectedRemainingBalance) {
            throw new PaymentServiceError(
              'exceeds_remaining',
              `Invoice ${invoice.invoiceNumber} only has ${line.expectedRemainingBalance} RWF left to pay.`,
            )
          }
          return { invoice, amount: line.amount }
        })
        if (lines.reduce((total, line) => total + line.amount, 0) > unapplied) {
          throw new PaymentServiceError(
            'exceeds_unapplied',
            'That is more than the unapplied amount of this transaction.',
          )
        }

        try {
          for (const line of lines) {
            const current = ops.findTransaction(transaction.id)!
            ops.allocate({
              transaction: current,
              invoice: line.invoice,
              amount: line.amount,
              origin: 'MANUAL',
              actorUserId: actor.user.id,
              note: input.note,
            })
            ops.notifyAllocation(
              ops.findTransaction(transaction.id)!,
              ops.invoiceById(line.invoice.id)!,
              line.amount,
            )
          }
        } catch (error) {
          translateRuleError(error)
        }

        const after = ops.findTransaction(transaction.id)!
        if (
          unappliedAmountOf(after, ops.allocationsOfTransaction(after.id)) === 0 &&
          after.reviewState === 'NEEDS_REVIEW'
        ) {
          ops.saveTransaction({ ...after, reviewState: 'REVIEWED', reviewNote: input.note })
        }
        return detailsOf(merchantId, transaction.id)
      }),

    reverseAllocation: (merchantId, allocationId, { reason }) =>
      run(() => {
        const actor = requirePaymentActor(store, merchantId, 'payments:reconcile')
        const allocation = ledger.allocations
          .load()
          .find((a) => a.id === allocationId && a.merchantId === merchantId)
        if (!allocation)
          throw new PaymentServiceError('not_found', 'This allocation could not be found.')
        if (reason.trim().length < 3)
          throw new PaymentServiceError('validation', 'Give a reason for the correction.')
        try {
          ops.reverseAllocation(allocationId, {
            kind: 'MANUAL_CORRECTION',
            reason: reason.trim(),
            actorUserId: actor.user.id,
          })
        } catch (error) {
          translateRuleError(error)
        }
        return detailsOf(merchantId, allocation.bankTransactionId)
      }),

    markReviewed: (merchantId, bankTransactionId, { note, expectedTransactionVersion }) =>
      run(() => {
        const actor = requirePaymentActor(store, merchantId, 'payments:reconcile')
        const transaction = ops.findTransaction(bankTransactionId)
        if (!transaction || transaction.merchantId !== merchantId) {
          throw new PaymentServiceError('not_found', 'This transaction could not be found.')
        }
        if (transaction.version !== expectedTransactionVersion) {
          throw new PaymentServiceError(
            'allocation_conflict',
            'This transaction changed since you opened it. Reload it first.',
          )
        }
        if (note.trim().length < 3)
          throw new PaymentServiceError('validation', 'Add a short note about what you checked.')
        if (!requiresReview(transaction, ops.allocationsOfTransaction(transaction.id))) {
          throw new PaymentServiceError('invalid_state', 'This transaction does not need review.')
        }
        ops.saveTransaction({ ...transaction, reviewState: 'REVIEWED', reviewNote: note.trim() })
        ops.audit(merchantId, 'MARKED_REVIEWED', `Reviewed: ${note.trim()}`, {
          bankTransactionId,
          actorUserId: actor.user.id,
        })
        return detailsOf(merchantId, bankTransactionId)
      }),
  }
}
