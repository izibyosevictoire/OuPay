import '@testing-library/jest-dom/vitest'
import { cleanup, configure } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

// Under a parallel full-suite run, route transitions and mock latency can exceed the 1s default.
configure({ asyncUtilTimeout: 5000 })

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  window.localStorage.clear()
  window.sessionStorage.clear()
})
