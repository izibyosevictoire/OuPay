import { CheckoutServiceError } from '@/services/checkoutService'
import { createHttpClient } from './httpClient'
import { createHttpCheckoutService } from './httpServices'

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
  return { checkout: createHttpCheckoutService(http), calls }
}

const M = 'mrc-1'
const input = {
  amountRwf: 25_000,
  description: 'Moto ride',
  branchId: 'brn-1',
  clientRequestId: '5f0c1b6e-0c55-4a3e-93c8-6a2d3b9e8f10',
  idempotencyKey: 'a-stable-retry-key-0001',
}

describe('HTTP simplified checkout keeps the contract with the backend', () => {
  it('reads the options from the checkout path', async () => {
    const { checkout, calls } = setup({ body: { readiness: 'READY', branches: [] } })
    await expect(checkout.getSimpleCheckoutOptions(M)).resolves.toMatchObject({
      readiness: 'READY',
    })
    expect(calls[0]).toMatchObject({
      method: 'GET',
      url: `/api/v1/merchants/${M}/checkout/simple/options`,
    })
  })

  it('bills with the retry key in the header, the sale identifier in the body, the CSRF token, and nothing the server decides', async () => {
    const { checkout, calls } = setup({ body: { invoiceId: 'inv-1' } })
    await checkout.billSimpleCheckout(M, input)
    const call = calls[0]!
    expect(call).toMatchObject({ method: 'POST', url: `/api/v1/merchants/${M}/checkout/simple` })
    expect(call.headers['Idempotency-Key']).toBe('a-stable-retry-key-0001')
    expect(call.headers['X-XSRF-TOKEN']).toBe('csrf-token')
    expect(call.headers['Content-Type']).toBe('application/json')
    // The amount is a JSON NUMBER of whole francs; the key is not repeated in the body.
    expect(call.body).toEqual({
      amountRwf: 25_000,
      description: 'Moto ride',
      branchId: 'brn-1',
      clientRequestId: '5f0c1b6e-0c55-4a3e-93c8-6a2d3b9e8f10',
    })
    const sent = Object.keys(call.body as object)
    for (const forbidden of [
      'saleChannel',
      'status',
      'taxRate',
      'expiresAt',
      'expiresInMinutes',
      'createdByUserId',
      'idempotencyKey',
    ]) {
      expect(sent).not.toContain(forbidden)
    }
  })

  it('omits the optional fields it was not given', async () => {
    const { checkout, calls } = setup({ body: {} })
    await checkout.billSimpleCheckout(M, {
      amountRwf: 500,
      clientRequestId: input.clientRequestId,
      idempotencyKey: input.idempotencyKey,
    })
    expect(calls[0]!.body).toEqual({ amountRwf: 500, clientRequestId: input.clientRequestId })
  })

  it('maps the backend error codes onto the contract, and anything unknown to service_unavailable', async () => {
    for (const code of [
      'checkout_not_available',
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
      await expect(checkout.billSimpleCheckout(M, input)).rejects.toMatchObject({
        name: 'CheckoutServiceError',
        code,
        message: `m-${code}`,
      })
    }
    const { checkout } = setup({ status: 409, body: { code: 'something_new', message: 'x' } })
    const error = await checkout.billSimpleCheckout(M, input).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CheckoutServiceError)
    expect((error as CheckoutServiceError).code).toBe('service_unavailable')
  })
})

describe('the HTTP client and extra headers', () => {
  it('sends caller headers but never lets them replace the CSRF token', async () => {
    const calls: Record<string, string>[] = []
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      calls.push((init?.headers ?? {}) as Record<string, string>)
      return new Response(null, { status: 204 })
    }) as typeof fetch
    const client = createHttpClient({
      baseUrl: '/api/v1',
      fetchImpl,
      readCookie: () => 'real-token',
    })
    await client.post('/x', {
      body: {},
      headers: { 'Idempotency-Key': 'k-12345678', 'X-XSRF-TOKEN': 'forged' },
    })
    expect(calls[0]!['Idempotency-Key']).toBe('k-12345678')
    expect(calls[0]!['X-XSRF-TOKEN']).toBe('real-token')
  })
})
