import type {
  AssigneeInput,
  AssignmentPage,
  CodeAssignment,
  CollectionCode,
  CollectionCodeOptions,
  CollectionCodePage,
  CollectionCodeWriteResult,
  DeclareSubmissionInput,
  EndAssignmentInput,
  ListCollectionCodesQuery,
  MyCollectionCode,
  ReassignInput,
  RequestCollectionCodeInput,
  StatusChangeInput,
} from '@/types/collectionCodes'

export type CollectionCodeServiceErrorCode =
  | 'unauthenticated'
  /** Also used for businesses the caller does not belong to. */
  | 'not_found'
  | 'forbidden'
  | 'validation'
  /** The code's status does not allow that. */
  | 'code_status_invalid'
  | 'assignee_not_eligible'
  | 'branch_not_eligible'
  | 'already_assigned'
  /** The assignment changed since the person last looked at it. */
  | 'assignment_changed'
  | 'no_open_assignment'
  /** The same request id was used for a different request. */
  | 'client_request_id_reuse'
  | 'settlement_account_unavailable'
  | 'version_conflict'
  | 'service_unavailable'

export class CollectionCodeServiceError extends Error {
  readonly code: CollectionCodeServiceErrorCode

  constructor(code: CollectionCodeServiceErrorCode, message: string) {
    super(message)
    this.name = 'CollectionCodeServiceError'
    this.code = code
  }
}

/**
 * The registry of merchant collection codes and who holds them. It is INTERNAL bookkeeping: it never creates a bank code and
 * never marks one bank-approved. There is deliberately no method here that approves or activates a code, records a bank-issued
 * code, or turns a pending code into a payment instruction: that belongs to a trusted bank/operator process outside the merchant
 * API. The server (or the mock) is authoritative for every rule; the browser validates for convenience only.
 */
export interface CollectionCodeService {
  /** What the caller may use in the forms: settlement accounts, branches and assignable members. */
  getOptions(merchantId: string): Promise<CollectionCodeOptions>
  /** Newest first, keyset-paged. */
  listCodes(merchantId: string, query?: ListCollectionCodesQuery): Promise<CollectionCodePage>
  getCode(merchantId: string, codeId: string): Promise<CollectionCode>
  /** An internal request (status REQUESTED). Nothing is sent to Equity. Idempotent by `clientOperationId`. */
  requestCode(
    merchantId: string,
    input: RequestCollectionCodeInput,
  ): Promise<CollectionCodeWriteResult>
  /** Assignment history, newest first, keyset-paged. */
  listAssignments(
    merchantId: string,
    codeId: string,
    query?: { limit?: number; cursor?: string | null },
  ): Promise<AssignmentPage>
  /** Gives a code that has no open assignment to someone. */
  assign(merchantId: string, codeId: string, input: AssigneeInput): Promise<CodeAssignment>
  endAssignment(
    merchantId: string,
    codeId: string,
    input: EndAssignmentInput,
  ): Promise<CodeAssignment>
  /** Ends the open assignment and opens the next one in one step. */
  reassign(merchantId: string, codeId: string, input: ReassignInput): Promise<CodeAssignment>
  /** The owner DECLARES that a request was made to the bank, with its reference. Unverified, and not approval. */
  declareSubmission(
    merchantId: string,
    codeId: string,
    input: DeclareSubmissionInput,
  ): Promise<CollectionCode>
  suspend(merchantId: string, codeId: string, input: StatusChangeInput): Promise<CollectionCode>
  /** Final. Ends any open assignment. */
  deactivate(merchantId: string, codeId: string, input: StatusChangeInput): Promise<CollectionCode>
  /** The caller's own current assignment and code. */
  getMyCode(merchantId: string): Promise<MyCollectionCode>
}
