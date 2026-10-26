import { CatalogServiceError } from '@/services/catalogService'
import { createTestBackend } from '@/test/merchantTestDouble'
import { SAMPLE_MERCHANT_ID } from '@/services/mock/sampleMerchants'
import { createHttpClient } from './httpClient'
import { createHttpCatalogService } from './httpServices'

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
  return { catalog: createHttpCatalogService(http), calls }
}

const M = 'mrc-1'
const BASE = `/api/v1/merchants/${M}/catalog`

/** The server omits null fields (Jackson non_null); this reproduces that on a JSON body. */
const omitNulls = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value, (_k, v) => (v === null ? undefined : v)))

describe('HTTP catalog keeps the contract with the backend', () => {
  it('reads the measurement units from the catalog path', async () => {
    const { catalog, calls } = setup({ body: [{ dimension: 'MASS', units: [] }] })
    await expect(catalog.listMeasurementUnits(M)).resolves.toEqual([
      { dimension: 'MASS', units: [] },
    ])
    expect(calls[0]).toMatchObject({ method: 'GET', url: `${BASE}/measurement-units` })
  })

  it('lists with the exact query parameters and drops the ones it was not given', async () => {
    const { catalog, calls } = setup({ body: { items: [] } }, { body: { items: [] } })
    await catalog.listItems(M)
    expect(calls[0]?.url).toBe(`${BASE}/items`)
    await catalog.listItems(M, {
      limit: 20,
      cursor: 'abc',
      q: ' rice ',
      type: 'GOODS',
      active: false,
    })
    const url = new URL(calls[1]!.url, 'http://x')
    expect(url.pathname).toBe(`${BASE}/items`)
    expect(Object.fromEntries(url.searchParams)).toEqual({
      limit: '20',
      cursor: 'abc',
      q: 'rice',
      type: 'GOODS',
      active: 'false',
    })
    expect(calls[1]?.method).toBe('GET')
  })

  it('creates with a POST whose body carries no merchant identity', async () => {
    const { catalog, calls } = setup({ body: { id: 'i1' } })
    await catalog.createItem(M, {
      itemType: 'GOODS',
      name: 'Rice',
      code: 'RICE',
      measurementDimension: 'MASS',
      saleUnit: 'kg',
      pricePerSaleUnitRwf: 1200,
      active: true,
    })
    const call = calls[0]!
    expect(call).toMatchObject({ method: 'POST', url: `${BASE}/items` })
    expect(call.headers['X-XSRF-TOKEN']).toBe('csrf-token')
    expect(call.body).toEqual({
      itemType: 'GOODS',
      name: 'Rice',
      code: 'RICE',
      measurementDimension: 'MASS',
      saleUnit: 'kg',
      pricePerSaleUnitRwf: 1200,
      active: true,
    })
    expect(Object.keys(call.body as object)).not.toContain('merchantId')
    // The price is a JSON NUMBER of whole francs.
    expect(typeof (call.body as { pricePerSaleUnitRwf: unknown }).pricePerSaleUnitRwf).toBe(
      'number',
    )
  })

  it('reads, updates and changes status on the item path with the version in the body', async () => {
    const { catalog, calls } = setup({ body: {} }, { body: {} }, { body: {} })
    await catalog.getItem(M, 'i1')
    await catalog.updateItem(M, 'i1', {
      expectedVersion: 3,
      name: 'Rice',
      saleUnit: 'kg',
      pricePerSaleUnitRwf: 1300,
      priceChangeReason: 'Harvest',
    })
    await catalog.changeItemStatus(M, 'i1', { expectedVersion: 4, active: false })
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['GET', `${BASE}/items/i1`],
      ['PUT', `${BASE}/items/i1`],
      ['PUT', `${BASE}/items/i1/status`],
    ])
    expect(calls[1]?.body).toEqual({
      expectedVersion: 3,
      name: 'Rice',
      saleUnit: 'kg',
      pricePerSaleUnitRwf: 1300,
      priceChangeReason: 'Harvest',
    })
    expect(calls[2]?.body).toEqual({ expectedVersion: 4, active: false })
  })

  it('reads the price history and defines packages with decimal text, never a number', async () => {
    const { catalog, calls } = setup({ body: [] }, { body: {} }, { body: {} })
    await catalog.listPriceHistory(M, 'i1')
    await catalog.createPackage(M, 'i1', {
      label: 'Bottle',
      contentsAmount: '0.75',
      contentsUnit: 'l',
    })
    await catalog.updatePackage(M, 'i1', 'p1', {
      expectedVersion: 0,
      label: 'Bottle',
      contentsAmount: '750',
      contentsUnit: 'ml',
      active: false,
    })
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['GET', `${BASE}/items/i1/price-history`],
      ['POST', `${BASE}/items/i1/packages`],
      ['PUT', `${BASE}/items/i1/packages/p1`],
    ])
    expect(calls[1]?.body).toEqual({ label: 'Bottle', contentsAmount: '0.75', contentsUnit: 'l' })
    expect(typeof (calls[2]?.body as { contentsAmount: unknown }).contentsAmount).toBe('string')
  })

  it('has no way to delete an item', () => {
    const { catalog } = setup()
    expect(Object.keys(catalog).some((name) => /delete|remove/i.test(name))).toBe(false)
  })

  it('treats fields the server omits as null', async () => {
    const { catalog } = setup(
      { body: { items: [{ id: 'i1', itemType: 'SERVICE', name: 'Haircut', active: true }] } },
      { body: [{ version: 1, pricePerSaleUnitRwf: 1, saleUnit: 'pc', effectiveAt: 'x' }] },
    )
    const page = await catalog.listItems(M)
    expect(page.nextCursor).toBeNull()
    expect(page.totalCount).toBeNull()
    expect(page.items[0]).toMatchObject({
      description: null,
      code: null,
      stockUnit: null,
      packages: [],
    })
    expect((await catalog.listPriceHistory(M, 'i1'))[0]?.reason).toBeNull()
  })

  it('returns exactly what the mock returns once the server omits nulls', async () => {
    const backend = createTestBackend()
    backend.signInAs('owner')
    const mock = backend.fastCatalog
    const list = await mock.listItems(SAMPLE_MERCHANT_ID, { limit: 3 })
    const history = await mock.listPriceHistory(SAMPLE_MERCHANT_ID, 'cat-rice')
    const created = await mock.createItem(SAMPLE_MERCHANT_ID, {
      itemType: 'SERVICE',
      name: 'Consulting',
      pricePerSaleUnitRwf: 10_000,
    })
    const { catalog } = setup(
      { body: omitNulls({ ...list, nextCursor: list.nextCursor }) },
      { body: omitNulls(history) },
      { body: omitNulls(created) },
    )
    await expect(catalog.listItems(M, { limit: 3 })).resolves.toEqual(list)
    await expect(catalog.listPriceHistory(M, 'cat-rice')).resolves.toEqual(history)
    await expect(
      catalog.createItem(M, { itemType: 'SERVICE', name: 'Consulting', pricePerSaleUnitRwf: 1 }),
    ).resolves.toEqual(created)
  })
})

