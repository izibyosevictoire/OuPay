/**
 * Demo tools (the bank simulator and "simulate payment" buttons) exist only in development
 * builds, or when explicitly enabled with VITE_ENABLE_DEMO_TOOLS=true. A normal production
 * build contains no way to create bank events from the browser: trusted event ingestion must
 * never be an ordinary frontend API.
 *
 * `DEMO_TOOLS_BUILD` is a build-time constant so the bundler removes the demo code entirely
 * from production builds. `isDemoToolsEnabled()` is the same check evaluated at call time.
 */
export const DEMO_TOOLS_BUILD: boolean =
  (import.meta.env.DEV || import.meta.env.VITE_ENABLE_DEMO_TOOLS === 'true') &&
  // Server-backed builds never ship demo tooling: real events reach the server only through its
  // authenticated provider boundary.
  import.meta.env.VITE_API_MODE !== 'http'

export const isDemoToolsEnabled = (): boolean =>
  (import.meta.env.DEV || import.meta.env.VITE_ENABLE_DEMO_TOOLS === 'true') &&
  import.meta.env.VITE_API_MODE !== 'http'
