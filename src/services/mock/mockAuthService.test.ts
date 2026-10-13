import { AuthServiceError } from '@/services/authService'
import { createMockAuthService } from './mockAuthService'
import { createMemoryStorage, createMockAuthStore } from './mockAuthStore'
import {
  DEMO_EXPIRED_RESET_TOKEN,
  DEMO_OUTAGE_EMAIL,
  DEMO_PASSWORD,
  DEMO_USER_IDS,
  DEMO_VALID_RESET_TOKEN,
} from './sampleAccounts'

function createHarness() {
  const persistentStorage = createMemoryStorage()
  const sessionStorage = createMemoryStorage()
  const store = createMockAuthStore({ persistentStorage, sessionStorage })
  const service = createMockAuthService({ store, delayInMilliseconds: 0 })
  return { service, store, persistentStorage, sessionStorage }
}

/** Every string any storage currently holds, to prove secrets never land there. */
const dumpStorage = (...storages: ReturnType<typeof createMemoryStorage>[]) =>
  storages
    .map((storage) =>
      ['oupay.mock.users', 'oupay.mock.memberships', 'oupay.mock.demoSession']
        .map((key) => storage.getItem(key) ?? '')
        .join('\n'),
    )
    .join('\n')

describe('mock auth service: login', () => {
  it('signs in a demo account and returns user plus memberships, no token or password', async () => {
    const { service } = createHarness()
    const session = await service.login(
      { email: 'owner@oupay.demo', password: DEMO_PASSWORD },
      { rememberMe: false },
    )
    expect(session.user.email).toBe('owner@oupay.demo')
    expect(session.memberships.map((m) => m.role).sort()).toEqual(['CASHIER', 'OWNER'])
    expect(JSON.stringify(session)).not.toMatch(/password|token/i)
    expect(Object.keys(session.user)).not.toContain('role')
  })

  it('accepts emails case-insensitively', async () => {
    const { service } = createHarness()
    await expect(
      service.login(
        { email: ' MANAGER@oupay.demo ', password: DEMO_PASSWORD },
        { rememberMe: false },
      ),
    ).resolves.toBeTruthy()
  })

  it('gives the same error for a wrong password and an unknown email', async () => {
    const { service } = createHarness()
    const wrongPassword = service
      .login({ email: 'owner@oupay.demo', password: 'nope' }, { rememberMe: false })
      .catch((error: AuthServiceError) => error)
    const unknownEmail = service
      .login({ email: 'ghost@example.com', password: DEMO_PASSWORD }, { rememberMe: false })
      .catch((error: AuthServiceError) => error)
    const [first, second] = await Promise.all([wrongPassword, unknownEmail])
    expect(first).toBeInstanceOf(AuthServiceError)
    expect(first).toMatchObject({ code: 'invalid_credentials' })
    expect(second).toMatchObject({
      code: 'invalid_credentials',
      message: (first as AuthServiceError).message,
    })
  })

  it('simulates an outage for the reserved email', async () => {
    await expect(
      createHarness().service.login(
        { email: DEMO_OUTAGE_EMAIL, password: DEMO_PASSWORD },
        { rememberMe: false },
      ),
    ).rejects.toMatchObject({ code: 'service_unavailable' })
  })

  it('returns suspended and revoked memberships so the UI can explain them', async () => {
    const { service } = createHarness()
    const suspended = await service.login(
      { email: 'suspended@oupay.demo', password: DEMO_PASSWORD },
      { rememberMe: false },
    )
    expect(suspended.memberships.map((m) => m.status)).toEqual(['SUSPENDED'])
  })
})