describe('HTTP catalog error mapping', () => {
  const cases = [
    [422, 'validation'],
    [422, 'invalid_unit_configuration'],
    [422, 'unsupported_unit'],
    [422, 'dimension_mismatch'],
    [422, 'invalid_quantity'],
    [422, 'invalid_count'],
    [422, 'precision_exceeded'],
    [422, 'quantity_out_of_range'],
    [422, 'invalid_package_conversion'],
    [409, 'duplicate_code'],
    [409, 'duplicate_label'],
    [409, 'version_conflict'],
    [409, 'catalog_unavailable'],
    [404, 'not_found'],
    [403, 'forbidden'],
  ] as const

  it.each(cases)('keeps the server code %i %s', async (status, code) => {
    const { catalog } = setup({ status, body: { code, message: 'Friendly words.', fields: [] } })
    const failure = await catalog.getItem(M, 'i1').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(CatalogServiceError)
    expect(failure).toMatchObject({ code, message: 'Friendly words.' })
  })

  it('turns a code the contract does not know into service_unavailable', async () => {
    const { catalog } = setup({ status: 500, body: { code: 'something_new', message: 'Oops.' } })
    await expect(catalog.getItem(M, 'i1')).rejects.toMatchObject({ code: 'service_unavailable' })
  })
})
