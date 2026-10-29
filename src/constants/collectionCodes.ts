import type { CollectionCodeStatus, EligibilityIssue } from '@/types/collectionCodes'

export const COLLECTION_CODE_PAGE_SIZE = 20
export const COLLECTION_CODE_MAX_LABEL = 60
export const COLLECTION_CODE_MAX_REASON = 200
export const COLLECTION_CODE_MAX_BANK_REF = 200
export const COLLECTION_POINT_MAX_LABEL = 60

export const COLLECTION_CODE_STATUS_LABELS: Record<CollectionCodeStatus, string> = {
  REQUESTED: 'Requested (not sent to Equity)',
  REQUEST_DECLARED: 'Request declared by owner (not confirmed by Equity)',
  ACTIVE: 'Active',
  SUSPENDED: 'Suspended',
  DEACTIVATED: 'Deactivated',
  REJECTED: 'Rejected',
}

export const COLLECTION_CODE_STATUS_HINTS: Record<CollectionCodeStatus, string> = {
  REQUESTED: 'An internal request. Nothing has been sent to Equity.',
  REQUEST_DECLARED:
    'The owner says a request was made to the bank. OuPay has no confirmation from Equity.',
  ACTIVE: 'Approved by the bank, with evidence recorded.',
  SUSPENDED: 'Paused. It is not a payment instruction.',
  DEACTIVATED: 'Closed for good. It cannot be reassigned or reused.',
  REJECTED: 'The bank did not approve it.',
}

/** DEACTIVATED and REJECTED are final: nothing more can be done to such a code. */
export const FINAL_CODE_STATUSES: readonly CollectionCodeStatus[] = ['DEACTIVATED', 'REJECTED']

export const COLLECTION_CODE_STATUS_TONE: Record<CollectionCodeStatus, string> = {
  REQUESTED: 'bg-muted text-muted-foreground',
  REQUEST_DECLARED: 'bg-warning-soft text-warning',
  ACTIVE: 'bg-success-soft text-success',
  SUSPENDED: 'bg-warning-soft text-warning',
  DEACTIVATED: 'bg-muted text-muted-foreground',
  REJECTED: 'bg-danger-soft text-danger',
}

/** Plain-language reasons a code is not eligible for collection right now. */
export const ELIGIBILITY_ISSUE_LABELS: Record<EligibilityIssue, string> = {
  SIMULATED: 'It is a simulated code, never a live one.',
  NOT_BANK_APPROVED: 'The bank has not provisioned it.',
  NOT_ASSIGNED: 'Nobody holds it.',
  SETTLEMENT_ACCOUNT_NOT_CONNECTED: 'Its settlement account is not connected.',
  BRANCH_INACTIVE: 'Its branch is not active.',
  ASSIGNEE_NOT_ACTIVE: 'The person holding it is not active.',
  ASSIGNEE_NOT_AT_BRANCH: 'The person holding it no longer works at its branch.',
}

/** The one wording for OuPay’s own identifier, wherever it appears. */
export const INTERNAL_REF_LABEL = 'OuPay internal reference, not a payment code'
