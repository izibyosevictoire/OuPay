import { describe, expect, it, vi } from 'vitest'
import { exampleIds, isExampleId, referencesExampleData } from '@/lib/exampleData'
import { createHttpBranchService, createHttpCatalogService, createHttpInventoryService, createHttpPosService, createHttpStaffService } from './httpServices'
import { createHttpClient, HttpApiError } from './httpClient'

/**
 * Example records (the built-in Kigali Demo Supermarket) can never be sent to the real backend: the HTTP client, the one door to it, refuses any
 * request that names one, before a request or even a CSRF fetch leaves the browser.
 */
const REAL_MERCHANT = '3b44d464-6e19-499c-bce9-f340be23ee8d'
const REAL_BRANCH = '0f1b6a7e-8c52-4d0b-9a63-6a2d4c9e1f10'

function clientWithSpy() {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
  const client = createHttpClient({ baseUrl: '/api/v1', fetchImpl: fetchImpl as unknown as typeof fetch, readCookie: () => 'csrf' })
  return { client, fetchImpl }
}

describe('what counts as an example identifier', () => {
  it('knows every example record’s id, and none of them could be a real (UUID) identifier', () => {
    const ids = exampleIds()
    expect(ids.size).toBeGreaterThan(100)
    for (const id of ['kd-mrc-001', 'kd-brn-001', 'kd-cat-rice', 'kd-posd-001', 'kd-dev-001', 'kd-btx-001', 'inv-kds-inv-2001', 'kd-cc-001', 'kd-usr-owner']) {
      expect(isExampleId(id), id).toBe(true)
    }
    // Only record identifiers: never an enum or a name that a real request legitimately carries.
    expect([...ids].filter((id) => !/^(kd-|inv-kds-)/.test(id))).toEqual([])
    for (const legitimate of ['EQUITY_MOCK', 'BUSINESS', 'CASHIER', 'RWF', 'STATIC_QR']) expect(isExampleId(legitimate), legitimate).toBe(false)
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    expect([...ids].filter((id) => uuid.test(id))).toEqual([])
  })

  it('matches an identifier exactly, so a person’s own text is never mistaken for an example', () => {
    expect(referencesExampleData('/merchants/kd-mrc-001/branches')).toBe(true)
    expect(referencesExampleData({ a: [{ b: { branchId: 'kd-brn-002' } }] })).toBe(true)
    expect(referencesExampleData({ note: 'sold to kd-brn-001 customers', name: 'KD-5', code: 'kd-' })).toBe(false)
    expect(referencesExampleData({ branchId: REAL_BRANCH })).toBe(false)
    expect(referencesExampleData(`/merchants/${REAL_MERCHANT}/branches`)).toBe(false)
    expect(referencesExampleData(null)).toBe(false)
    expect(referencesExampleData(42)).toBe(false)
  })
})

describe('the HTTP client refuses to send an example anywhere', () => {
  it.each([
    ['POST', (c: ReturnType<typeof clientWithSpy>['client']) => c.post('/merchants/kd-mrc-001/branches', { body: { name: 'X' } })],
    ['PUT', (c: ReturnType<typeof clientWithSpy>['client']) => c.put(`/merchants/${REAL_MERCHANT}/branches/kd-brn-001`, { body: { name: 'X' } })],
    ['DELETE', (c: ReturnType<typeof clientWithSpy>['client']) => c.delete(`/merchants/${REAL_MERCHANT}/catalog/items/kd-cat-rice`)],
    ['POST with the example only in the body', (c: ReturnType<typeof clientWithSpy>['client']) => c.post(`/merchants/${REAL_MERCHANT}/inventory/receive`, { body: { lines: [{ itemId: 'kd-cat-rice' }] } })],
    ['GET with the example only in the query', (c: ReturnType<typeof clientWithSpy>['client']) => c.get(`/merchants/${REAL_MERCHANT}/branches`, { query: { branchId: 'kd-brn-003' } })],
    ['GET of an example invoice', (c: ReturnType<typeof clientWithSpy>['client']) => c.get(`/merchants/${REAL_MERCHANT}/invoices/inv-kds-inv-2001`)],
  ])('%s', async (_name, call) => {
    const { client, fetchImpl } = clientWithSpy()
    await expect(call(client)).rejects.toMatchObject({ name: 'HttpApiError', code: 'example_data', status: 0 })
    await expect(call(client)).rejects.toBeInstanceOf(HttpApiError)
    // Nothing left the browser: not the request, and not even the CSRF pre-fetch.
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('refuses every single example identifier, in a path, a body and a query', async () => {
    const { client, fetchImpl } = clientWithSpy()
    for (const id of exampleIds()) {
      await expect(client.post(`/x/${id}`)).rejects.toMatchObject({ code: 'example_data' })
      await expect(client.put('/x', { body: { id } })).rejects.toMatchObject({ code: 'example_data' })
      await expect(client.get('/x', { query: { id } })).rejects.toMatchObject({ code: 'example_data' })
    }
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('still sends real requests normally, including a person’s own text that merely looks like an example', async () => {
    const { client, fetchImpl } = clientWithSpy()
    await client.post(`/merchants/${REAL_MERCHANT}/branches`, { body: { name: 'kd-brn-001 market', code: 'KD5', branchId: REAL_BRANCH } })
    await client.get(`/merchants/${REAL_MERCHANT}/branches`)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})

describe('the real service contracts can not carry an example either', () => {
  it('branches, catalog, inventory, staff and POS all refuse an example id before any request', async () => {
    const { client, fetchImpl } = clientWithSpy()
    const branch = createHttpBranchService(client)
    const catalog = createHttpCatalogService(client)
    const inventory = createHttpInventoryService(client)
    const staff = createHttpStaffService(client)
    const pos = createHttpPosService(client)

    await expect(branch.updateBranch(REAL_MERCHANT, 'kd-brn-001', { name: 'Mine', code: 'MINE', location: { province: 'Kigali City', district: 'Gasabo', sector: 'Remera', physicalAddress: 'KG 1' } })).rejects.toThrow(/read-only/)
    await expect(branch.changeBranchStatus(REAL_MERCHANT, 'kd-brn-002', 'INACTIVE')).rejects.toThrow(/read-only/)
    await expect(catalog.updateItem(REAL_MERCHANT, 'kd-cat-rice', { expectedVersion: 1, name: 'Rice', pricePerSaleUnitRwf: 1 })).rejects.toThrow(/read-only/)
    await expect(catalog.changeItemStatus(REAL_MERCHANT, 'kd-cat-oil', { expectedVersion: 1, active: false })).rejects.toThrow(/read-only/)
    await expect(inventory.receiveStock(REAL_MERCHANT, { clientOperationId: crypto.randomUUID(), branchId: 'kd-brn-001', itemId: 'kd-cat-rice', amount: '5', unit: 'kg' })).rejects.toThrow(/read-only/)
    await expect(staff.suspendMembership(REAL_MERCHANT, 'kd-mem-003')).rejects.toThrow(/read-only/)
    await expect(pos.discardPosDraft(REAL_MERCHANT, 'kd-posd-001', 0)).rejects.toThrow(/read-only/)
    await expect(pos.billPosDraft(REAL_MERCHANT, 'kd-posd-002', { expectedDraftVersion: 0, reviewedTotalRwf: 1, collectionCodeId: 'kd-cc-001', idempotencyKey: 'example-attempt-0001' })).rejects.toThrow(/read-only/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
