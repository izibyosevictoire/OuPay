import type {
  KycApplication,
  KycApplicationSummary,
  KycOptions,
  KycRevealedValue,
  KycWriteResult,
} from '@/types/kyc'

export type KycServiceErrorCode =
  | 'unauthenticated'
  /** Also used for businesses and applications the caller may not see. */
  | 'not_found'
  | 'forbidden'
  | 'validation'
  | 'application_exists'
  | 'application_not_editable'
  | 'application_incomplete'
  | 'consent_required'
  | 'consent_text_changed'
  | 'invalid_transition'
  | 'version_conflict'
  | 'client_request_id_reuse'
  | 'sensitive_storage_unavailable'
  | 'sensitive_value_unreadable'
  | 'documents_required'
  | 'not_implemented'
  | 'service_unavailable'

export class KycServiceError extends Error {
  readonly code: KycServiceErrorCode

  constructor(code: KycServiceErrorCode, message: string) {
    super(message)
    this.name = 'KycServiceError'
    this.code = code
  }
}

/**
 * Equity activation (KYC) for the business OWNER. Every method verifies the signed-in person's ACTIVE ownership of the business; the
 * server (or the mock standing in for it) is authoritative. Nothing here can set a status beyond "submitted to OuPay": hand-off, bank
 * requests and decisions are recorded elsewhere, only with evidence.
 */
export interface KycService {
  getOptions(merchantId: string): Promise<KycOptions>
  listApplications(merchantId: string): Promise<KycApplicationSummary[]>
  getApplication(merchantId: string, applicationId: string): Promise<KycApplication>
  /** Starts a prefilled draft. Repeating the same `clientOperationId` returns the same application. */
  startApplication(merchantId: string, clientOperationId: string): Promise<KycWriteResult>
  /** A blank value clears an answer. The whole save is refused if any value is invalid. */
  saveAnswers(
    merchantId: string,
    applicationId: string,
    expectedVersion: number,
    answers: Record<string, string>,
  ): Promise<KycApplication>
  /** Records that the owner SAYS a document is ready. No file is received. */
  declareDocument(
    merchantId: string,
    applicationId: string,
    documentKey: string,
    expectedVersion: number,
    declaredReady: boolean,
  ): Promise<KycApplication>
  recordConsent(
    merchantId: string,
    applicationId: string,
    expectedVersion: number,
    consentTextVersion: string,
  ): Promise<KycApplication>
  /** Gives the application to OuPay for review. Repeating the same `submissionRequestId` returns the same result. */
  submit(
    merchantId: string,
    applicationId: string,
    expectedVersion: number,
    submissionRequestId: string,
  ): Promise<KycWriteResult>
  respondToInformationRequest(
    merchantId: string,
    applicationId: string,
    requestId: string,
    response: string,
  ): Promise<KycApplication>
  /** Shows one protected value to the owner. Recorded, and unavailable unless the server enables a secured workflow (`not_implemented`). */
  revealValue(
    merchantId: string,
    applicationId: string,
    fieldKey: string,
  ): Promise<KycRevealedValue>
}
