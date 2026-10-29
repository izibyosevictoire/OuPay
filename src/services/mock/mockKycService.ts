import { DEMO_KYC_REQUIREMENT_SET } from '@/constants/kycRequirements'
import { applies, fieldProblem, maskedHint } from '@/features/equityActivation/kycRules'
import { hasPermission } from '@/features/auth/permissions/permissions'
import { KycServiceError, type KycService } from '@/services/kycService'
import { OrganizationServiceError } from '@/services/organizationService'
import type {
  KycAnswer,
  KycApplication,
  KycApplicationStatus,
  KycConsent,
  KycDocument,
  KycInformationRequest,
  KycReadiness,
} from '@/types/kyc'
import { createLedgerStore, newId } from './ledger/mockLedgerStore'
import type { MockAuthStore } from './mockAuthStore'
import {
  loadStoredMerchants,
  resolveDefaultStorage,
  type MerchantStorage,
} from './mockMerchantService'
import { createOperationRunner, requireActor, type Actor } from './mockOrganizationAccess'
import { MOCK_STORAGE_KEYS } from './mockStorageKeys'

interface MockKycServiceOptions {
  authStore: MockAuthStore
  merchantStorage?: MerchantStorage
  delayInMilliseconds?: number
}

interface StoredApplication {
  id: string
  merchantId: string
  clientOperationId: string
  status: KycApplicationStatus
  version: number
  createdAt: string
  updatedAt: string
  submittedAt: string | null
  submissionRequestId: string | null
  /** What a consent covers: the canonical answers at the time. */
  submittedAnswers: string | null
  answers: Record<
    string,
    {
      value: string | null
      hint: string | null
      sensitive: boolean
      source: 'PREFILL' | 'OWNER'
      /** A protected answer's stand-in for its ciphertext: new on every save, so consent covers THIS save. */
      nonce?: string
    }
  >
  documents: Record<
    string,
    { state: 'NOT_PROVIDED' | 'DECLARED_READY'; declaredReadyAt: string | null }
  >
  consents: (KycConsent & { answersKey: string })[]
}

const invalid = (message: string) => new KycServiceError('validation', message)

/**
 * DEMO ONLY: an in-browser stand-in for the server's Equity KYC onboarding. It makes the same decisions (owner only, prefill,
 * validation, consent bound to the exact answers, one live application, submission to OuPay only) and can NEVER reach HANDED_OFF,
 * MORE_INFO_REQUESTED, APPROVED or REJECTED: there is no bank and no evidence in the demo, so no fake approval exists.
 *
 * Protected values (an identity number, an account number) are NEVER kept, in storage or in memory: the demo remembers that a value was
 * given and its masked hint, nothing else, and showing a saved value in full is unavailable (as on the server unless a separately secured
 * workflow is enabled). Typing a value again replaces it.
 */
