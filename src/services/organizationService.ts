export type OrganizationServiceErrorCode =
  | 'unauthenticated'
  /** Also used when the caller is not a member of the business, so existence is not revealed. */
  | 'not_found'
  | 'forbidden'
  | 'duplicate_branch_code'
  | 'branch_inactive'
  | 'duplicate_assignment'
  | 'membership_not_active'
  | 'invalid_transition'
  | 'last_owner'
  | 'self_escalation'
  | 'duplicate_invitation'
  | 'invalid_invitation'
  | 'invitation_email_mismatch'
  | 'validation'
  | 'service_unavailable'

/** Shared by the branch and staff services, which enforce one set of organisation rules. */
export class OrganizationServiceError extends Error {
  readonly code: OrganizationServiceErrorCode

  constructor(code: OrganizationServiceErrorCode, message: string) {
    super(message)
    this.name = 'OrganizationServiceError'
    this.code = code
  }
}
