/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** `mock` (default, demo mode) or `http` (server-backed mode). See docs/backend.md. */
  readonly VITE_API_MODE?: 'mock' | 'http'
  /** Base URL of the API. Default `/api/v1` (same origin). */
  readonly VITE_API_BASE_URL?: string
  readonly VITE_ENABLE_DEMO_TOOLS?: string
  /** `true` only in the separate demo build (`vite build --mode demo`): mock services + the Kigali Demo Supermarket fixtures. */
  readonly VITE_DEMO_EXPERIENCE?: string
  /** Optional URL of the separate demo deployment; when set, the real sign-in page links to it. */
  readonly VITE_DEMO_URL?: string
  readonly VITE_PUBLIC_PAYMENT_BASE_URL?: string
}
