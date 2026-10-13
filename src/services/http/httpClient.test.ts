import { createHttpClient, HttpApiError } from './httpClient'

interface Call {
  url: string
  init: RequestInit
}

function fakeFetch(responses: (() => Response)[]) {
  const calls: Call[] = []
  const impl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    const next = responses.shift()
    if (!next) throw new Error('unexpected request')
    return next()
  }) as unknown as typeof fetch
  return { impl, calls }
}

const json =
  (body: unknown, status = 200) =>
  () =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('HTTP client', () => {
  it('sends the session cookie with every request and asks for JSON', async () => {
    const { impl, calls } = fakeFetch([json({ ok: true })])
    const client = createHttpClient({
      baseUrl: '/api/v1',
      fetchImpl: impl,
      readCookie: () => undefined,
    })
    await client.get('/merchants')
    expect(calls[0]).toMatchObject({ url: '/api/v1/merchants' })
    expect(calls[0]!.init).toMatchObject({ method: 'GET', credentials: 'include' })
    expect((calls[0]!.init.headers as Record<string, string>).Accept).toBe('application/json')
    // Reads need no CSRF token.
    expect((calls[0]!.init.headers as Record<string, string>)['X-XSRF-TOKEN']).toBeUndefined()
  })

  it('echoes the CSRF cookie in a header on writes (double submit)', async () => {
    const { impl, calls } = fakeFetch([json({ id: 1 }, 201)])
    const client = createHttpClient({
      baseUrl: '/api/v1',
      fetchImpl: impl,
      readCookie: (name) => (name === 'XSRF-TOKEN' ? 'csrf-123' : undefined),
    })
    await client.post('/merchants/m1/branches', { body: { name: 'A' } })
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers['X-XSRF-TOKEN']).toBe('csrf-123')
    expect(headers['Content-Type']).toBe('application/json')
    expect(calls[0]!.init.body).toBe('{"name":"A"}')
  })

  it('fetches the CSRF cookie first when it is missing', async () => {
    const { impl, calls } = fakeFetch([
      () => new Response(null, { status: 204 }),
      json({ ok: true }),
    ])
    let cookie: string | undefined
    const wrapped = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const response = await impl(url, init)
      // The server sets the cookie on that first response.
      if (String(url).endsWith('/auth/session')) cookie = 'fresh-token'
      return response
    }) as unknown as typeof fetch
    const client = createHttpClient({
      baseUrl: '/api/v1',
      fetchImpl: wrapped,
      readCookie: () => cookie,
    })
    await client.post('/x', { body: {} })
    expect(calls.map((c) => c.url)).toEqual(['/api/v1/auth/session', '/api/v1/x'])
    expect((calls[1]!.init.headers as Record<string, string>)['X-XSRF-TOKEN']).toBe('fresh-token')
  })

  it('sends no CSRF token and starts no session bootstrap for the anonymous public API', async () => {
    const { impl, calls } = fakeFetch([() => new Response(null, { status: 204 })])
    const client = createHttpClient({
      baseUrl: '/api/v1',
      fetchImpl: impl,
      readCookie: () => undefined,
    })
    await client.post('/public/payment-profiles/Rk4mQ8vTz2Xn/requests/OP-X/claim')
    expect(calls.map((c) => c.url)).toEqual([
      '/api/v1/public/payment-profiles/Rk4mQ8vTz2Xn/requests/OP-X/claim',
    ])
    expect((calls[0]!.init.headers as Record<string, string>)['X-XSRF-TOKEN']).toBeUndefined()
  })

  it('treats 204 as no content and builds query strings without empty values', async () => {
    const { impl, calls } = fakeFetch([() => new Response(null, { status: 204 })])
    const client = createHttpClient({ baseUrl: '/api/v1', fetchImpl: impl, readCookie: () => 'c' })
    await expect(
      client.get('/auth/session', { query: { limit: 5, cursor: undefined, flag: false } }),
    ).resolves.toBeUndefined()
    expect(calls[0]!.url).toBe('/api/v1/auth/session?limit=5&flag=false')
  })

  it('turns server errors into HttpApiError with the stable code', async () => {
    const { impl } = fakeFetch([json({ code: 'duplicate_branch_code', message: 'Taken.' }, 409)])
    const client = createHttpClient({ baseUrl: '/api/v1', fetchImpl: impl, readCookie: () => 'c' })
    await expect(client.post('/x')).rejects.toMatchObject({
      name: 'HttpApiError',
      status: 409,
      code: 'duplicate_branch_code',
      message: 'Taken.',
    })
  })

  it('never shows raw server output: non-JSON failures become service_unavailable', async () => {
    const { impl } = fakeFetch([() => new Response('<html>stack trace</html>', { status: 500 })])
    const client = createHttpClient({ baseUrl: '/api/v1', fetchImpl: impl, readCookie: () => 'c' })
    const error = (await client.get('/x').catch((e) => e)) as HttpApiError
    expect(error).toBeInstanceOf(HttpApiError)
    expect(error.code).toBe('service_unavailable')
    expect(error.message).not.toContain('stack trace')
  })

  it('reports an unreachable server as service_unavailable', async () => {
    const impl = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch
    const client = createHttpClient({ baseUrl: '/api/v1', fetchImpl: impl, readCookie: () => 'c' })
    await expect(client.get('/x')).rejects.toMatchObject({ status: 0, code: 'service_unavailable' })
  })

  it('stores nothing in browser storage: the session is the server cookie only', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const { impl } = fakeFetch([
      json({ user: { id: 'u1' } }),
      () => new Response(null, { status: 204 }),
    ])
    const client = createHttpClient({ baseUrl: '/api/v1', fetchImpl: impl, readCookie: () => 'c' })
    await client.post('/auth/login', { body: { email: 'a@b.rw', password: 'x' } })
    await client.post('/auth/logout')
    expect(setItem).not.toHaveBeenCalled()
    expect(window.localStorage.length).toBe(0)
    expect(window.sessionStorage.length).toBe(0)
    setItem.mockRestore()
  })
})
