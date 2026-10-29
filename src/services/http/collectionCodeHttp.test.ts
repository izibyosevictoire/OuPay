import { CollectionCodeServiceError } from '@/services/collectionCodeService'
import { SAMPLE_MERCHANT_ID } from '@/services/mock/sampleMerchants'
import { createTestBackend } from '@/test/merchantTestDouble'
import { createHttpClient } from './httpClient'
import { createHttpCollectionCodeService } from './httpServices'

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
    const next = queue.shift() ?? { status: 204 }
    return new Response(JSON.stringify(next.body ?? {}), { status: next.status ?? 200 })
  }) as unknown as typeof fetch
  const http = createHttpClient({ baseUrl: '/api/v1', fetchImpl, readCookie: () => 'csrf-token' })
  return { codes: createHttpCollectionCodeService(http), calls }
}

const M = 'mrc-1'
const BASE = `/api/v1/merchants/${M}/collection-codes`
const CODE = 'cc-1'
const REQUEST_ID = '11111111-2222-4333-8444-555555555555'

/** The server omits null fields (Jackson non_null); this reproduces that on a JSON body. */
const omitNulls = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value, (_k, v) => (v === null ? undefined : v)))

describe('HTTP collection codes keep the contract with the backend', () => {
  it('reads the options from the collection-codes path and tolerates missing lists', async () => {
    const { codes, calls } = setup({ body: {} })
    await expect(codes.getOptions(M)).resolves.toEqual({
      destinations: [],
      branches: [],
      members: [],
    })
    expect(calls[0]).toMatchObject({ method: 'GET', url: `${BASE}/options` })
  })

  it('lists codes with the exact query parameters and drops the ones it was not given', async () => {
    const { codes, calls } = setup({ body: { items: [] } }, { body: { items: [] } })
    await codes.listCodes(M)
    expect(calls[0]?.url).toBe(BASE)
    await codes.listCodes(M, {
      limit: 20,
      cursor: 'abc',
      status: 'REQUEST_DECLARED',
      branchId: 'b1',
      q: ' till ',
    })
    const url = new URL(calls[1]!.url, 'http://x')
    expect(url.pathname).toBe(BASE)
    expect(Object.fromEntries(url.searchParams)).toEqual({
      limit: '20',
      cursor: 'abc',
      status: 'REQUEST_DECLARED',
      branchId: 'b1',
      q: 'till',
    })
    expect(calls[1]?.method).toBe('GET')
  })

  it('requests a code with the client request id in the body and the merchant only in the path', async () => {
    const { codes, calls } = setup({ status: 201, body: { code: { id: CODE }, replayed: false } })
    const result = await codes.requestCode(M, {
      clientOperationId: REQUEST_ID,
      settlementDestinationId: 'dst-1',
      displayLabel: 'Counter',
      branchId: 'b1',
    })
    expect(result.replayed).toBe(false)
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: BASE,
      body: {
        clientOperationId: REQUEST_ID,
        settlementDestinationId: 'dst-1',
        displayLabel: 'Counter',
        branchId: 'b1',
      },
    })
    expect(calls[0]?.headers['X-XSRF-TOKEN']).toBe('csrf-token')
    expect(JSON.stringify(calls[0]?.body)).not.toContain('merchantId')
  })

  it('treats a missing replayed flag as false', async () => {
    const { codes } = setup({ body: { code: { id: CODE } } })
    await expect(
      codes.requestCode(M, {
        clientOperationId: REQUEST_ID,
        settlementDestinationId: 'd',
        displayLabel: 'L',
      }),
    ).resolves.toMatchObject({ replayed: false })
  })

  it('reads one code and its assignment history', async () => {
    const { codes, calls } = setup({ body: { id: CODE } }, { body: { items: [] } })
    await codes.getCode(M, CODE)
    expect(calls[0]).toMatchObject({ method: 'GET', url: `${BASE}/${CODE}` })
    await codes.listAssignments(M, CODE, { limit: 5, cursor: 'c' })
    const url = new URL(calls[1]!.url, 'http://x')
    expect(url.pathname).toBe(`${BASE}/${CODE}/assignments`)
    expect(Object.fromEntries(url.searchParams)).toEqual({ limit: '5', cursor: 'c' })
  })

  it('posts each assignment operation to its own path with exactly the contract body', async () => {
    const { codes, calls } = setup(
      { status: 201, body: { id: 'a1' } },
      { body: { id: 'a1' } },
      { body: { id: 'a2' } },
    )
    await codes.assign(M, CODE, { membershipId: 'mem-1', branchId: 'b1' })
    await codes.endAssignment(M, CODE, { expectedAssignmentId: 'a1', reason: 'Left' })
    await codes.reassign(M, CODE, {
      expectedAssignmentId: 'a1',
      collectionPointLabel: 'Stall',
      reason: 'Moved',
    })
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['POST', `${BASE}/${CODE}/assignments`],
      ['POST', `${BASE}/${CODE}/assignments/end`],
      ['POST', `${BASE}/${CODE}/reassign`],
    ])
    expect(calls[0]?.body).toEqual({ membershipId: 'mem-1', branchId: 'b1' })
    expect(calls[1]?.body).toEqual({ expectedAssignmentId: 'a1', reason: 'Left' })
    expect(calls[2]?.body).toEqual({
      expectedAssignmentId: 'a1',
      collectionPointLabel: 'Stall',
      reason: 'Moved',
    })
  })

  it('posts the status changes with the expected version', async () => {
    const { codes, calls } = setup(
      { body: { id: CODE } },
      { body: { id: CODE } },
      { body: { id: CODE } },
    )
    await codes.declareSubmission(M, CODE, { expectedVersion: 0, bankRequestRef: 'EQ-1' })
    await codes.suspend(M, CODE, { expectedVersion: 1, reason: 'Check' })
    await codes.deactivate(M, CODE, { expectedVersion: 2, reason: 'Closed' })
    expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ['POST', `${BASE}/${CODE}/submission`, { expectedVersion: 0, bankRequestRef: 'EQ-1' }],
      ['POST', `${BASE}/${CODE}/suspend`, { expectedVersion: 1, reason: 'Check' }],
      ['POST', `${BASE}/${CODE}/deactivate`, { expectedVersion: 2, reason: 'Closed' }],
    ])
  })

  it('reads the caller’s own code from /mine', async () => {
    const { codes, calls } = setup({ body: {} })
    await expect(codes.getMyCode(M)).resolves.toEqual({ assignment: null, code: null })
    expect(calls[0]).toMatchObject({ method: 'GET', url: `${BASE}/mine` })
  })

  it('normalises the eligibility fields and the owner-only fields the server leaves out', async () => {
    const approvedForManager = {
      id: CODE,
      status: 'ACTIVE',
      externalCodeState: 'BANK_APPROVED',
      externalCode: 'X-1',
      // A manager gets neither the evidence reference nor the declared bank reference.
      approval: { source: 'OPERATOR', approvedAt: '2026-09-12T10:00:00+02:00' },
      bankProvisioned: true,
      payable: false,
      eligibilityIssues: ['ASSIGNEE_NOT_ACTIVE', 'BRANCH_INACTIVE'],
    }
    const { codes } = setup(
      { body: approvedForManager },
      { body: { id: CODE, status: 'REQUESTED' } },
    )
    const code = await codes.getCode(M, CODE)
    expect(code.approval).toEqual({
      source: 'OPERATOR',
      approvedAt: '2026-09-12T10:00:00+02:00',
      evidenceRef: null,
    })
    expect(code.bankRequestRef).toBeNull()
    expect(code.bankProvisioned).toBe(true)
    expect(code.payable).toBe(false)
    expect(code.eligibilityIssues).toEqual(['ASSIGNEE_NOT_ACTIVE', 'BRANCH_INACTIVE'])
    // A body that omits the list means "no reasons", never undefined.
    expect((await codes.getCode(M, CODE)).eligibilityIssues).toEqual([])
  })

  it('keeps the owner’s evidence and declared reference when the server sends them', async () => {
    const { codes } = setup({
      body: {
        id: CODE,
        status: 'REQUEST_DECLARED',
        bankRequestRef: 'EQ-1',
        approval: { source: 'BANK_EVENT', approvedAt: 'x', evidenceRef: 'EV-1' },
        eligibilityIssues: [],
      },
    })
    const code = await codes.getCode(M, CODE)
    expect(code.status).toBe('REQUEST_DECLARED')
    expect(code.bankRequestRef).toBe('EQ-1')
    expect(code.approval?.evidenceRef).toBe('EV-1')
  })

  it('has no call that approves a code, records a bank-issued code or marks anything approved', () => {
    const names = Object.keys(
      createHttpCollectionCodeService(createHttpClient({ baseUrl: '/api/v1' })),
    )
    expect(
      names.filter((n) => /approve|^activate|issued|markBank|setExternal|recordBank/i.test(n)),
    ).toEqual([])
  })

  it('maps the contract error codes and keeps unknown ones as unavailable', async () => {
    const reply = (code: string, status: number) => ({
      status,
      body: { code, message: `m-${code}`, fields: [] },
    })
    for (const [code, status] of [
      ['code_status_invalid', 409],
      ['assignee_not_eligible', 422],
      ['branch_not_eligible', 422],
      ['already_assigned', 409],
      ['assignment_changed', 409],
      ['no_open_assignment', 409],
      ['client_request_id_reuse', 409],
      ['settlement_account_unavailable', 409],
      ['version_conflict', 409],
      ['forbidden', 403],
      ['not_found', 404],
      ['validation', 422],
    ] as const) {
      const { codes } = setup(reply(code, status))
      await expect(codes.getCode(M, CODE)).rejects.toMatchObject({
        name: 'CollectionCodeServiceError',
        code,
        message: `m-${code}`,
      })
    }
    const { codes } = setup(reply('something_new', 500))
    await expect(codes.getCode(M, CODE)).rejects.toBeInstanceOf(CollectionCodeServiceError)
    await expect(setup(reply('something_new', 500)).codes.getCode(M, CODE)).rejects.toMatchObject({
      code: 'service_unavailable',
    })
  })
})

