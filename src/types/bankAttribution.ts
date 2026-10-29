import type { BankTransactionStatus, ReviewState } from './payment'

/**
 * How a bank transaction was attributed to a collection code and, when the payment names one, to a code sale (R6d). Read-only: nothing
 * here can confirm a payment, resolve a code or allocate money; those happen only in the trusted bank-event processor and in the audited
 * manual reconciliation.
 *
 * FIVE DIFFERENT FACTS, never one status: the money is CONFIRMED (`transactionStatus`); the code is ATTRIBUTED (`codeResolved`); the sale's
 * exact reference is MATCHED (`saleReferenceMatched`); money is ALLOCATED (`allocatedToSaleRwf`, `allocationOrigin`); and the sale is
 * FULLY PAID (`saleFullyPaid`). `stage` is derived by the server from those facts and is never set.
 */
export type AttributionStatus =
  'RESOLVED' | 'UNRESOLVED' | 'CONFLICT' | 'NOT_REPORTED' | 'NOT_EVALUATED'
export type AttributionBasis = 'CODE_REPORTED' | 'ACCOUNT_ONLY' | 'UNATTRIBUTED'

/**
 * A CONCLUSION kept apart from the evidence. CONFIRMED_FROM_SALE_SNAPSHOT: sale, bank-reported code and account all agree.
 * SALE_NAMED_UNCONFIRMED: the exact sale is named but the bank reported no code, so the agent is NOT confirmed as the collector.
 */
export type AgentAttribution =
  'CONFIRMED_FROM_SALE_SNAPSHOT' | 'SALE_NAMED_UNCONFIRMED' | 'UNRESOLVED'

export type CodePaymentStage =
  | 'NOT_CONFIRMED'
  | 'AWAITING_MATCHING'
  | 'CODE_RESOLVED'
  | 'SALE_MATCHED'
  | 'ALLOCATED'
  | 'FULLY_PAID'
  | 'CONFLICT'

/** How money was applied to the sale. MANUAL is an authorised person's decision and never counts as an automatic match. */
export type SaleAllocationOrigin = 'AUTO_REFERENCE' | 'MANUAL' | 'MIXED'

export interface BankAttributionCode {
  id: string
  label: string
  branchId: string | null
}

export interface BankAttribution {
  merchantId: string
  transactionId: string
  providerTransactionId: string
  transactionStatus: BankTransactionStatus
  amountRwf: number
  occurredAt: string
  /** What the bank reported, masked (`••••77`) unless the reader may see it in full. */
  reportedCode: string | null
  reportedCodeMasked: boolean
  /** One of the business's own codes, only when the reported value resolved to it. */
  collectionCode: BankAttributionCode | null
  attributionStatus: AttributionStatus
  attributionBasis: AttributionBasis | null
  agentAttribution: AgentAttribution | null
  /** Only when the agent is CONFIRMED and the money is verified. Never derived from timestamps or current assignments. */
  agentName: string | null
  saleReference: string | null
  saleInvoiceId: string | null
  stage: CodePaymentStage
  codeResolved: boolean
  saleReferenceNamed: boolean
  saleReferenceMatched: boolean
  allocatedToSaleRwf: number
  allocationOrigin: SaleAllocationOrigin | null
  saleFullyPaid: boolean
  reviewState: ReviewState
  createdAt: string
}
