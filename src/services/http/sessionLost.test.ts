import { createHttpClient } from './httpClient'

const clientAnswering = (status: number, onSessionLost: () => void) =>
  createHttpClient({
    baseUrl: '/api/v1',
    readCookie: () => 'csrf',
    onSessionLost,
    fetchImpl: (async () =>
      new Response(JSON.stringify({ code: 'unauthenticated', message: 'no' }), {
        status,
      })) as unknown as typeof fetch,
  })

describe('session loss detection', () => {
  it('reports a 401 from a business endpoint, so the app can return to sign-in', async () => {
    const lost = vi.fn()
    await expect(clientAnswering(401, lost).get('/merchants/m1/invoices')).rejects.toMatchObject({
      status: 401,
    })
    expect(lost).toHaveBeenCalledTimes(1)
  })

  it('does not treat wrong credentials on the auth endpoints as a lost session', async () => {
    const lost = vi.fn()
    await expect(clientAnswering(401, lost).post('/auth/login')).rejects.toMatchObject({
      status: 401,
    })
    expect(lost).not.toHaveBeenCalled()
  })

  it('ignores other failures', async () => {
    const lost = vi.fn()
    await expect(clientAnswering(403, lost).get('/merchants/m1/staff')).rejects.toBeDefined()
    await expect(clientAnswering(500, lost).get('/merchants/m1/staff')).rejects.toBeDefined()
    expect(lost).not.toHaveBeenCalled()
  })
})
