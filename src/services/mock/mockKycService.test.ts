import { KycServiceError } from '@/services/kycService'
import { createTestBackend, type DemoUserKey } from '@/test/merchantTestDouble'
import { SAMPLE_MERCHANT_ID, SAMPLE_SECOND_MERCHANT_ID } from './sampleMerchants'

const M = SAMPLE_MERCHANT_ID
const ID_NUMBER = '1199880012345678'

const REMAINING = {
  'representative.role': 'OWNER',
  'representative.idDocumentType': 'NATIONAL_ID',
  'bank.hasEquityAccount': 'NO',
}

function setup(user: DemoUserKey = 'owner') {
  const t = createTestBackend()
  t.signInAs(user)
  return t
}

const code = (promise: Promise<unknown>) =>
  promise.then(
    () => 'ok',
    (error: unknown) => (error instanceof KycServiceError ? error.code : String(error)),
  )

const opId = () => crypto.randomUUID()

async function started(t: ReturnType<typeof setup>) {
  return (await t.fastKyc.startApplication(M, opId())).application
}

async function consented(t: ReturnType<typeof setup>) {
  const application = await started(t)
  const saved = await t.fastKyc.saveAnswers(M, application.id, application.version, REMAINING)
  return t.fastKyc.recordConsent(M, saved.id, saved.version, 'v1')
}

