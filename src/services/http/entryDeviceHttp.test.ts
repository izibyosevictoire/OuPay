import { EntryDeviceServiceError } from '@/services/entryDeviceService'
import { createHttpClient } from './httpClient'
import { createHttpEntryDeviceService, createHttpPublicEntryService } from './httpServices'

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
  return {
    devices: createHttpEntryDeviceService(http),
    publicEntry: createHttpPublicEntryService(http),
    calls,
  }
}

const M = 'mrc-1'
const D = 'dev-1'
const BASE = `/api/v1/merchants/${M}/entry-devices`
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUv'
const CLAIM = 'x'.repeat(43)

/** The server omits null fields (Jackson non_null); this reproduces that on a JSON body. */
const omitNulls = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value, (_k, v) => (v === null ? undefined : v)))

const device = {
  id: D,
  deviceType: 'STATIC_QR',
  displayName: 'Counter 1',
  entryPath: `/e/${TOKEN}`,
  branchId: 'b1',
  branchName: 'Remera',
  assignedCashierUserId: null,
  assignedCashierName: null,
  status: 'ACTIVE',
  statusReason: null,
  createdAt: '2026-11-03T08:00:00Z',
  updatedAt: '2026-11-03T08:00:00Z',
  version: 0,
  binding: null,
}

