/**
 * The OuPay DEMO EXPERIENCE (R9c): a separate build of this same app that runs entirely in the browser on the existing mock services,
 * pre-loaded with one fictional business ("Kigali Demo Supermarket").
 *
 * It is selected ONLY at build time (`vite build --mode demo`, see .env.demo) and only together with the mock services. A server-backed
 * build (`VITE_API_MODE=http`) can never be a demo experience, whatever else is set, so:
 *
 * - the demo build never constructs an HTTP client, and so can never send a request to the real API;
 * - the real build never contains the demo fixtures, banner or bank simulator;
 * - the two never share browser storage (the demo uses its own `oupay.demo.*` namespace).
 */
export const DEMO_EXPERIENCE: boolean =
  import.meta.env.VITE_DEMO_EXPERIENCE === 'true' && import.meta.env.VITE_API_MODE !== 'http'

/** The statement shown on every demo screen. */
export const DEMO_BANNER_TEXT = 'DEMO MODE — No real money moves'

/** Where the real application sends people who want to try the demo (an optional, separate deployment). Empty: no link is shown. */
export const DEMO_URL: string = (import.meta.env.VITE_DEMO_URL ?? '').trim()

/** Browser-storage namespace of the demo, kept apart from the ordinary mock (`oupay.mock.*`) so the two can never overwrite each other. */
export const MOCK_STORAGE_NAMESPACE = DEMO_EXPERIENCE ? 'oupay.demo' : 'oupay.mock'
