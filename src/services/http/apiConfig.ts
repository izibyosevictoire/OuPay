/**
 * Which backend the app talks to.
 *
 * - `mock` (default): the in-browser mock services and browser storage. Demo mode. Nothing leaves
 *   the browser, and all data is fake.
 * - `http`: the real OuPay backend over HTTP. Server-backed mode. Sessions live in an HttpOnly
 *   cookie set by the server; the browser holds no token, and no mock data is read or written.
 *
 * The two modes never mix: a build runs in exactly one of them (VITE_API_MODE), and the demo
 * tooling (bank simulator, simulated payment buttons) exists only in `mock` mode.
 */
export type ApiMode = 'mock' | 'http'

export const API_MODE: ApiMode = import.meta.env.VITE_API_MODE === 'http' ? 'http' : 'mock'

/** Same-origin by default (`/api/v1`), so the session cookie needs no CORS. In dev Vite proxies /api. */
export const API_BASE_URL: string = (import.meta.env.VITE_API_BASE_URL || '/api/v1').replace(
  /\/+$/,
  '',
)
