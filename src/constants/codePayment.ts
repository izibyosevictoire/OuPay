import type {
  AgentAttribution,
  AttributionStatus,
  CodePaymentStage,
  SaleAllocationOrigin,
} from '@/types/bankAttribution'

/**
 * Words for the five facts about a code payment. They are deliberately different phrases: "confirmed", "attributed", "matched",
 * "allocated" and "paid" are not interchangeable, and manual money is never described as an automatic match.
 */
export const CODE_PAYMENT_STAGE_LABELS: Record<CodePaymentStage, string> = {
  NOT_CONFIRMED: 'Not confirmed by the bank',
  AWAITING_MATCHING: 'Verified funds awaiting matching',
  CODE_RESOLVED: 'Code resolved, sale not matched',
  SALE_MATCHED: 'Sale reference matched',
  ALLOCATED: 'Money allocated, sale not fully paid',
  FULLY_PAID: 'Sale fully paid',
  CONFLICT: 'Conflict: needs investigation',
}

export const ATTRIBUTION_STATUS_LABELS: Record<AttributionStatus, string> = {
  RESOLVED: 'Code resolved',
  UNRESOLVED: 'Code not recognised',
  CONFLICT: 'Conflicting evidence',
  NOT_REPORTED: 'No code reported',
  NOT_EVALUATED: 'Not evaluated',
}

export const SALE_ALLOCATION_ORIGIN_LABELS: Record<SaleAllocationOrigin, string> = {
  AUTO_REFERENCE: 'Applied automatically on complete bank evidence',
  MANUAL: 'Applied by hand by an authorised person',
  MIXED: 'Applied partly automatically and partly by hand',
}

export const AGENT_ATTRIBUTION_LABELS: Record<AgentAttribution, string> = {
  CONFIRMED_FROM_SALE_SNAPSHOT: 'Confirmed from the sale record',
  SALE_NAMED_UNCONFIRMED: 'Not confirmed',
  UNRESOLVED: 'Not identified',
}

/** Shown wherever a payment came from the simulated provider. */
export const SIMULATED_PAYMENT_NOTICE =
  'Simulated payment from the demo provider. It is not a deposit into a real bank account.'

/** How many transactions one page of the list shows. */
export const TRANSACTIONS_PAGE_SIZE = 15