describe('mock Equity KYC (the demo stand-in for the server)', () => {
  it('is the owner only: managers and cashiers are refused, and other businesses do not exist', async () => {
    const owner = setup('owner')
    const application = await started(owner)
    for (const person of ['manager', 'cashier'] as const) {
      const t = setup(person)
      expect(await code(t.fastKyc.getOptions(M))).toBe('forbidden')
      expect(await code(t.fastKyc.listApplications(M))).toBe('forbidden')
      expect(await code(t.fastKyc.startApplication(M, opId()))).toBe('forbidden')
      expect(await code(t.fastKyc.getApplication(M, application.id))).toBe('forbidden')
    }
    // A stranger to the business, and the owner of another business reaching in by another business's id.
    expect(await code(setup('newcomer').fastKyc.getApplication(M, application.id))).toBe(
      'not_found',
    )
    expect(
      await code(owner.fastKyc.getApplication(SAMPLE_SECOND_MERCHANT_ID, application.id)),
    ).toBe('forbidden')
    owner.store.endSession()
    expect(await code(owner.fastKyc.getOptions(M))).toBe('unauthenticated')
  })

  it('starts a prefilled draft, never invents what it does not know, and repeats a start safely', async () => {
    const t = setup()
    const operation = opId()
    const first = await t.fastKyc.startApplication(M, operation)
    expect(first.replayed).toBe(false)
    expect(first.application.status).toBe('DRAFT')
    const known = Object.fromEntries(first.application.answers.map((a) => [a.key, a.value]))
    expect(known['business.legalName']).toBeTruthy()
    expect(first.application.answers.every((a) => a.source === 'PREFILL')).toBe(true)
    expect(known).not.toHaveProperty('representative.role')
    expect(known).not.toHaveProperty('representative.idNumber')
    expect(first.application.readiness.missingFields).toEqual(
      expect.arrayContaining([
        'representative.role',
        'representative.idDocumentType',
        'bank.hasEquityAccount',
      ]),
    )
    const again = await t.fastKyc.startApplication(M, operation)
    expect(again.replayed).toBe(true)
    expect(again.application.id).toBe(first.application.id)
    expect(await code(t.fastKyc.startApplication(M, opId()))).toBe('application_exists')
  })

  it('validates a save as a whole and never repeats the refused value', async () => {
    const t = setup()
    const application = await started(t)
    const refused: Record<string, string>[] = [
      { 'business.contactEmail': 'nope' },
      { 'business.tin': '12' },
      { 'bank.hasEquityAccount': 'MAYBE' },
      { 'not.a.field': 'x' },
      { status: 'APPROVED' },
    ]
    for (const answers of refused) {
      expect(
        await code(t.fastKyc.saveAnswers(M, application.id, application.version, answers)),
      ).toBe('validation')
    }
    const batch = { 'representative.nationality': 'Kenyan', 'business.contactEmail': 'bad' }
    expect(await code(t.fastKyc.saveAnswers(M, application.id, application.version, batch))).toBe(
      'validation',
    )
    const unchanged = await t.fastKyc.getApplication(M, application.id)
    expect(unchanged.version).toBe(application.version)
    expect(JSON.stringify(unchanged.answers)).not.toContain('Kenyan')
    await expect(
      t.fastKyc.saveAnswers(M, application.id, 999, { 'representative.nationality': 'x' }),
    ).rejects.toMatchObject({
      code: 'version_conflict',
    })
  })

  it('keeps protected values out of every response and out of browser storage', async () => {
    const t = setup()
    const application = await started(t)
    const saved = await t.fastKyc.saveAnswers(M, application.id, application.version, {
      ...REMAINING,
      'representative.idNumber': ID_NUMBER,
    })
    const answer = saved.answers.find((a) => a.key === 'representative.idNumber')!
    expect(answer).toMatchObject({ sensitive: true, hasValue: true, value: null, hint: '••••5678' })
    expect(JSON.stringify(saved)).not.toContain(ID_NUMBER)
    expect(JSON.stringify(await t.fastKyc.getOptions(M))).not.toContain(ID_NUMBER)
    // Only memory holds it: the persisted demo store has the hint and nothing else.
    const persisted = JSON.stringify(t.store.loadRecords('oupay.mock.kycApplications', []))
    expect(persisted).not.toContain(ID_NUMBER)
    expect(persisted).toContain('••••5678')
    // Showing a saved value in full is unavailable, like the server's default, and the demo keeps no copy to show.
    expect(await code(t.fastKyc.revealValue(M, application.id, 'representative.idNumber'))).toBe(
      'not_implemented',
    )
    expect((await t.fastKyc.getOptions(M)).storage.revealAvailable).toBe(false)
  })

  it('binds consent to the exact answers and needs it again after any change', async () => {
    const t = setup()
    const application = await started(t)
    expect(await code(t.fastKyc.recordConsent(M, application.id, application.version, 'v1'))).toBe(
      'application_incomplete',
    )
    const filled = await t.fastKyc.saveAnswers(M, application.id, application.version, REMAINING)
    expect(await code(t.fastKyc.recordConsent(M, filled.id, filled.version, 'v0'))).toBe(
      'consent_text_changed',
    )
    const given = await t.fastKyc.recordConsent(M, filled.id, filled.version, 'v1')
    expect(given.consent).toMatchObject({ current: true, consentTextVersion: 'v1' })
    expect(given.readiness.canSubmit).toBe(true)
    const changed = await t.fastKyc.saveAnswers(M, given.id, given.version, {
      'representative.nationality': 'Rwandan',
    })
    expect(changed.consent?.current).toBe(false)
    expect(changed.readiness).toMatchObject({ consent: 'OUTDATED', canSubmit: false })
    expect(await code(t.fastKyc.submit(M, changed.id, changed.version, opId()))).toBe(
      'consent_required',
    )
  })

  it('submits to OuPay only: COLLECTED, never handed off, never decided', async () => {
    const t = setup()
    const ready = await consented(t)
    const submission = opId()
    const result = await t.fastKyc.submit(M, ready.id, ready.version, submission)
    expect(result.replayed).toBe(false)
    expect(result.application).toMatchObject({
      status: 'COLLECTED',
      handedOffAt: null,
      decidedAt: null,
      decisionReason: null,
    })
    expect(result.application.submittedAt).toBeTruthy()
    // A repeat is the same result; another submission and every edit are refused.
    expect((await t.fastKyc.submit(M, ready.id, ready.version, submission)).replayed).toBe(true)
    expect(await code(t.fastKyc.submit(M, ready.id, ready.version, opId()))).toBe(
      'invalid_transition',
    )
    expect(
      await code(
        t.fastKyc.saveAnswers(M, ready.id, result.application.version, {
          'representative.nationality': 'x',
        }),
      ),
    ).toBe('application_not_editable')
    expect(await code(t.fastKyc.respondToInformationRequest(M, ready.id, 'any', 'x'))).toBe(
      'invalid_transition',
    )
    // Nothing in the demo can ever produce a bank state.
    const everything = JSON.stringify(t.store.loadRecords('oupay.mock.kycApplications', []))
    for (const status of ['HANDED_OFF', 'MORE_INFO_REQUESTED', 'APPROVED', 'REJECTED']) {
      expect(everything).not.toContain(status)
    }
    expect((await t.fastKyc.listApplications(M))[0]?.status).toBe('COLLECTED')
  })

  it('tracks documents without ever receiving one', async () => {
    const t = setup()
    const application = await started(t)
    expect(
      application.documents.every((d) => d.uploadAvailable === false && d.state === 'NOT_PROVIDED'),
    ).toBe(true)
    const declared = await t.fastKyc.declareDocument(
      M,
      application.id,
      'doc.representativeId',
      application.version,
      true,
    )
    expect(declared.documents.find((d) => d.key === 'doc.representativeId')?.state).toBe(
      'DECLARED_READY',
    )
    expect(declared.documents.some((d) => d.state === 'STORED')).toBe(false)
    expect(
      await code(t.fastKyc.declareDocument(M, application.id, 'doc.nope', declared.version, true)),
    ).toBe('validation')
    expect(declared.readiness.outstandingDocuments).toContain('doc.representativeId')
  })
})
