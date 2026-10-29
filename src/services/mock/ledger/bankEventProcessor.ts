import { formatRwf } from '@/lib/format'
import type { BankTransactionStatus, BankEventOutcome, BankTransaction } from '@/types/payment'
import type { NormalizedBankEvent } from '@/types/banking'
import type { MockAuthStore } from '../mockAuthStore'
import { createLedgerOperations, LedgerRuleError } from './ledgerOperations'
import { newId, type LedgerStore } from './mockLedgerStore'

export interface ProcessingResult {
  outcome: BankEventOutcome
  transactionId?: string
  reason?: string
}

/**
 * Which status changes are legal, in provider time order. PENDING can settle either way;
 * CONFIRMED can only be reversed; FAILED and REVERSED are final.
 */
const ALLOWED_TRANSITIONS: Record<BankTransactionStatus, BankTransactionStatus[]> = {
  PENDING: ['CONFIRMED', 'FAILED', 'REVERSED'],
  CONFIRMED: ['REVERSED'],
  FAILED: [],
  REVERSED: [],
}

/**
 * THE TRUSTED BANK-EVENT PROCESSOR (simulated).
 *
 * In production this is server-side code, reachable only by an authenticated bank adapter:
 * it authenticates the provider, deduplicates events, keeps an immutable raw record, applies
 * allocations inside a database transaction, and logs without sensitive payloads. Here it is
 * an in-process simulation, and it is deliberately NOT exported through `services/index.ts`:
 * ordinary UI code has no way to call it. Only the demo simulator does, and only when demo
 * tools are enabled.
 *
 * Rules enforced here:
 * - Exact reference only. Never match by amount, time, payer name or branch.
 * - One BankTransaction per (provider, providerTransactionId): a replay or re-delivery can
 *   never create a second one or count money twice.
 * - Duplicate provider events are ignored; stale (older) events never overwrite newer state.
 * - Allocations never exceed what the invoice owes (overpayment protection).
 */
