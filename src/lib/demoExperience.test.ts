import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.resetModules()
  window.localStorage.clear()
  window.sessionStorage.clear()
})

const configure = (env: Record<string, string>) => {
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
  vi.resetModules()
}

describe('which builds are the demo experience', () => {
  it('an ordinary build and the test suite are not the demo, and use the ordinary storage namespace and sample data', async () => {
    configure({})
    const demo = await import('./demoExperience')
    expect(demo.DEMO_EXPERIENCE).toBe(false)
    expect(demo.MOCK_STORAGE_NAMESPACE).toBe('oupay.mock')
    const { ACTIVE_SEEDS, SAMPLE_SEEDS } = await import('@/services/mock/seeds')
    expect(ACTIVE_SEEDS).toBe(SAMPLE_SEEDS)
  })

  it('the demo build is the demo: demo storage namespace and the Kigali examples', async () => {
    configure({ VITE_API_MODE: 'mock', VITE_DEMO_EXPERIENCE: 'true' })
    const demo = await import('./demoExperience')
    expect(demo.DEMO_EXPERIENCE).toBe(true)
    expect(demo.MOCK_STORAGE_NAMESPACE).toBe('oupay.demo')
    const { ACTIVE_SEEDS, KIGALI_SEEDS } = await import('@/services/mock/seeds')
    expect(ACTIVE_SEEDS).toBe(KIGALI_SEEDS)
    expect(demo.DEMO_BANNER_TEXT).toBe('DEMO MODE — No real money moves')
  })

  it('a server-backed build can NEVER be the demo, whatever else is set', async () => {
    configure({ VITE_API_MODE: 'http', VITE_DEMO_EXPERIENCE: 'true', VITE_ENABLE_DEMO_TOOLS: 'true' })
    const demo = await import('./demoExperience')
    expect(demo.DEMO_EXPERIENCE).toBe(false)
    expect(demo.MOCK_STORAGE_NAMESPACE).toBe('oupay.mock')
    const { ACTIVE_SEEDS, SAMPLE_SEEDS } = await import('@/services/mock/seeds')
    expect(ACTIVE_SEEDS).toBe(SAMPLE_SEEDS)
    const tools = await import('./demoTools')
    expect(tools.DEMO_TOOLS_BUILD).toBe(false)
  })
})

describe('the demo never talks to the real API, and the real build never reads or writes demo data', () => {
  it('the demo build performs a whole service start-up and a sign-in with no network request and no storage outside its own namespace', async () => {
    configure({ VITE_API_MODE: 'mock', VITE_DEMO_EXPERIENCE: 'true', VITE_ENABLE_DEMO_TOOLS: 'true' })
    const fetchSpy = vi.fn(async () => new Response(null, { status: 500 }))
    vi.stubGlobal('fetch', fetchSpy)
    const services = await import('@/services')
    expect(services.bankSimulator).not.toBeNull()
    // The demo has its own financial report, derived from the demo ledger (an ordinary mock build has none).
    expect(services.reportsService).not.toBeNull()
    await services.authService.login({ email: 'demo.owner@oupay.demo', password: 'DemoPass123!' }, { rememberMe: true })
    const merchants = await services.merchantService.listMerchantsForCurrentUser()
    expect(merchants.map((x) => x.tradingName)).toEqual(['Kigali Demo Supermarket'])
    const report = await services.reportsService!.getSummary(merchants[0]!.id, { from: '2000-01-01', to: '2099-12-31' })
    expect(report.issuedInvoiceCount).toBe(3)
    expect(fetchSpy).not.toHaveBeenCalled()
    const keys = [...Object.keys(window.localStorage), ...Object.keys(window.sessionStorage)]
    expect(keys.length).toBeGreaterThan(20)
    expect(keys.every((key) => key.startsWith('oupay.demo.'))).toBe(true)
  })

  it('the server-backed build keeps using the server: its report is the HTTP one, and it touches no browser storage at all', async () => {
    configure({ VITE_API_MODE: 'http', VITE_DEMO_EXPERIENCE: 'true' })
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ from: '2026-11-01', to: '2026-11-07', issuedInvoiceCount: 0, issuedTotalRwf: 0, activeAllocatedToIssuedInvoicesRwf: 0, outstandingForIssuedInvoicesRwf: 0, confirmedIncomingDuringPeriodRwf: 0, unappliedConfirmedDuringPeriodRwf: 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchSpy)
    const services = await import('@/services')
    expect(services.bankSimulator).toBeNull()
    expect(services.reportsService).not.toBeNull()
    await services.reportsService!.getSummary('real-merchant-id', { from: '2026-11-01', to: '2026-11-07' })
    // It went to the server, at the real API path, and the demo fixtures were never read or written.
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(String((fetchSpy.mock.calls[0] as unknown[])[0])).toMatch(/^\/api\/v1\/merchants\/real-merchant-id\/reports/)
    expect(window.localStorage.length).toBe(0)
    expect(window.sessionStorage.length).toBe(0)
  })

  it('an ordinary mock build still says reports need the server, and the demo namespace is never written', async () => {
    configure({ VITE_API_MODE: 'mock' })
    const services = await import('@/services')
    expect(services.reportsService).toBeNull()
    await services.authService.getCurrentSession()
    expect(Object.keys(window.localStorage).some((key) => key.startsWith('oupay.demo.'))).toBe(false)
  })
})
