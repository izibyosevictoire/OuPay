import { KycServiceError } from '@/services/kycService'
import { createHttpClient } from './httpClient'
import { createHttpKycService } from './httpServices'

interface Call {
  method: string
  url: string
  headers: Record<string, string>
  body: unknown
}

function setup(...responses: { status?: number; body?: unknown }[]) {
  const calls: Call[] = []
  const queue = [...responses]
  const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      method: init?.method ?? 'GET',
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    })
    const next = queue.shift() ?? { status: 200, body: {} }
    return new Response(JSON.stringify(next.body ?? {}), { status: next.status ?? 200 })
  }) as unknown as typeof fetch
  const http = createHttpClient({ baseUrl: '/api/v1', fetchImpl, readCookie: () => 'csrf' })
  return { kyc: createHttpKycService(http), calls }
}

const M = 'mrc-1'
const A = 'app-1'
const BASE = `/api/v1/merchants/${M}/kyc`

describe('HTTP Equity activation keeps the contract with the backend', () => {
  it('reads options, the list and an application from the kyc paths', async () => {
    const { kyc, calls } = setup({ body: {} }, { body: [] }, { body: {} })
    await kyc.getOptions(M)
    await kyc.listApplications(M)
    await kyc.getApplication(M, A)
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${BASE}/options`,
      `GET ${BASE}/applications`,
      `GET ${BASE}/applications/${A}`,
    ])
  })

  it('writes with exactly the fields the backend accepts, and the CSRF token', async () => {
    const { kyc, calls } = setup()
    await kyc.startApplication(M, 'op-1')
    await kyc.saveAnswers(M, A, 3, { 'business.tin': '123456789' })
    await kyc.declareDocument(M, A, 'doc.representativeId', 4, true)
    await kyc.recordConsent(M, A, 5, 'v1')
    await kyc.submit(M, A, 6, 'sub-1')
    await kyc.respondToInformationRequest(M, A, 'req-1', 'Confirmed.')
    await kyc.revealValue(M, A, 'representative.idNumber')
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST ${BASE}/applications`,
      `PUT ${BASE}/applications/${A}/answers`,
      `PUT ${BASE}/applications/${A}/documents/doc.representativeId`,
      `POST ${BASE}/applications/${A}/consent`,
      `POST ${BASE}/applications/${A}/submit`,
      `POST ${BASE}/applications/${A}/information-requests/req-1/response`,
      `POST ${BASE}/applications/${A}/answers/representative.idNumber/reveal`,
    ])
    expect(calls.map((c) => c.body)).toEqual([
      { clientOperationId: 'op-1' },
      { expectedVersion: 3, answers: { 'business.tin': '123456789' } },
      { expectedVersion: 4, declaredReady: true },
      { expectedVersion: 5, consentTextVersion: 'v1', affirmed: true },
      { expectedVersion: 6, submissionRequestId: 'sub-1' },
      { response: 'Confirmed.' },
      undefined,
    ])
    expect(calls.every((c) => c.headers['X-XSRF-TOKEN'] === 'csrf')).toBe(true)
    // No request can carry a status or evidence.
    for (const body of calls.map((c) => JSON.stringify(c.body ?? {}))) {
      expect(body).not.toMatch(/status|evidence|handoff|decision/i)
    }
  })

  it('maps the backend error codes onto the contract, and anything unknown to service_unavailable', async () => {
    for (const code of [
      'application_exists',
      'application_incomplete',
      'consent_required',
      'sensitive_storage_unavailable',
      'version_conflict',
      'forbidden',
    ]) {
      const { kyc } = setup({ status: 409, body: { code, message: `m-${code}` } })
      await expect(kyc.submit(M, A, 1, 'x')).rejects.toMatchObject({
        name: 'KycServiceError',
        code,
        message: `m-${code}`,
      })
    }
    const { kyc } = setup({ status: 409, body: { code: 'something_new', message: 'x' } })
    const error = await kyc.getOptions(M).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(KycServiceError)
    expect((error as KycServiceError).code).toBe('service_unavailable')
  })
})