export function createBankEventProcessor(
  store: MockAuthStore,
  ledger: LedgerStore,
  now: () => Date = () => new Date(),
) {
  const ops = createLedgerOperations(store, ledger, now)

  const recordEvent = (
    event: NormalizedBankEvent,
    merchantId: string | null,
    outcome: BankEventOutcome,
  ) => {
    ledger.bankEvents.save([
      ...ledger.bankEvents.load(),
      {
        id: newId('evt'),
        providerId: event.providerId,
        providerEventId: event.providerEventId,
        providerTransactionId: event.providerTransactionId,
        merchantId,
        outcome,
        receivedAt: ops.timestamp(),
      },
    ])
  }

  /** Reference matching on a CONFIRMED transaction. Exact references only. */
  const reconcileConfirmed = (initial: BankTransaction) => {
    let transaction = initial
    const reference = transaction.paymentReference
    if (!reference) {
      // No reference to trust: stays unmatched and surfaces for review.
      ops.audit(
        transaction.merchantId,
        'EVENT_RECEIVED',
        'Confirmed with no payment reference, so nothing was matched.',
        { bankTransactionId: transaction.id },
      )
      ops.notifyUnmatched(transaction)
      return
    }

    const request = ledger.paymentRequests
      .load()
      .find(
        (candidate) =>
          candidate.merchantId === transaction.merchantId &&
          candidate.publicReference === reference,
      )
    // CODE sales are never matched here: not by their sale reference, nor by their invoice number. The money stays confirmed and
    // unmatched, for review, until bank attribution exists (R6d).
    const referenced = request?.invoiceId
      ? ops.invoiceById(request.invoiceId)
      : store
          .loadInvoices()
          .find(
            (candidate) =>
              candidate.merchantId === transaction.merchantId &&
              candidate.invoiceNumber === reference,
          )
    if (referenced?.saleChannel === 'CODE') {
      ops.flagForReview(
        transaction,
        `The reference ${reference} names a code sale. Code sales are not matched to bank money automatically yet, so this payment stays confirmed and unmatched for review.`,
      )
      return
    }
    if (request && transaction.paymentRequestId !== request.id) {
      transaction = ops.saveTransaction({ ...transaction, paymentRequestId: request.id })
      ops.audit(
        transaction.merchantId,
        'REFERENCE_MATCHED',
        `The reference ${reference} exactly matches a payment request.`,
        { bankTransactionId: transaction.id },
      )
    }

    // An invoice request names its invoice; otherwise the exact invoice number may be the reference.
    const invoice = request?.invoiceId
      ? ops.invoiceById(request.invoiceId)
      : store
          .loadInvoices()
          .find(
            (candidate) =>
              candidate.merchantId === transaction.merchantId &&
              candidate.invoiceNumber === reference,
          )

    if (!invoice) {
      if (request) {
        // An open request with no invoice: confirmed money stays a merchant collection.
        ops.notifyCollected(transaction)
        return
      }
      ops.flagForReview(transaction, 'The reference does not match any invoice or payment request.')
      ops.notifyUnmatched(transaction)
      return
    }

    const remaining = ops.decorate(invoice).payment!.remainingBalance
    if (invoice.status !== 'ISSUED') {
      ops.flagForReview(
        transaction,
        `Invoice ${invoice.invoiceNumber} is ${invoice.status.toLowerCase()} and cannot receive payments.`,
      )
      return
    }
    if (remaining === 0) {
      ops.flagForReview(
        transaction,
        `Invoice ${invoice.invoiceNumber} is already fully paid; this looks like an overpayment.`,
      )
      return
    }

    // Overpayment protection: apply no more than the invoice owes, flag the rest.
    const amountToApply = Math.min(transaction.amount, remaining)
    try {
      ops.allocate({
        transaction,
        invoice,
        amount: amountToApply,
        origin: 'AUTO_REFERENCE',
        actorUserId: null,
      })
    } catch (error) {
      if (error instanceof LedgerRuleError) {
        ops.flagForReview(transaction, error.message)
        return
      }
      throw error
    }
    ops.notifyAllocation(
      ops.findTransaction(transaction.id)!,
      ops.invoiceById(invoice.id)!,
      amountToApply,
    )
    if (amountToApply < transaction.amount) {
      ops.flagForReview(
        ops.findTransaction(transaction.id)!,
        `Overpayment: ${formatRwf(transaction.amount - amountToApply)} could not be applied to ${invoice.invoiceNumber}.`,
      )
    }
  }

  const reverseAllocationsOfTransaction = (transaction: BankTransaction) => {
    const affected = ops
      .allocationsOfTransaction(transaction.id)
      .filter((allocation) => allocation.allocationStatus === 'ACTIVE')
    const invoices = affected.flatMap((allocation) => {
      ops.reverseAllocation(allocation.id, {
        kind: 'BANK_REVERSAL',
        reason: 'The bank reversed the transaction.',
        actorUserId: null,
      })
      const invoice = ops.invoiceById(allocation.invoiceId)
      return invoice ? [invoice] : []
    })
    ops.audit(
      transaction.merchantId,
      'BANK_REVERSAL',
      'The bank reversed this transaction; its allocations were reversed and invoice balances restored.',
      { bankTransactionId: transaction.id },
    )
    ops.notifyReversal(transaction, invoices)
  }

  const processEvent = (event: NormalizedBankEvent): ProcessingResult => {
    if (event.direction !== 'INCOMING') {
      recordEvent(event, null, 'REJECTED')
      return { outcome: 'REJECTED', reason: 'Only incoming payments are processed.' }
    }

    // The account the money reached decides the merchant. An unknown or disabled link is refused.
    const connection = ledger.bankConnections
      .load()
      .find(
        (candidate) =>
          candidate.bankAccountId === event.bankAccountId &&
          candidate.providerId === event.providerId,
      )
    if (!connection || connection.status !== 'CONNECTED') {
      recordEvent(event, null, 'REJECTED')
      return {
        outcome: 'REJECTED',
        reason: 'The bank account is not linked to an active connection.',
      }
    }
    const merchantId = connection.merchantId

    // Duplicate provider events (webhook retries, replays) are recorded and ignored.
    const alreadySeen = ledger.bankEvents
      .load()
      .some(
        (record) =>
          record.providerId === event.providerId &&
          record.providerEventId === event.providerEventId,
      )
    const known = ledger.bankTransactions
      .load()
      .find(
        (candidate) =>
          candidate.provider === event.providerId &&
          candidate.providerTransactionId === event.providerTransactionId &&
          candidate.merchantId === merchantId,
      )
    if (alreadySeen) {
      recordEvent(event, merchantId, 'DUPLICATE')
      ops.audit(
        merchantId,
        'DUPLICATE_EVENT_IGNORED',
        `Ignored a repeated provider event (${event.providerEventId}).`,
        { bankTransactionId: known?.id ?? null },
      )
      return {
        outcome: 'DUPLICATE',
        transactionId: known?.id,
        reason: 'This event was already processed.',
      }
    }

    if (!known) {
      const stamp = ops.timestamp()
      const created: BankTransaction = {
        id: newId('btx'),
        merchantId,
        bankAccountId: event.bankAccountId,
        provider: event.providerId,
        providerTransactionId: event.providerTransactionId,
        providerEventId: event.providerEventId,
        direction: event.direction,
        amount: event.amount,
        currency: event.currency,
        paymentReference: event.paymentReference,
        payerDisplayName: event.payerDisplayName,
        providerOccurredAt: event.providerOccurredAt,
        receivedAt: stamp,
        status: event.status,
        createdAt: stamp,
        updatedAt: stamp,
        isSimulated: event.isSimulated,
        statusAppliedAt: event.providerOccurredAt,
        paymentRequestId: null,
        reviewState: 'NONE',
        version: 1,
      }
      ledger.bankTransactions.save([...ledger.bankTransactions.load(), created])
      ops.audit(
        merchantId,
        'TRANSACTION_CREATED',
        `${event.isSimulated ? 'Simulated ' : ''}${event.status.toLowerCase()} payment of ${formatRwf(event.amount)} received.`,
        { bankTransactionId: created.id },
      )
      recordEvent(event, merchantId, 'APPLIED')
      if (created.status === 'CONFIRMED') reconcileConfirmed(created)
      return { outcome: 'APPLIED', transactionId: created.id }
    }

    // The same transaction again: validate it, then apply only a legal, newer status change.
    if (known.amount !== event.amount) {
      recordEvent(event, merchantId, 'REJECTED')
      ops.audit(
        merchantId,
        'EVENT_RECEIVED',
        `Rejected an event whose amount (${formatRwf(event.amount)}) differs from the recorded ${formatRwf(known.amount)}.`,
        { bankTransactionId: known.id },
      )
      return {
        outcome: 'REJECTED',
        transactionId: known.id,
        reason: 'The amount does not match the recorded transaction.',
      }
    }
    if (event.status === known.status) {
      recordEvent(event, merchantId, 'DUPLICATE')
      ops.audit(
        merchantId,
        'DUPLICATE_EVENT_IGNORED',
        'Ignored an event that repeats the current status.',
        { bankTransactionId: known.id },
      )
      return {
        outcome: 'DUPLICATE',
        transactionId: known.id,
        reason: 'The transaction is already in this status.',
      }
    }
    const isNewer = event.providerOccurredAt >= known.statusAppliedAt
    if (!isNewer || !ALLOWED_TRANSITIONS[known.status].includes(event.status)) {
      recordEvent(event, merchantId, 'STALE')
      ops.audit(
        merchantId,
        'STALE_EVENT_IGNORED',
        `Ignored an out-of-date ${event.status.toLowerCase()} event; the transaction stays ${known.status.toLowerCase()}.`,
        { bankTransactionId: known.id },
      )
      return {
        outcome: 'STALE',
        transactionId: known.id,
        reason: 'The event is older than, or cannot follow, the current status.',
      }
    }

    const updated = ops.saveTransaction({
      ...known,
      status: event.status,
      providerEventId: event.providerEventId,
      statusAppliedAt: event.providerOccurredAt,
      // A reference that arrives later is accepted only if none was recorded yet.
      paymentReference: known.paymentReference ?? event.paymentReference,
    })
    ops.audit(
      merchantId,
      'STATUS_CHANGED',
      `Status changed from ${known.status.toLowerCase()} to ${event.status.toLowerCase()}.`,
      { bankTransactionId: known.id },
    )
    recordEvent(event, merchantId, 'APPLIED')

    if (event.status === 'CONFIRMED') reconcileConfirmed(updated)
    if (event.status === 'REVERSED' && known.status === 'CONFIRMED')
      reverseAllocationsOfTransaction(updated)
    return { outcome: 'APPLIED', transactionId: known.id }
  }

  return { processEvent }
}

export type BankEventProcessor = ReturnType<typeof createBankEventProcessor>