describe('HTTP payment-entry devices keep the contract with the backend', () => {
  it('reads options and tolerates missing lists', async () => {
    const { devices, calls } = setup({ body: {} })
    await expect(devices.getOptions(M)).resolves.toEqual({ branches: [], cashiers: [] })
    expect(calls[0]).toMatchObject({ method: 'GET', url: `${BASE}/options` })
  })

  it('normalises the fields the server omits when they are null', async () => {
    const { devices } = setup({ body: [omitNulls(device)] })
    const [listed] = await devices.listDevices(M)
    expect(listed).toMatchObject({
      entryPath: `/e/${TOKEN}`,
      assignedCashierUserId: null,
      assignedCashierName: null,
      statusReason: null,
      binding: null,
    })
  })

  it('lists with only the filters it was given', async () => {
    const { devices, calls } = setup({ body: [] }, { body: [] })
    await devices.listDevices(M)
    expect(calls[0]?.url).toBe(BASE)
    await devices.listDevices(M, { status: 'ACTIVE', branchId: 'b1' })
    expect(calls[1]?.url).toBe(`${BASE}?status=ACTIVE&branchId=b1`)
  })

  it('registers with a stable request id and reports a replay', async () => {
    const { devices, calls } = setup({
      status: 200,
      body: { device: omitNulls(device), replayed: true },
    })
    const input = {
      clientRequestId: '11111111-2222-4333-8444-555555555555',
      deviceType: 'STATIC_QR' as const,
      displayName: 'Counter 1',
      branchId: 'b1',
      assignedCashierUserId: null,
    }
    await expect(devices.registerDevice(M, input)).resolves.toMatchObject({ replayed: true })
    expect(calls[0]).toMatchObject({ method: 'POST', url: BASE, body: input })
  })

  it('sends each lifecycle and binding act to its own path, with the expected version', async () => {
    const { devices, calls } = setup(
      ...Array.from({ length: 7 }, () => ({ body: omitNulls(device) })),
    )
    await devices.assignDevice(M, D, {
      expectedVersion: 3,
      branchId: 'b1',
      assignedCashierUserId: 'u1',
      reason: 'Move',
      confirmActiveSession: false,
    })
    await devices.suspendDevice(M, D, { expectedVersion: 4, reason: 'Checking' })
    await devices.reactivateDevice(M, D, { expectedVersion: 5, reason: 'Back' })
    await devices.revokeDevice(M, D, { expectedVersion: 6, reason: 'Lost' })
    await devices.bindSale(M, D, { saleId: 's1', expectedVersion: 7 })
    await devices.unbindSale(M, D, { reason: 'Done', confirmActiveSession: true })
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST ${BASE}/${D}/assignment`,
      `POST ${BASE}/${D}/suspend`,
      `POST ${BASE}/${D}/reactivate`,
      `POST ${BASE}/${D}/revoke`,
      `POST ${BASE}/${D}/binding`,
      `POST ${BASE}/${D}/binding/end`,
    ])
    expect(calls[4]?.body).toEqual({ saleId: 's1', expectedVersion: 7 })
    expect(calls[5]?.body).toEqual({ reason: 'Done', confirmActiveSession: true })
    // A write carries the CSRF header; the secret of a customer never appears on a merchant call.
    expect(calls.every((c) => c.headers['X-XSRF-TOKEN'] === 'csrf-token')).toBe(true)
    expect(JSON.stringify(calls)).not.toContain('X-Entry-Claim')
  })

  it('maps the server codes onto the contract and hides unknown ones', async () => {
    const { devices } = setup(
      { status: 409, body: { code: 'customer_session_active', message: 'A customer is looking.' } },
      { status: 409, body: { code: 'something_new', message: 'x' } },
    )
    await expect(
      devices.unbindSale(M, D, { reason: 'x', confirmActiveSession: false }),
    ).rejects.toMatchObject({
      name: 'EntryDeviceServiceError',
      code: 'customer_session_active',
    })
    await expect(devices.getDevice(M, D)).rejects.toBeInstanceOf(EntryDeviceServiceError)
  })
})

describe('HTTP customer entry keeps the contract with the backend', () => {
  const entry = {
    state: 'READY',
    message: 'A bill is ready here.',
    merchantDisplayName: 'Sample Shop',
  }

  it('reads with a GET and puts the session secret in a header, never in the URL', async () => {
    const { publicEntry, calls } = setup({ body: entry }, { body: entry })
    await publicEntry.resolve(TOKEN)
    await publicEntry.resolve(TOKEN, CLAIM)
    expect(calls[0]).toMatchObject({ method: 'GET', url: `/api/v1/public/entry/${TOKEN}` })
    expect(calls[0]?.headers['X-Entry-Claim']).toBeUndefined()
    expect(calls[1]?.headers['X-Entry-Claim']).toBe(CLAIM)
    expect(calls.map((c) => c.url).join()).not.toContain(CLAIM)
  })

  it('takes and gives back the device with explicit POSTs', async () => {
    const claimed = {
      state: 'CLAIMED',
      message: 'This is your bill.',
      merchantDisplayName: 'Sample Shop',
      sale: {
        merchantDisplayName: 'Sample Shop',
        saleReference: 'OP-ABCDEFGH2345',
        amountRwf: 5000,
        currency: 'RWF',
        status: 'AWAITING_PAYMENT',
        confirmedAmount: 0,
        amountDue: 5000,
        expiresAt: '2026-11-03T09:00:00Z',
        code: { mode: 'LIVE', label: 'Counter', bankCode: 'EQ-1' },
        statusNote: 'Waiting for the bank.',
      },
      claim: { active: true, expiresAt: '2026-11-03T08:05:00Z', claimToken: CLAIM },
    }
    const { publicEntry, calls } = setup({ body: claimed }, { body: { ...entry, state: 'READY' } })
    const taken = await publicEntry.claim(TOKEN)
    expect(taken.state).toBe('CLAIMED')
    expect(taken.claim?.claimToken).toBe(CLAIM)
    // Omitted nulls are normalised: no description and no instructions still give a usable bill.
    expect(taken.sale).toMatchObject({ description: null, instructions: [] })
    expect(taken.sale?.code).toMatchObject({ bankCode: 'EQ-1', demoReference: null, notice: null })
    await publicEntry.release(TOKEN, CLAIM)
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST /api/v1/public/entry/${TOKEN}/claim`,
      `POST /api/v1/public/entry/${TOKEN}/release`,
    ])
    expect(calls[1]?.headers['X-Entry-Claim']).toBe(CLAIM)
  })

  it('treats every unusable token as the same UNAVAILABLE answer, without a sale or a claim', async () => {
    const { publicEntry } = setup({
      body: { state: 'UNAVAILABLE', message: 'This payment point is not available.' },
    })
    await expect(publicEntry.resolve('nope')).resolves.toEqual({
      state: 'UNAVAILABLE',
      message: 'This payment point is not available.',
      merchantDisplayName: null,
      sale: null,
      claim: null,
    })
  })
})
