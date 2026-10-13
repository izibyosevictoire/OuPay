/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** `mock` (default, demo mode) or `http` (server-backed mode). See docs/backend.md. */
  readonly VITE_API_MODE?: 'mock' | 'http'
  /** Base URL of the API. Default `/api/v1` (same origin). */
  readonly VITE_API_BASE_URL?: string
  readonly VITE_ENABLE_DEMO_TOOLS?: string
  readonly VITE_PUBLIC_PAYMENT_BASE_URL?: string
}
