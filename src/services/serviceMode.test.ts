import { afterEach } from 'vitest'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('demo mode and server-backed mode stay separate', () => {
  it('defaults to demo mode: in-browser mock services', async () => {
    vi.resetModules()
    const config = await import('./http/apiConfig')
    expect(config.API_MODE).toBe('mock')
    const services = await import('./index')
    // The demo build keeps its simulator; the trusted processor is never exported.
    expect(services.bankSimulator).not.toBeNull()
    expect(Object.keys(services)).not.toContain('bankEventProcessor')
  })

  it('server mode talks HTTP only: no mock store, no mock data, no simulator, no demo tools', async () => {
    vi.stubEnv('VITE_API_MODE', 'http')
    vi.resetModules()
    window.localStorage.clear()
    window.sessionStorage.clear()
    const fetchSpy = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchSpy)

    const config = await import('./http/apiConfig')
    expect(config.API_MODE).toBe('http')
    const { DEMO_TOOLS_BUILD, isDemoToolsEnabled } = await import('@/lib/demoTools')
    expect(DEMO_TOOLS_BUILD).toBe(false)
    expect(isDemoToolsEnabled()).toBe(false)

    const services = await import('./index')
    expect(services.bankSimulator).toBeNull()
    // Building the services read and wrote no browser storage: there is no mock graph at all.
    expect(window.localStorage.length).toBe(0)
    expect(window.sessionStorage.length).toBe(0)

    // Calls go to the server, and "signed out" is a normal answer.
    expect(await services.authService.getCurrentSession()).toBeNull()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(String((fetchSpy.mock.calls[0] as unknown[])[0])).toBe('/api/v1/auth/session')
    vi.unstubAllGlobals()
  })

  it('honours a custom API base URL', async () => {
    vi.stubEnv('VITE_API_MODE', 'http')
    vi.stubEnv('VITE_API_BASE_URL', 'https://api.example.test/api/v1/')
    vi.resetModules()
    const config = await import('./http/apiConfig')
    expect(config.API_BASE_URL).toBe('https://api.example.test/api/v1')
  })
})
