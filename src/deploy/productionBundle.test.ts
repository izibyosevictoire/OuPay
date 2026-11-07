import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The REAL production bundle (server-backed, what Vercel builds) must contain no bank simulator and no mock payment or financial service code,
 * while shipping the built-in static examples. This builds it for real and checks it (scripts/check-production-bundle.mjs), and proves the check
 * can fail by pointing the same script at a mock-mode build.
 */
const root = path.resolve(import.meta.dirname, '../..')
const script = path.join(root, 'scripts/check-production-bundle.mjs')

const run = (mode: 'http' | 'mock') =>
  spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8', env: { ...process.env, VERIFY_BUNDLE_MODE: mode }, timeout: 170_000 })

describe('production bundle safety', () => {
  it('the server-backed bundle has no bank simulator or mock payment service, and does have the examples', { timeout: 180_000 }, () => {
    const result = run('http')
    expect(result.stdout + result.stderr).toContain('OK: the server-backed bundle contains no bank simulator')
    expect(result.status).toBe(0)
    // It really inspected a meaningful number of mock-only strings.
    expect(Number(/Checked (\d+) strings/.exec(result.stdout)?.[1])).toBeGreaterThanOrEqual(150)
  })

  it('negative control: a mock-mode build with the simulator FAILS the same check', { timeout: 180_000 }, () => {
    const result = run('mock')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('mock code is in the bundle')
    expect(result.stderr).toContain('simulateRequestPayment')
  })
})
