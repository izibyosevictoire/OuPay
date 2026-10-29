import { InventoryServiceError } from '@/services/inventoryService'
import { SAMPLE_MERCHANT_ID } from '@/services/mock/sampleMerchants'
import { SAMPLE_BRANCH_IDS } from '@/services/mock/sampleOrganization'
import { createTestBackend } from '@/test/merchantTestDouble'
import { createHttpClient } from './httpClient'
import { createHttpInventoryService } from './httpServices'

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
  return { inventory: createHttpInventoryService(http), calls }
}

const M = 'mrc-1'
const BASE = `/api/v1/merchants/${M}/inventory`
const OP = '11111111-2222-4333-8444-555555555555'

/** The server omits null fields (Jackson non_null); this reproduces that on a JSON body. */
const omitNulls = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value, (_k, v) => (v === null ? undefined : v)))

describe('HTTP inventory keeps the contract with the backend', () => {
  it('reads the options from the inventory path', async () => {
    const { inventory, calls } = setup({ body: { branches: [] } })
    await expect(inventory.getOptions(M)).resolves.toEqual({ branches: [] })
    expect(calls[0]).toMatchObject({ method: 'GET', url: `${BASE}/options` })
  })

  it('lists balances with the exact query parameters and drops the ones it was not given', async () => {
    const { inventory, calls } = setup({ body: { items: [] } }, { body: { items: [] } })
    await inventory.listBalances(M)
    expect(calls[0]?.url).toBe(`${BASE}/balances`)
    await inventory.listBalances(M, {
      limit: 20,
      cursor: 'abc',
      branchId: 'b1',
      itemId: 'i1',
      q: ' rice ',
    })
    const url = new URL(calls[1]!.url, 'http://x')
    expect(url.pathname).toBe(`${BASE}/balances`)
    expect(Object.fromEntries(url.searchParams)).toEqual({
      limit: '20',
      cursor: 'abc',
      branchId: 'b1',
      itemId: 'i1',
      q: 'rice',
    })
    expect(calls[1]?.method).toBe('GET')
  })

  it('lists movements with the exact query parameters', async () => {
    const { inventory, calls } = setup({ body: { items: [] } })
    await inventory.listMovements(M, {
      limit: 5,
      cursor: 'c',
      branchId: 'b1',
      itemId: 'i1',
      type: 'ADJUST_OUT',
    })
    const url = new URL(calls[0]!.url, 'http://x')
    expect(url.pathname).toBe(`${BASE}/movements`)
    expect(Object.fromEntries(url.searchParams)).toEqual({
      limit: '5',
      cursor: 'c',
      branchId: 'b1',
      itemId: 'i1',
      type: 'ADJUST_OUT',
    })
  })

  it('posts each operation to its own path with the operation id and decimal text, and no merchant identity', async () => {
    const empty = { movement: { id: 'm' }, balance: { id: 'b' } }
    const { inventory, calls } = setup({ body: empty }, { body: empty }, { body: empty })
    await inventory.recordOpening(M, {
      clientOperationId: OP,
      branchId: 'b1',
      itemId: 'i1',
      amount: '500',
      unit: 'kg',
    })
    await inventory.receiveStock(M, {
      clientOperationId: OP,
      branchId: 'b1',
      itemId: 'i1',
      packageId: 'p1',
      packageCount: '1.5',
      reference: 'DN-1',
    })
    await inventory.adjustStock(M, {
      clientOperationId: OP,
      branchId: 'b1',
      itemId: 'i1',
      amount: '0.000001',
      unit: 'g',
      direction: 'OUT',
      reason: 'Spillage',
    })
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['POST', `${BASE}/opening`],
      ['POST', `${BASE}/receive`],
      ['POST', `${BASE}/adjust`],
    ])
    expect(calls[0]?.body).toEqual({
      clientOperationId: OP,
      branchId: 'b1',
      itemId: 'i1',
      amount: '500',
      unit: 'kg',
    })
    expect(calls[1]?.body).toEqual({
      clientOperationId: OP,
      branchId: 'b1',
      itemId: 'i1',
      packageId: 'p1',
      packageCount: '1.5',
      reference: 'DN-1',
    })
    expect(calls[2]?.body).toEqual({
      clientOperationId: OP,
      branchId: 'b1',
      itemId: 'i1',
      amount: '0.000001',
      unit: 'g',
      direction: 'OUT',
      reason: 'Spillage',
    })
    for (const call of calls) {
      expect(call.headers['X-XSRF-TOKEN']).toBe('csrf-token')
      expect(Object.keys(call.body as object)).not.toContain('merchantId')
      // Quantities are text, never JSON numbers.
      const quantity = call.body as { amount?: unknown; packageCount?: unknown }
      for (const value of [quantity.amount, quantity.packageCount]) {
        if (value !== undefined) expect(typeof value).toBe('string')
      }
    }
  })

  it('has no way to edit or delete stock', () => {
    const { inventory } = setup()
    expect(Object.keys(inventory).some((name) => /delete|remove|update|edit/i.test(name))).toBe(
      false,
    )
  })

  it('treats fields the server omits as null', async () => {
    const balance = {
      id: 'b',
      branchId: 'br',
      branchName: 'B',
      branchCode: 'B1',
      itemId: 'i',
      itemName: 'Rice',
      measurementDimension: 'MASS',
      stockUnit: 'g',
      quantityOnHand: '1',
      saleUnit: 'kg',
      quantityInSaleUnit: '0.001',
      updatedAt: 'x',
      version: 0,
    }
    const movement = {
      id: 'm',
      branchId: 'br',
      branchName: 'B',
      itemId: 'i',
      itemName: 'Rice',
      movementType: 'RECEIVE',
      quantityDelta: '1',
      balanceAfter: '1',
      stockUnit: 'g',
      operationId: OP,
      actorName: 'Me',
      createdAt: 'x',
    }
    const { inventory } = setup(
      { body: { items: [balance] } },
      { body: { items: [movement] } },
      { status: 201, body: { movement, balance } },
    )
    const balances = await inventory.listBalances(M)
    expect(balances.nextCursor).toBeNull()
    expect(balances.totalCount).toBeNull()
    expect(balances.items[0]).toMatchObject({ itemCode: null })
    const movements = await inventory.listMovements(M)
    expect(movements.items[0]).toMatchObject({ enteredAs: null, reason: null, reference: null })
    const result = await inventory.receiveStock(M, {
      clientOperationId: OP,
      branchId: 'br',
      itemId: 'i',
      amount: '1',
      unit: 'g',
    })
    expect(result.replayed).toBe(false)
    expect(result.movement.reason).toBeNull()
    expect(result.balance.itemCode).toBeNull()
  })

  it('returns exactly what the mock returns once the server omits nulls', async () => {
    const backend = createTestBackend()
    backend.signInAs('owner')
    const mock = backend.fastInventory
    const options = await mock.getOptions(SAMPLE_MERCHANT_ID)
    const balances = await mock.listBalances(SAMPLE_MERCHANT_ID, { limit: 3 })
    const movements = await mock.listMovements(SAMPLE_MERCHANT_ID, { limit: 4 })
    const received = await mock.receiveStock(SAMPLE_MERCHANT_ID, {
      clientOperationId: OP,
      branchId: SAMPLE_BRANCH_IDS.remera,
      itemId: 'cat-rice',
      amount: '2',
      unit: 'kg',
    })
    const replayed = await mock.receiveStock(SAMPLE_MERCHANT_ID, {
      clientOperationId: OP,
      branchId: SAMPLE_BRANCH_IDS.remera,
      itemId: 'cat-rice',
      amount: '2',
      unit: 'kg',
    })
    expect(replayed.replayed).toBe(true)
    const { inventory } = setup(
      { body: omitNulls(options) },
      { body: omitNulls(balances) },
      { body: omitNulls(movements) },
      { status: 201, body: omitNulls(received) },
      { status: 200, body: omitNulls(replayed) },
    )
    await expect(inventory.getOptions(M)).resolves.toEqual(options)
    await expect(inventory.listBalances(M, { limit: 3 })).resolves.toEqual(balances)
    await expect(inventory.listMovements(M, { limit: 4 })).resolves.toEqual(movements)
    const input = {
      clientOperationId: OP,
      branchId: 'b',
      itemId: 'i',
      amount: '2',
      unit: 'kg' as const,
    }
    await expect(inventory.receiveStock(M, input)).resolves.toEqual(received)
    await expect(inventory.receiveStock(M, input)).resolves.toEqual(replayed)
  })
})

