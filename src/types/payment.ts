import type { ProviderId } from './banking'
import type { InvoicePaymentStatus } from './invoice'
import type { MerchantOwned } from './merchant'

/*
 * THE FINANCIAL LEDGER. Three independent concepts that must never be conflated:
 *   1. BankTransaction: what the BANK says happened (verified only via a trusted adapter).
 *   2. PaymentAllocation: how OuPay applied confirmed money to invoices.
 *   3. Invoice lifecycle: the commercial document (draft/issued/voided...).
 * Invoice payment information is DERIVED from active allocations; nothing else stores it.
 */

export type BankTransactionStatus = 'PENDING' | 'CONFIRMED' | 'FAILED' | 'REVERSED'
export type TransactionDirection = 'INCOMING' | 'OUTGOING'
export type ReviewState = 'NONE' | 'NEEDS_REVIEW' | 'REVIEWED'

export interface BankTransaction extends MerchantOwned {
  id: string
  bankAccountId: string
  provider: ProviderId
  providerTransactionId: string
  /** The most recent provider event applied to this transaction. */
  providerEventId: string
  direction: TransactionDirection
  /** Integer RWF. */
  amount: number
  currency: 'RWF'
  /** Exact reference the bank reported. Only an exact match is ever trusted. */
  paymentReference: string | null
  payerDisplayName: string
  providerOccurredAt: string
  receivedAt: string
  status: BankTransactionStatus
  createdAt: string
  updatedAt: string
  /** True for anything produced by the simulator. Never present it as a real payment. */
  isSimulated: boolean
  /** Provider time of the latest status applied; older events are ignored as stale. */
  statusAppliedAt: string
  /** Set when the reference exactly matched an OuPay payment request. */
  paymentRequestId: string | null
  reviewState: ReviewState
  reviewReason?: string
  reviewNote?: string
  /** Increments on every ledger change; manual allocations must quote it. */
  version: number
}

export type AllocationStatus = 'ACTIVE' | 'REVERSED'
export type AllocationOrigin = 'AUTO_REFERENCE' | 'MANUAL'
export type ReversalKind = 'BANK_REVERSAL' | 'MANUAL_CORRECTION'

export interface PaymentAllocation extends MerchantOwned {
  id: string
  bankTransactionId: string
  invoiceId: string
  /** Integer RWF applied to the invoice. */
  amount: number
  allocationStatus: AllocationStatus
  origin: AllocationOrigin
  /** Null when OuPay's own reconciliation created it from an exact reference. */
  createdByUserId: string | null
  createdAt: string
  reversedAt?: string
  reversedByUserId?: string | null
  reversalKind?: ReversalKind
  reversalReason?: string
}

/**
 * Derived from allocations on every read. OVERPAID exists for completeness: the engine
 * refuses allocations above the remaining balance, so it is never produced today.
 */
export interface InvoicePaymentSummary {
  invoiceTotal: number
  allocatedAmount: number
  remainingBalance: number
  /** Allocated beyond the total. Always 0 while overpayment protection holds. */
  unappliedAmount: number
  paymentStatus: Extract<InvoicePaymentStatus, 'UNPAID' | 'PARTIALLY_PAID' | 'PAID' | 'OVERPAID'>
}

/**
 * Money returned to a customer by the merchant. A refund is NOT a bank reversal: a
 * reversal is the bank undoing a transaction (and reverses its allocations), while a refund
 * is a separate payout. Recorded on its own and never alters transaction or allocation state.
 */
export interface RefundRecord extends MerchantOwned {
  id: string
  invoiceId: string
  bankTransactionId: string | null
  amount: number
  reason: string
  recordedByUserId: string
  createdAt: string
}

export type ReconciliationStatus =
  | 'NOT_APPLICABLE' // pending or failed: nothing to reconcile yet
  | 'UNMATCHED' // confirmed, no trustworthy reference, nothing allocated
  | 'COLLECTED' // confirmed against an open payment request, awaiting any invoice allocation
  | 'PARTIALLY_ALLOCATED'
  | 'FULLY_ALLOCATED'
  | 'REVERSED'

export type AuditEntryKind =
  | 'EVENT_RECEIVED'
  | 'DUPLICATE_EVENT_IGNORED'
  | 'STALE_EVENT_IGNORED'
  | 'TRANSACTION_CREATED'
  | 'STATUS_CHANGED'
  | 'REFERENCE_MATCHED'
  | 'AUTO_ALLOCATED'
  | 'MANUAL_ALLOCATED'
  | 'ALLOCATION_REVERSED'
  | 'BANK_REVERSAL'
  | 'FLAGGED_FOR_REVIEW'
  | 'MARKED_REVIEWED'
  | 'REFUND_RECORDED'

/** Append-only history. Entries are never edited or deleted. */
export interface AuditEntry extends MerchantOwned {
  id: string
  bankTransactionId: string | null
  invoiceId: string | null
  kind: AuditEntryKind
  /** Null means the system (the trusted event processor) acted. */
  actorUserId: string | null
  message: string
  createdAt: string
}

export type BankEventOutcome = 'APPLIED' | 'DUPLICATE' | 'STALE' | 'REJECTED'

/**
 * Immutable record of every provider event the processor saw, keyed by provider event ID so
 * a replay can never be applied twice. A real backend stores the raw signed payload securely.
 */
export interface BankEventRecord {
  id: string
  providerId: ProviderId
  providerEventId: string
  providerTransactionId: string
  merchantId: string | null
  outcome: BankEventOutcome
  receivedAt: string
}

export interface TransactionInvoiceLink {
  invoiceId: string
  invoiceNumber: string
  amount: number
  allocationStatus: AllocationStatus
}

/** A transaction as lists show it: ledger facts plus derived reconciliation figures. */
export interface BankTransactionView extends BankTransaction {
  allocatedAmount: number
  /** Confirmed money not (or no longer) applied to any invoice. */
  unappliedAmount: number
  reconciliationStatus: ReconciliationStatus
  /** Invoices this money is (or was) applied to, with their numbers. */
  invoices: TransactionInvoiceLink[]
  /** Cashiers verified through allocation to their invoices, never guessed from the bank event. */
  verifiedCashierNames: string[]
}

export interface AllocationView extends PaymentAllocation {
  invoiceNumber: string
  customerName: string
  transactionReference: string | null
  transactionAmount: number
  isSimulated: boolean
}

export interface BankTransactionDetails {
  transaction: BankTransactionView
  allocations: AllocationView[]
  auditHistory: AuditEntry[]
}

export interface ManualAllocationInput {
  bankTransactionId: string
  /** The version of the transaction the user was looking at. */
  expectedTransactionVersion: number
  allocations: { invoiceId: string; amount: number; expectedRemainingBalance: number }[]
  note?: string
}