describe('the HTTP and mock services return the same shapes', () => {
  async function pair() {
    const backend = createTestBackend()
    backend.signInAs('owner')
    return backend.fastCollectionCodes
  }

  it('normalises a server body (null fields omitted) to exactly what the mock returns', async () => {
    const mock = await pair()
    const mockList = await mock.listCodes(SAMPLE_MERCHANT_ID)
    const { codes } = setup({ body: omitNulls(mockList) })
    await expect(codes.listCodes(SAMPLE_MERCHANT_ID)).resolves.toEqual(mockList)
  })

  it('does so for one code, its history, the options and a my-code answer', async () => {
    const mock = await pair()
    const code = await mock.getCode(SAMPLE_MERCHANT_ID, 'cc-sample-001')
    const history = await mock.listAssignments(SAMPLE_MERCHANT_ID, 'cc-sample-001')
    const options = await mock.getOptions(SAMPLE_MERCHANT_ID)
    const { codes } = setup(
      { body: omitNulls(code) },
      { body: omitNulls(history) },
      { body: omitNulls(options) },
    )
    await expect(codes.getCode(SAMPLE_MERCHANT_ID, 'cc-sample-001')).resolves.toEqual(code)
    await expect(codes.listAssignments(SAMPLE_MERCHANT_ID, 'cc-sample-001')).resolves.toEqual(
      history,
    )
    await expect(codes.getOptions(SAMPLE_MERCHANT_ID)).resolves.toEqual(options)

    const backend = createTestBackend()
    backend.signInAs('cashier')
    const mine = await backend.fastCollectionCodes.getMyCode(SAMPLE_MERCHANT_ID)
    expect(mine.code?.externalCode).toBe('DEMO-ILLUSTRATIVE-001')
    const parity = setup({ body: omitNulls(mine) })
    await expect(parity.codes.getMyCode(SAMPLE_MERCHANT_ID)).resolves.toEqual(mine)
  })

  it('treats a pending code as having no code value, never as an empty placeholder', async () => {
    const mock = await pair()
    const pending = await mock.getCode(SAMPLE_MERCHANT_ID, 'cc-sample-002')
    const { codes } = setup({ body: omitNulls(pending) })
    const parsed = await codes.getCode(SAMPLE_MERCHANT_ID, 'cc-sample-002')
    expect(parsed.externalCode).toBeNull()
    expect(parsed.externalCodeState).toBe('NOT_ISSUED')
    expect(parsed.payable).toBe(false)
    expect(parsed.approval).toBeNull()
  })
})