describe('HTTP inventory error mapping', () => {
  const cases = [
    [422, 'validation'],
    [422, 'invalid_item'],
    [422, 'package_inactive'],
    [422, 'unsupported_unit'],
    [422, 'dimension_mismatch'],
    [422, 'invalid_quantity'],
    [422, 'invalid_count'],
    [422, 'precision_exceeded'],
    [422, 'quantity_out_of_range'],
    [422, 'invalid_package_conversion'],
    [409, 'insufficient_stock'],
    [409, 'opening_already_recorded'],
    [409, 'operation_id_reuse'],
    [409, 'branch_inactive'],
    [409, 'inventory_unavailable'],
    [404, 'not_found'],
    [403, 'forbidden'],
  ] as const

  it.each(cases)('keeps the server code %i %s', async (status, code) => {
    const { inventory } = setup({ status, body: { code, message: 'Friendly words.', fields: [] } })
    const failure = await inventory
      .receiveStock(M, {
        clientOperationId: OP,
        branchId: 'b',
        itemId: 'i',
        amount: '1',
        unit: 'g',
      })
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(InventoryServiceError)
    expect(failure).toMatchObject({ code, message: 'Friendly words.' })
  })

  it('turns a code the contract does not know into service_unavailable', async () => {
    const { inventory } = setup({ status: 500, body: { code: 'something_new', message: 'Oops.' } })
    await expect(inventory.getOptions(M)).rejects.toMatchObject({ code: 'service_unavailable' })
  })
})