describe('mock auth service: session persistence', () => {
  it('keeps a non-remembered session in sessionStorage only', async () => {
    const { service, persistentStorage, sessionStorage } = createHarness()
    await service.login(
      { email: 'owner@oupay.demo', password: DEMO_PASSWORD },
      { rememberMe: false },
    )
    expect(sessionStorage.getItem('oupay.mock.demoSession')).toContain(DEMO_USER_IDS.owner)
    expect(persistentStorage.getItem('oupay.mock.demoSession')).toBeNull()
  })

  it('keeps a remembered session in persistent storage only', async () => {
    const { service, persistentStorage, sessionStorage } = createHarness()
    await service.login(
      { email: 'owner@oupay.demo', password: DEMO_PASSWORD },
      { rememberMe: true },
    )
    expect(persistentStorage.getItem('oupay.mock.demoSession')).toContain(DEMO_USER_IDS.owner)
    expect(sessionStorage.getItem('oupay.mock.demoSession')).toBeNull()
  })

  it('stores only a user id and expiry for the session, and never a password', async () => {
    const { service, persistentStorage, sessionStorage } = createHarness()
    await service.login(
      { email: 'owner@oupay.demo', password: DEMO_PASSWORD },
      { rememberMe: true },
    )
    await service.register({
      fullName: 'New Person',
      email: 'new@example.rw',
      phoneNumber: '+250788111222',
      password: 'Unique-Secret-2026',
    })
    const everything = dumpStorage(persistentStorage, sessionStorage)
    expect(everything).not.toContain(DEMO_PASSWORD)
    expect(everything).not.toContain('Unique-Secret-2026')
    expect(JSON.parse(sessionStorage.getItem('oupay.mock.demoSession') ?? '{}')).toEqual({
      userId: expect.any(String),
      expiresAt: expect.any(String),
    })
  })

  it('restores a session, and reports none after logout', async () => {
    const { service } = createHarness()
    expect(await service.getCurrentSession()).toBeNull()
    await service.login(
      { email: 'cashier@oupay.demo', password: DEMO_PASSWORD },
      { rememberMe: true },
    )
    expect((await service.getCurrentSession())?.user.id).toBe(DEMO_USER_IDS.cashier)
    await service.logout()
    expect(await service.getCurrentSession()).toBeNull()
  })

  it('rejects an expired session once and then clears it', async () => {
    const { service, store } = createHarness()
    store.startSession(DEMO_USER_IDS.owner, false, -1000)
    await expect(service.getCurrentSession()).rejects.toMatchObject({ code: 'session_expired' })
    expect(await service.getCurrentSession()).toBeNull()
  })

  it('ignores a session for a user that no longer exists', async () => {
    const { service, store } = createHarness()
    store.startSession('usr-ghost', false, 60_000)
    expect(await service.getCurrentSession()).toBeNull()
  })
})

describe('mock auth service: registration', () => {
  const input = {
    fullName: 'Patrick Nshuti',
    email: 'Patrick@Example.rw',
    phoneNumber: '+250788111222',
    password: 'Sunrise2026',
  }

  it('creates a user with no memberships and signs them in', async () => {
    const { service } = createHarness()
    const session = await service.register(input)
    expect(session.user).toMatchObject({ email: 'patrick@example.rw', status: 'ACTIVE' })
    expect(session.memberships).toEqual([])
    expect((await service.getCurrentSession())?.user.id).toBe(session.user.id)
  })

  it('lets the new user sign in again within the same page session', async () => {
    const { service } = createHarness()
    await service.register(input)
    await service.logout()
    await expect(
      service.login(
        { email: 'patrick@example.rw', password: 'Sunrise2026' },
        { rememberMe: false },
      ),
    ).resolves.toBeTruthy()
  })

  it('rejects a duplicate email', async () => {
    const { service } = createHarness()
    await expect(service.register({ ...input, email: 'owner@oupay.demo' })).rejects.toMatchObject({
      code: 'email_taken',
    })
  })
})

describe('mock auth service: password reset', () => {
  it('answers a reset request identically for known and unknown emails', async () => {
    const { service } = createHarness()
    await expect(service.requestPasswordReset('owner@oupay.demo')).resolves.toBeUndefined()
    await expect(service.requestPasswordReset('nobody@example.com')).resolves.toBeUndefined()
  })

  it('classifies reset tokens as valid, expired or invalid', async () => {
    const { service } = createHarness()
    await expect(service.verifyPasswordResetToken(DEMO_VALID_RESET_TOKEN)).resolves.toBeUndefined()
    await expect(service.verifyPasswordResetToken(DEMO_EXPIRED_RESET_TOKEN)).rejects.toMatchObject({
      code: 'expired_token',
    })
    await expect(service.verifyPasswordResetToken('whatever')).rejects.toMatchObject({
      code: 'invalid_token',
    })
  })

  it('changes the demo password only for a valid token', async () => {
    const { service } = createHarness()
    await expect(
      service.resetPassword({ token: 'bad', newPassword: 'Another2026' }),
    ).rejects.toMatchObject({ code: 'invalid_token' })
    await service.resetPassword({ token: DEMO_VALID_RESET_TOKEN, newPassword: 'Another2026' })
    await expect(
      service.login({ email: 'owner@oupay.demo', password: DEMO_PASSWORD }, { rememberMe: false }),
    ).rejects.toMatchObject({ code: 'invalid_credentials' })
    await expect(
      service.login({ email: 'owner@oupay.demo', password: 'Another2026' }, { rememberMe: false }),
    ).resolves.toBeTruthy()
  })
})
