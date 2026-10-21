/**
 * A small fetch wrapper for the OuPay backend.
 *
 * - Authentication is the server's HttpOnly session cookie: `credentials: 'include'` sends it, and
 *   JavaScript can neither read nor store it. NOTHING sensitive goes in localStorage.
 * - CSRF: the server issues a readable `XSRF-TOKEN` cookie; every state-changing request echoes it in
 *   the `X-XSRF-TOKEN` header (double submit). If the cookie is missing, one cheap GET fetches it.
 * - Errors become `HttpApiError` carrying the server's stable `code`, which each service maps onto
 *   its own contract error type.
 */

export class HttpApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'HttpApiError'
    this.status = status
    this.code = code
  }
}

export interface HttpClientOptions {
  baseUrl: string
  fetchImpl?: typeof fetch
  /** Reads a cookie by name. Injectable so tests and non-browser callers can supply their own. */
  readCookie?: (name: string) => string | undefined
  /**
   * Called when a call to a business endpoint is answered 401: the server no longer recognises the session
   * (expired, signed out elsewhere, password changed). Sign-in and registration are excluded, because for
   * them a 401 just means wrong credentials.
   */
  onSessionLost?: () => void
}

export interface RequestOptions {
  body?: unknown
  /** Extra request headers, for example Idempotency-Key. Never used for credentials. */
  headers?: Record<string, string>
  query?: Record<string, string | number | boolean | undefined | null>
}

export interface HttpClient {
  get<T>(path: string, options?: RequestOptions): Promise<T>
  post<T>(path: string, options?: RequestOptions): Promise<T>
  put<T>(path: string, options?: RequestOptions): Promise<T>
  delete<T>(path: string, options?: RequestOptions): Promise<T>
}

const CSRF_COOKIE = 'XSRF-TOKEN'
const CSRF_HEADER = 'X-XSRF-TOKEN'

const browserCookie = (name: string): string | undefined => {
  if (typeof document === 'undefined') return undefined
  const match = document.cookie.split('; ').find((entry) => entry.startsWith(`${name}=`))
  return match ? decodeURIComponent(match.slice(name.length + 1)) : undefined
}

export function createHttpClient({
  baseUrl,
  fetchImpl,
  readCookie = browserCookie,
  onSessionLost,
}: HttpClientOptions): HttpClient {
  const doFetch: typeof fetch = (...args) => (fetchImpl ?? fetch)(...args)

  const buildUrl = (path: string, query?: RequestOptions['query']) => {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) params.set(key, String(value))
    }
    const suffix = params.toString()
    return `${baseUrl}${path}${suffix ? `?${suffix}` : ''}`
  }

  /** The CSRF cookie is set on any response; make sure we have it before a write. */
  async function ensureCsrfToken(): Promise<string | undefined> {
    const existing = readCookie(CSRF_COOKIE)
    if (existing) return existing
    try {
      await doFetch(`${baseUrl}/auth/session`, { credentials: 'include' })
    } catch {
      // The write itself will report the outage.
    }
    return readCookie(CSRF_COOKIE)
  }

  async function request<T>(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json', ...options.headers }
    if (options.body !== undefined) headers['Content-Type'] = 'application/json'
    // The anonymous public API uses no cookies at all, so it needs (and gets) no CSRF token.
    if (method !== 'GET' && !path.startsWith('/public/')) {
      const token = await ensureCsrfToken()
      if (token) headers[CSRF_HEADER] = token
    }

    let response: Response
    try {
      response = await doFetch(buildUrl(path, options.query), {
        method,
        headers,
        credentials: 'include',
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      })
    } catch {
      throw new HttpApiError(
        0,
        'service_unavailable',
        'The service is not reachable. Please try again.',
      )
    }

    if (response.status === 204) return undefined as T
    const text = await response.text()
    let payload: unknown = undefined
    if (text) {
      try {
        payload = JSON.parse(text)
      } catch {
        payload = undefined
      }
    }
    if (response.status === 401 && !path.startsWith('/auth/')) onSessionLost?.()
    if (!response.ok) {
      const error = (payload ?? {}) as { code?: string; message?: string }
      throw new HttpApiError(
        response.status,
        error.code ?? (response.status >= 500 ? 'service_unavailable' : 'unknown'),
        error.message ?? 'The request could not be completed.',
      )
    }
    return payload as T
  }

  return {
    get: (path, options) => request('GET', path, options),
    post: (path, options) => request('POST', path, options),
    put: (path, options) => request('PUT', path, options),
    delete: (path, options) => request('DELETE', path, options),
  }
}