export function createMockKycService(options: MockKycServiceOptions): KycService {
  const { authStore: store } = options
  const merchantStorage = options.merchantStorage ?? resolveDefaultStorage()
  const run = createOperationRunner(options.delayInMilliseconds ?? 450)
  const set = DEMO_KYC_REQUIREMENT_SET.definition

  const all = () => store.loadRecords<StoredApplication>(MOCK_STORAGE_KEYS.kycApplications, [])
  const saveAll = (records: StoredApplication[]) =>
    store.saveRecords(MOCK_STORAGE_KEYS.kycApplications, records)

  const authorize = (merchantId: string): Actor => {
    let actor: Actor
    try {
      actor = requireActor(store, merchantId)
    } catch (error) {
      if (error instanceof OrganizationServiceError) {
        throw new KycServiceError(
          error.code === 'unauthenticated' ? 'unauthenticated' : 'not_found',
          error.message,
        )
      }
      throw error
    }
    if (!hasPermission(actor.membership.role, 'kyc:manage')) {
      throw new KycServiceError('forbidden', 'You do not have permission to do that.')
    }
    return actor
  }

  const find = (merchantId: string, applicationId: string): StoredApplication => {
    const found = all().find((a) => a.id === applicationId && a.merchantId === merchantId)
    if (!found) throw new KycServiceError('not_found', 'This application could not be found.')
    return found
  }

  const replace = (updated: StoredApplication) =>
    saveAll(all().map((a) => (a.id === updated.id ? updated : a)))

  const prefill = (merchantId: string): Record<string, string> => {
    const merchant = loadStoredMerchants(merchantStorage).find((m) => m.id === merchantId)
    if (!merchant) return {}
    const known: Record<string, string> = {}
    const put = (key: string, value: string | undefined) => {
      if (value && value.trim()) known[key] = value.trim()
    }
    put('business.legalName', merchant.legalName)
    put('business.type', merchant.businessType)
    put('business.registrationNumber', merchant.registration.registrationNumber)
    put('business.tin', merchant.registration.tin)
    put(
      'business.physicalAddress',
      [
        merchant.location.physicalAddress,
        merchant.location.sector,
        merchant.location.district,
        merchant.location.province,
      ]
        .filter(Boolean)
        .join(', '),
    )
    put('business.contactPhone', merchant.contact.phoneNumber)
    put('business.contactEmail', merchant.contact.email)
    put('representative.fullName', merchant.contact.fullName)
    return known
  }

  const plainValues = (app: StoredApplication): Record<string, string> => {
    const values: Record<string, string> = {}
    for (const [key, answer] of Object.entries(app.answers)) {
      const value = answer.sensitive ? `protected:${answer.nonce ?? ''}` : answer.value
      if (value) values[key] = value
    }
    return values
  }

  /** The exact content a consent covers: only fields that apply, in a canonical order. */
  const answersKey = (app: StoredApplication) => {
    const values = plainValues(app)
    return JSON.stringify(
      set.fields
        .filter((f) => values[f.key] !== undefined && applies(f.appliesWhen, values))
        .map((f) => [f.key, values[f.key]])
        .sort(([a], [b]) => String(a).localeCompare(String(b))),
    )
  }

  const missing = (app: StoredApplication) => {
    const values = plainValues(app)
    return set.fields
      .filter((f) => f.required && applies(f.appliesWhen, values) && !values[f.key])
      .map((f) => f.key)
  }

  const toDto = (app: StoredApplication): KycApplication => {
    const values = plainValues(app)
    const answers: KycAnswer[] = Object.entries(app.answers).map(([key, a]) => ({
      key,
      sensitive: a.sensitive,
      value: a.sensitive ? null : a.value,
      hasValue: true,
      hint: a.sensitive ? a.hint : null,
      source: a.source,
    }))
    const documents: KycDocument[] = set.documents.map((d) => {
      const saved = app.documents[d.key]
      return {
        key: d.key,
        label: d.label,
        required: d.required,
        applies: applies(d.appliesWhen, values),
        state: saved?.state ?? 'NOT_PROVIDED',
        declaredReadyAt: saved?.declaredReadyAt ?? null,
        uploadAvailable: false,
      }
    })
    const hash =
      app.status === 'DRAFT' ? answersKey(app) : (app.submittedAnswers ?? answersKey(app))
    const latest = [...app.consents].sort((a, b) => b.givenAt.localeCompare(a.givenAt))[0]
    const consent: KycConsent | null = latest
      ? {
          id: latest.id,
          givenAt: latest.givenAt,
          consentTextVersion: latest.consentTextVersion,
          requirementSetVersion: latest.requirementSetVersion,
          consentingName: latest.consentingName,
          current:
            latest.answersKey === hash && latest.consentTextVersion === set.consent.textVersion,
        }
      : null
    const missingFields = app.status === 'DRAFT' ? missing(app) : []
    const readiness: KycReadiness = {
      missingFields,
      consent: !consent ? 'NONE' : consent.current ? 'CURRENT' : 'OUTDATED',
      blockingDocuments: [],
      outstandingDocuments: documents
        .filter((d) => d.applies && d.required && d.state !== 'STORED')
        .map((d) => d.key),
      canSubmit: app.status === 'DRAFT' && missingFields.length === 0 && Boolean(consent?.current),
    }
    const informationRequests: KycInformationRequest[] = []
    return {
      id: app.id,
      providerId: 'EQUITY',
      status: app.status,
      requirementSetVersion: DEMO_KYC_REQUIREMENT_SET.version,
      version: app.version,
      createdAt: app.createdAt,
      updatedAt: app.updatedAt,
      submittedAt: app.submittedAt,
      handedOffAt: null,
      decidedAt: null,
      decisionReason: null,
      answers,
      documents,
      consent,
      informationRequests,
      readiness,
    }
  }

  const requireDraft = (app: StoredApplication, expectedVersion: number) => {
    if (app.status !== 'DRAFT') {
      throw new KycServiceError(
        'application_not_editable',
        'This application was already submitted to OuPay and can no longer be edited.',
      )
    }
    if (app.version !== expectedVersion) {
      throw new KycServiceError(
        'version_conflict',
        'This application was changed elsewhere. Reload it and try again.',
      )
    }
  }

  const touch = (app: StoredApplication): StoredApplication => ({
    ...app,
    version: app.version + 1,
    updatedAt: new Date().toISOString(),
  })

  return {
    getOptions: (merchantId) =>
      run(() => {
        authorize(merchantId)
        const live = all()
          .filter((a) => a.merchantId === merchantId && a.status !== 'REJECTED')
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
        const accounts = createLedgerStore(store).paymentDestinations.load()
        return {
          providerId: 'EQUITY',
          requirementSet: DEMO_KYC_REQUIREMENT_SET,
          prefill: prefill(merchantId),
          storage: {
            documentUploadAvailable: false,
            sensitiveStorageAvailable: true,
            revealAvailable: false,
            submissionToEquityAvailable: false,
            note: 'Demo mode. OuPay cannot receive documents yet: there is no secure storage. OuPay does not send applications to Equity yet either: submitting here only gives them to OuPay for review.',
          },
          linkedAccounts: accounts
            .filter((a) => a.merchantId === merchantId)
            .map((a) => ({
              label: a.label,
              maskedAccount: a.maskedAccount,
              providerId: a.providerId,
              simulated: a.isSimulated,
            })),
          current: live
            ? {
                id: live.id,
                status: live.status,
                requirementSetVersion: DEMO_KYC_REQUIREMENT_SET.version,
                createdAt: live.createdAt,
                submittedAt: live.submittedAt,
                decidedAt: null,
              }
            : null,
          retentionConfigured: false,
        }
      }),

    listApplications: (merchantId) =>
      run(() => {
        authorize(merchantId)
        return all()
          .filter((a) => a.merchantId === merchantId)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .map((a) => ({
            id: a.id,
            status: a.status,
            requirementSetVersion: DEMO_KYC_REQUIREMENT_SET.version,
            createdAt: a.createdAt,
            submittedAt: a.submittedAt,
            decidedAt: null,
          }))
      }),

    getApplication: (merchantId, applicationId) =>
      run(() => {
        authorize(merchantId)
        return toDto(find(merchantId, applicationId))
      }),

    startApplication: (merchantId, clientOperationId) =>
      run(() => {
        authorize(merchantId)
        if (!UUID.test(clientOperationId)) throw invalid('The request identifier is not valid.')
        const same = all().find(
          (a) => a.merchantId === merchantId && a.clientOperationId === clientOperationId,
        )
        if (same) return { application: toDto(same), replayed: true }
        if (all().some((a) => a.merchantId === merchantId && a.status !== 'REJECTED')) {
          throw new KycServiceError(
            'application_exists',
            'This business already has an Equity activation application.',
          )
        }
        const now = new Date().toISOString()
        const answers: StoredApplication['answers'] = {}
        for (const [key, value] of Object.entries(prefill(merchantId))) {
          const field = set.fields.find((f) => f.key === key)
          if (field && !field.sensitive && fieldProblem(field, value) === null) {
            answers[key] = { value, hint: null, sensitive: false, source: 'PREFILL' }
          }
        }
        const created: StoredApplication = {
          id: newId('kyc'),
          merchantId,
          clientOperationId,
          status: 'DRAFT',
          version: 0,
          createdAt: now,
          updatedAt: now,
          submittedAt: null,
          submissionRequestId: null,
          submittedAnswers: null,
          answers,
          documents: {},
          consents: [],
        }
        saveAll([...all(), created])
        return { application: toDto(created), replayed: false }
      }),

    saveAnswers: (merchantId, applicationId, expectedVersion, answers) =>
      run(() => {
        authorize(merchantId)
        const app = find(merchantId, applicationId)
        requireDraft(app, expectedVersion)
        // Validate everything first: a refused save changes nothing.
        for (const [key, raw] of Object.entries(answers)) {
          const field = set.fields.find((f) => f.key === key)
          if (!field) throw invalid('That is not a field of this application.')
          if (raw.trim() === '') continue
          const problem = fieldProblem(field, raw)
          if (problem) throw invalid(problem)
        }
        const next = { ...app, answers: { ...app.answers } }
        for (const [key, raw] of Object.entries(answers)) {
          const field = set.fields.find((f) => f.key === key)!
          const value = raw.trim()
          if (value === '') {
            delete next.answers[key]
          } else if (field.sensitive) {
            // Only a masked hint is kept: the demo never holds the value itself, not even in memory.
            next.answers[key] = {
              value: null,
              hint: maskedHint(value),
              sensitive: true,
              source: 'OWNER',
              nonce: crypto.randomUUID(),
            }
          } else {
            next.answers[key] = { value, hint: null, sensitive: false, source: 'OWNER' }
          }
        }
        const saved = touch(next)
        replace(saved)
        return toDto(saved)
      }),

    declareDocument: (merchantId, applicationId, documentKey, expectedVersion, declaredReady) =>
      run(() => {
        authorize(merchantId)
        const app = find(merchantId, applicationId)
        requireDraft(app, expectedVersion)
        if (!set.documents.some((d) => d.key === documentKey))
          throw invalid('That is not a document of this application.')
        const next = {
          ...app,
          documents: {
            ...app.documents,
            [documentKey]: declaredReady
              ? { state: 'DECLARED_READY' as const, declaredReadyAt: new Date().toISOString() }
              : { state: 'NOT_PROVIDED' as const, declaredReadyAt: null },
          },
        }
        const saved = touch(next)
        replace(saved)
        return toDto(saved)
      }),

    recordConsent: (merchantId, applicationId, expectedVersion, consentTextVersion) =>
      run(() => {
        const actor = authorize(merchantId)
        const app = find(merchantId, applicationId)
        requireDraft(app, expectedVersion)
        if (consentTextVersion !== set.consent.textVersion) {
          throw new KycServiceError(
            'consent_text_changed',
            'The consent wording changed. Read the current text and confirm it again.',
          )
        }
        if (missing(app).length > 0) {
          throw new KycServiceError(
            'application_incomplete',
            'Complete the required information before giving consent.',
          )
        }
        const key = answersKey(app)
        if (
          app.consents.some(
            (c) => c.answersKey === key && c.consentTextVersion === consentTextVersion,
          )
        )
          return toDto(app)
        const saved = touch({
          ...app,
          consents: [
            ...app.consents,
            {
              id: newId('kcn'),
              givenAt: new Date().toISOString(),
              consentTextVersion,
              requirementSetVersion: DEMO_KYC_REQUIREMENT_SET.version,
              consentingName: actor.user.fullName,
              current: true,
              answersKey: key,
            },
          ],
        })
        replace(saved)
        return toDto(saved)
      }),

    submit: (merchantId, applicationId, expectedVersion, submissionRequestId) =>
      run(() => {
        authorize(merchantId)
        const app = find(merchantId, applicationId)
        if (app.status !== 'DRAFT') {
          if (app.submissionRequestId === submissionRequestId)
            return { application: toDto(app), replayed: true }
          throw new KycServiceError(
            'invalid_transition',
            'This application was already submitted to OuPay.',
          )
        }
        requireDraft(app, expectedVersion)
        if (missing(app).length > 0) {
          throw new KycServiceError(
            'application_incomplete',
            'Complete the required information before submitting.',
          )
        }
        const key = answersKey(app)
        if (
          !app.consents.some(
            (c) => c.answersKey === key && c.consentTextVersion === set.consent.textVersion,
          )
        ) {
          throw new KycServiceError(
            'consent_required',
            'Give consent to the current information before submitting. Any change after consent needs consent again.',
          )
        }
        const saved = touch({
          ...app,
          status: 'COLLECTED',
          submittedAt: new Date().toISOString(),
          submissionRequestId,
          submittedAnswers: key,
        })
        replace(saved)
        return { application: toDto(saved), replayed: false }
      }),

    // The demo has no bank, so no request for information can ever exist.
    respondToInformationRequest: (merchantId, applicationId) =>
      run(() => {
        authorize(merchantId)
        find(merchantId, applicationId)
        throw new KycServiceError(
          'invalid_transition',
          'No information has been requested for this application.',
        )
      }),

    revealValue: (merchantId, applicationId) =>
      run(() => {
        authorize(merchantId)
        find(merchantId, applicationId)
        throw new KycServiceError(
          'not_implemented',
          'Showing a saved protected value is not available. You can replace a value by typing a new one.',
        )
      }),
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
