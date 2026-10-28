import { CodeCheckoutServiceError } from '@/services/codeCheckoutService'
import { createHttpClient } from './httpClient'
import { createHttpCodeCheckoutService, createHttpPublicCodeSaleService } from './httpServices'

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
    checkout: createHttpCodeCheckoutService(http),
    publicSales: createHttpPublicCodeSaleService(http),
    calls,
  }
}

const M = 'mrc-1'
const input = {
  amountRwf: 15_000,
  description: 'Two coffees',
  collectionCodeId: 'cc-1',
  clientRequestId: '5f0c1b6e-0c55-4a3e-93c8-6a2d3b9e8f10',
  idempotencyKey: 'a-stable-retry-key-0001',
}

describe('HTTP code checkout keeps the contract with the backend', () => {
  it('reads the options from the code-sale path and normalises omitted nulls', async () => {
    const { checkout, calls } = setup({
      body: {
        readiness: 'READY',
        codes: [{ id: 'cc-1', label: 'Counter', mode: 'DEMONSTRATION', paymentReady: true }],
        liveCollectionEnabled: false,
      },
    })
    const options = await checkout.getCodeCheckoutOptions(M)
    expect(calls[0]).toMatchObject({
      method: 'GET',
      url: `/api/v1/merchants/${M}/checkout/code-sale/options`,
    })
    expect(options.codes[0]).toMatchObject({ reason: null, branchName: null })
    expect(options.note).toBeNull()
  })

  it('bills with the retry key in the header, the sale identifier in the body, the CSRF token, and nothing the server decides', async () => {
    const { checkout, calls } = setup({
      body: {
        saleId: 's-1',
        code: { mode: 'DEMONSTRATION', label: 'Counter', demoReference: 'CC-1' },
      },
    })
    const sale = await checkout.billCodeSale(M, input)
    const call = calls[0]!
    expect(call).toMatchObject({ method: 'POST', url: `/api/v1/merchants/${M}/checkout/code-sale` })
    expect(call.headers['Idempotency-Key']).toBe('a-stable-retry-key-0001')
    expect(call.headers['X-XSRF-TOKEN']).toBe('csrf-token')
    // The amount is a JSON NUMBER of whole francs; the key is not repeated in the body.
    expect(call.body).toEqual({
      amountRwf: 15_000,
      description: 'Two coffees',
      collectionCodeId: 'cc-1',
      clientRequestId: '5f0c1b6e-0c55-4a3e-93c8-6a2d3b9e8f10',
    })
    for (const forbidden of [
      'bankCode',
      'externalCode',
      'status',
      'assignmentId',
      'agentUserId',
      'presentationMode',
      'saleChannel',
      'expiresAt',
      'idempotencyKey',
    ]) {
      expect(Object.keys(call.body as object)).not.toContain(forbidden)
    }
    // A demonstration carries no bank code, and an omitted one reads as null.
    expect(sale.code).toMatchObject({ bankCode: null, demoReference: 'CC-1', notice: null })
  })

  it('reads a sale again by its id', async () => {
    const { checkout, calls } = setup({
      body: { saleId: 's-1', code: { mode: 'LIVE', label: 'x', bankCode: 'EQ-1' } },
    })
    const sale = await checkout.getCodeSale(M, 's-1')
    expect(calls[0]).toMatchObject({
      method: 'GET',
      url: `/api/v1/merchants/${M}/checkout/code-sale/s-1`,
    })
    expect(sale.code.bankCode).toBe('EQ-1')
  })

  it('reads the customer page anonymously by the encoded sale reference', async () => {
    const { publicSales, calls } = setup({
      body: {
        saleReference: 'OP-ABC12345',
        status: 'AWAITING_PAYMENT',
        code: { mode: 'DEMONSTRATION', label: 'x' },
      },
    })
    const page = await publicSales.getPublicCodeSale('OP-ABC12345')
    expect(calls[0]).toMatchObject({ method: 'GET', url: '/api/v1/public/code-sales/OP-ABC12345' })
    expect(page).toMatchObject({ description: null, instructions: [] })
  })

  it('maps the backend error codes onto the contract, and anything unknown to service_unavailable', async () => {
    for (const code of [
      'no_assigned_code',
      'code_not_assigned',
      'code_required',
      'code_not_available',
      'live_collection_unavailable',
      'no_eligible_branch',
      'branch_required',
      'branch_not_eligible',
      'no_active_profile',
      'client_request_id_reuse',
      'idempotency_key_reuse',
      'request_in_progress',
      'validation',
      'not_found',
    ]) {
      const { checkout } = setup({ status: 409, body: { code, message: `m-${code}` } })
      await expect(checkout.billCodeSale(M, input)).rejects.toMatchObject({
        name: 'CodeCheckoutServiceError',
        code,
        message: `m-${code}`,
      })
    }
    const { checkout } = setup({ status: 409, body: { code: 'something_new', message: 'x' } })
    const error = await checkout.billCodeSale(M, input).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CodeCheckoutServiceError)
    expect((error as CodeCheckoutServiceError).code).toBe('service_unavailable')
  })
})
