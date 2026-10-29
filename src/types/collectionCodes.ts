import type { MembershipStatus } from './auth'
import type { ProviderId } from './banking'

/**
 * Where a collection code is in its life. Only the bank (or a trusted, evidenced operator process outside the merchant API) can
 * make a code ACTIVE: nothing a merchant can do approves a code.
 */
export type CollectionCodeStatus =
  'REQUESTED' | 'REQUEST_DECLARED' | 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED' | 'REJECTED'

/** Whether the bank has issued and approved an external code. There is no state in between that OuPay could claim. */
export type ExternalCodeState = 'NOT_ISSUED' | 'BANK_APPROVED'

export interface CodeApproval {
  /** Who recorded the approval: the bank event itself, or an authorised operator holding written bank evidence. */
  source: 'BANK_EVENT' | 'OPERATOR'
  /** The evidence reference. Present ONLY for people who manage codes (owners); everyone else gets null. */
  evidenceRef: string | null
  approvedAt: string
}

/** Why a code is not eligible for collection right now. Each one is a separate, plain fact. */
export type EligibilityIssue =
  | 'SIMULATED'
  | 'NOT_BANK_APPROVED'
  | 'NOT_ASSIGNED'
  | 'SETTLEMENT_ACCOUNT_NOT_CONNECTED'
  | 'BRANCH_INACTIVE'
  | 'ASSIGNEE_NOT_ACTIVE'
  | 'ASSIGNEE_NOT_AT_BRANCH'

export type AssigneeKind = 'MEMBER' | 'COLLECTION_POINT'

/**
 * One dated period during which a code belonged to a person or a collection point. Everything but the end is immutable, and the
 * name, role and branch are SNAPSHOTS: a later staff change never rewrites who held the code.
 */
export interface CodeAssignment {
  id: string
  codeId: string
  assigneeKind: AssigneeKind
  membershipId: string | null
  assigneeUserId: string | null
  assigneeName: string
  assigneeRole: string | null
  collectionPointLabel: string | null
  branchId: string | null
  branchName: string | null
  branchCode: string | null
  validFrom: string
  validTo: string | null
  assignedByName: string
  endedByName: string | null
  endReason: string | null
  /** The person's membership status RIGHT NOW, only for an open MEMBER assignment. Not part of the snapshot. */
  assigneeCurrentStatus: MembershipStatus | null
}

export interface CollectionCode {
  id: string
  /** OuPay's own identifier ("CC-7KQ2M9XA"). Internal: it is NEVER a bank code and customers never pay to it. */
  internalRef: string
  displayLabel: string
  providerId: ProviderId
  settlementDestinationId: string
  settlementAccountLabel: string
  settlementAccountMasked: string
  /** A code on a simulated demo account is never live, whatever its status. */
  simulated: boolean
  branchId: string | null
  branchName: string | null
  branchCode: string | null
  status: CollectionCodeStatus
  statusReason: string | null
  /** A reference the OWNER declares for a request made to the bank. Unverified. Present only for people who manage codes. */
  bankRequestRef: string | null
  externalCodeState: ExternalCodeState
  /** The bank-issued code. Present only when `externalCodeState` is BANK_APPROVED, and only for people who manage codes. */
  externalCode: string | null
  approval: CodeApproval | null
  /** The bank has provisioned it: ACTIVE, on a real (not simulated) account, with a bank-issued code. */
  bankProvisioned: boolean
  /** ELIGIBLE FOR COLLECTION RIGHT NOW: provisioned, held, connected, branch active and the holder able to act. Computed live. */
  payable: boolean
  /** Every reason it is not eligible right now (empty when it is). */
  eligibilityIssues: EligibilityIssue[]
  currentAssignment: CodeAssignment | null
  createdAt: string
  updatedAt: string
  version: number
}

export interface CollectionCodeBranchOption {
  id: string
  name: string
  code: string
  status: 'ACTIVE' | 'INACTIVE'
}

export interface CollectionCodeDestinationOption {
  id: string
  label: string
  maskedAccount: string
  providerId: ProviderId
  simulated: boolean
  connectionStatus: string
}

export interface CollectionCodeMemberOption {
  membershipId: string
  userId: string
  fullName: string
  role: string
  branchIds: string[]
}

export interface CollectionCodeOptions {
  destinations: CollectionCodeDestinationOption[]
  branches: CollectionCodeBranchOption[]
  members: CollectionCodeMemberOption[]
}

export interface CollectionCodePage {
  items: CollectionCode[]
  nextCursor: string | null
}

export interface AssignmentPage {
  items: CodeAssignment[]
  nextCursor: string | null
}

export interface ListCollectionCodesQuery {
  limit?: number
  cursor?: string | null
  status?: CollectionCodeStatus
  branchId?: string
  q?: string
}

export interface RequestCollectionCodeInput {
  /** One per submission attempt; kept across retries of the same submission so a retry cannot create a second request. */
  clientOperationId: string
  settlementDestinationId: string
  displayLabel: string
  branchId?: string
}

export interface CollectionCodeWriteResult {
  code: CollectionCode
  replayed: boolean
}

/** Who gets a code: a member OR a collection point, never both. */
export interface AssigneeInput {
  membershipId?: string
  collectionPointLabel?: string
  branchId?: string
}

export interface EndAssignmentInput {
  expectedAssignmentId: string
  reason: string
}

export interface ReassignInput extends AssigneeInput {
  expectedAssignmentId: string
  reason: string
}

export interface DeclareSubmissionInput {
  expectedVersion: number
  bankRequestRef: string
}

export interface StatusChangeInput {
  expectedVersion: number
  reason: string
}

/** What a signed-in member sees about their own code. A code that is not eligible never shows a code value. */
export interface MyCollectionCodeSummary {
  id: string
  displayLabel: string
  status: CollectionCodeStatus
  simulated: boolean
  branchName: string | null
  payable: boolean
  /** Present ONLY when the code is eligible for collection right now. */
  externalCode: string | null
  /** Plain-language explanation, written by the server. */
  message: string
}

export interface MyCollectionCode {
  assignment: CodeAssignment | null
  code: MyCollectionCodeSummary | null
}
