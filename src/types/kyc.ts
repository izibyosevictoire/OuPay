/**
 * Equity activation: the KYC information OuPay collects from a business OWNER for Equity Bank.
 *
 * Honest wording is part of the model. `COLLECTED` means "submitted to OuPay for review": it does NOT mean Equity has received,
 * reviewed or approved anything. `HANDED_OFF`, `MORE_INFO_REQUESTED`, `APPROVED` and `REJECTED` exist only when evidence of what the
 * bank did has been recorded (by a process outside this app); no screen can set them.
 */
export type KycApplicationStatus =
  'DRAFT' | 'COLLECTED' | 'HANDED_OFF' | 'MORE_INFO_REQUESTED' | 'APPROVED' | 'REJECTED'

export type KycFieldType = 'TEXT' | 'EMAIL' | 'PHONE' | 'CHOICE'

export interface KycOption {
  value: string
  label: string
}

/** The field or document applies only when another field has one of these values. */
export interface KycAppliesWhen {
  key: string
  in: string[]
}

export interface KycSection {
  key: string
  label: string
}

export interface KycField {
  key: string
  section: string
  label: string
  type: KycFieldType
  required: boolean
  sensitive: boolean
  maxLength?: number | null
  pattern?: string | null
  patternHint?: string | null
  help?: string | null
  options?: KycOption[] | null
  appliesWhen?: KycAppliesWhen | null
}

export interface KycDocumentRequirement {
  key: string
  label: string
  required: boolean
  /** An actual stored file is mandatory before submission; "ready" never satisfies it. */
  requiredAtSubmission?: boolean
  appliesWhen?: KycAppliesWhen | null
}

export interface KycRequirementDefinition {
  note: string
  sections: KycSection[]
  fields: KycField[]
  documents: KycDocumentRequirement[]
  consent: { textVersion: string; text: string }
}

export interface KycRequirementSet {
  version: number
  /** True while the list has not been confirmed by the bank. */
  provisional: boolean
  effectiveFrom: string
  definition: KycRequirementDefinition
}

export interface KycStorageInfo {
  documentUploadAvailable: boolean
  sensitiveStorageAvailable: boolean
  /** Showing a saved protected value in full. Off unless a separately secured workflow exists. */
  revealAvailable: boolean
  /** OuPay has no channel to Equity yet. */
  submissionToEquityAvailable: boolean
  note: string
}

export interface KycLinkedAccount {
  label: string
  maskedAccount: string
  providerId: string
  simulated: boolean
}

export interface KycApplicationSummary {
  id: string
  status: KycApplicationStatus
  requirementSetVersion: number
  createdAt: string
  submittedAt: string | null
  decidedAt: string | null
}

export interface KycOptions {
  providerId: 'EQUITY'
  requirementSet: KycRequirementSet
  /** What the business registration already tells us. Never includes a protected field. */
  prefill: Record<string, string>
  storage: KycStorageInfo
  linkedAccounts: KycLinkedAccount[]
  current: KycApplicationSummary | null
  retentionConfigured: boolean
}

/** A protected answer never carries its value: only that it exists and a masked hint. */
export interface KycAnswer {
  key: string
  sensitive: boolean
  value: string | null
  hasValue: boolean
  hint: string | null
  source: 'PREFILL' | 'OWNER'
}

export type KycDocumentState = 'NOT_PROVIDED' | 'DECLARED_READY' | 'STORED'

export interface KycDocument {
  key: string
  label: string
  required: boolean
  applies: boolean
  state: KycDocumentState
  declaredReadyAt: string | null
  uploadAvailable: boolean
}

export interface KycConsent {
  id: string
  givenAt: string
  consentTextVersion: string
  requirementSetVersion: number
  consentingName: string
  /** False when the answers changed after consent was given. */
  current: boolean
}

export interface KycInformationRequest {
  id: string
  message: string
  fieldKey: string | null
  status: 'OPEN' | 'RESPONDED'
  requestedAt: string
  response: string | null
  respondedAt: string | null
}

export interface KycReadiness {
  missingFields: string[]
  consent: 'NONE' | 'CURRENT' | 'OUTDATED'
  outstandingDocuments: string[]
  /** Documents that must exist as a stored file before submission. */
  blockingDocuments: string[]
  canSubmit: boolean
}

export interface KycApplication {
  id: string
  providerId: 'EQUITY'
  status: KycApplicationStatus
  requirementSetVersion: number
  version: number
  createdAt: string
  updatedAt: string
  submittedAt: string | null
  handedOffAt: string | null
  decidedAt: string | null
  decisionReason: string | null
  answers: KycAnswer[]
  documents: KycDocument[]
  consent: KycConsent | null
  informationRequests: KycInformationRequest[]
  readiness: KycReadiness
}

export interface KycWriteResult {
  application: KycApplication
  /** The same request had already been made: nothing new was created. */
  replayed: boolean
}

export interface KycRevealedValue {
  key: string
  value: string
}
