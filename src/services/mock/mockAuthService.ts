import { AuthServiceError, type AuthService } from '@/services/authService'
import type { AuthSession, User } from '@/types/auth'
import { createMockAuthStore, type MockAuthStore } from './mockAuthStore'
import {
  DEMO_EXPIRED_RESET_TOKEN,
  DEMO_OUTAGE_EMAIL,
  DEMO_PASSWORD,
  DEMO_USERS,
  DEMO_RESET_TARGET_EMAIL,
  DEMO_VALID_RESET_TOKEN,
} from './sampleAccounts'
import { simulateNetworkDelay } from './simulateNetwork'

const REMEMBERED_SESSION_LIFETIME = 30 * 24 * 60 * 60 * 1000
const TAB_SESSION_LIFETIME = 8 * 60 * 60 * 1000

interface MockAuthServiceOptions {
  store?: MockAuthStore
  delayInMilliseconds?: number
}

const normalizeEmail = (email: string) => email.trim().toLowerCase()

/**
 * MOCK ONLY: not a model of real authentication.
 * - Demo passwords live in this module's memory, never in browser storage.
 * - Accounts created through registration keep their password in memory only, so after a
 *   page reload they can still be restored from the demo session but cannot sign in again.
 * - The only thing persisted for a session is a non-secret marker (user id + expiry).
 * - No tokens are issued. A real backend would use secure, HTTP-only cookie sessions.
 */
export function createMockAuthService(options: MockAuthServiceOptions = {}): AuthService {
  const store = options.store ?? createMockAuthStore()
  const delay = options.delayInMilliseconds ?? 450

  const demoPasswordsByEmail = new Map<string, string>(
    // PENDING users (invited by email, never signed up) have no credential at all.
    DEMO_USERS.filter((user) => user.status === 'ACTIVE').map((user) => [
      normalizeEmail(user.email),
      DEMO_PASSWORD,
    ]),
  )

  const respond = <T>(value: T) => simulateNetworkDelay(value, delay)
  const reject = (code: ConstructorParameters<typeof AuthServiceError>[0], message: string) =>
    new Promise<never>((_, fail) =>
      setTimeout(() => fail(new AuthServiceError(code, message)), delay),
    )

  const buildSession = (user: User, expiresAt: string): AuthSession => ({
    user,
    memberships: store.loadMemberships().filter((membership) => membership.userId === user.id),
    expiresAt,
  })

  const checkResetToken = (token: string): AuthServiceError | null => {
    if (token === DEMO_VALID_RESET_TOKEN) return null
    if (token === DEMO_EXPIRED_RESET_TOKEN) {
      return new AuthServiceError('expired_token', 'This reset link has expired.')
    }
    return new AuthServiceError('invalid_token', 'This reset link is not valid.')
  }

  return {
    async register(input) {
      const email = normalizeEmail(input.email)
      const users = store.loadUsers()
      const existing = users.find((user) => normalizeEmail(user.email) === email)
      const now = new Date().toISOString()

      // An email that was only invited (PENDING user) can be claimed, but only by someone
      // holding that invitation's link. Anyone else is told the email is taken.
      const holdsInvitation =
        input.invitationToken !== undefined &&
        store
          .loadInvitations()
          .some(
            (invitation) =>
              invitation.demoToken === input.invitationToken &&
              invitation.status === 'PENDING' &&
              invitation.email === email,
          )
      if (existing?.status === 'PENDING' && holdsInvitation) {
        const claimed: User = {
          ...existing,
          fullName: input.fullName,
          phoneNumber: input.phoneNumber,
          status: 'ACTIVE',
          updatedAt: now,
        }
        store.saveUsers(users.map((user) => (user.id === existing.id ? claimed : user)))
        demoPasswordsByEmail.set(email, input.password)
        const started = store.startSession(claimed.id, false, TAB_SESSION_LIFETIME)
        return respond(buildSession(claimed, started.expiresAt))
      }
      if (existing) {
        return reject('email_taken', 'An account with this email address already exists.')
      }
      const user: User = {
        id: `usr-${crypto.randomUUID().slice(0, 8)}`,
        fullName: input.fullName,
        email,
        phoneNumber: input.phoneNumber,
        status: 'ACTIVE',
        createdAt: now,
        updatedAt: now,
      }
      store.saveUsers([...users, user])
      demoPasswordsByEmail.set(email, input.password)
      const started = store.startSession(user.id, false, TAB_SESSION_LIFETIME)
      return respond(buildSession(user, started.expiresAt))
    },

    async login(credentials, { rememberMe }) {
      const email = normalizeEmail(credentials.email)
      if (email === DEMO_OUTAGE_EMAIL) {
        return reject(
          'service_unavailable',
          'Sign-in is temporarily unavailable. Please try again.',
        )
      }
      const user = store.loadUsers().find((candidate) => normalizeEmail(candidate.email) === email)
      // Same error for unknown email and wrong password, so neither is revealed.
      if (!user || demoPasswordsByEmail.get(email) !== credentials.password) {
        return reject('invalid_credentials', 'Incorrect email or password.')
      }
      if (user.status !== 'ACTIVE') {
        return reject('account_unavailable', 'This account is not available. Contact support.')
      }
      const started = store.startSession(
        user.id,
        rememberMe,
        rememberMe ? REMEMBERED_SESSION_LIFETIME : TAB_SESSION_LIFETIME,
      )
      return respond(buildSession(user, started.expiresAt))
    },

    async logout() {
      store.endSession()
      return respond(undefined)
    },

    async getCurrentSession() {
      const stored = store.readSession()
      if (!stored) return respond(null)
      if (Date.parse(stored.expiresAt) <= Date.now()) {
        store.endSession()
        return reject('session_expired', 'Your session has expired. Please sign in again.')
      }
      const user = store.loadUsers().find((candidate) => candidate.id === stored.userId)
      if (!user || user.status !== 'ACTIVE') {
        store.endSession()
        return respond(null)
      }
      return respond(buildSession(user, stored.expiresAt))
    },

    async requestPasswordReset() {
      // Identical outcome for every address: nothing here reveals whether an account exists.
      return respond(undefined)
    },

    async verifyPasswordResetToken(token) {
      const problem = checkResetToken(token)
      if (problem) return reject(problem.code, problem.message)
      return respond(undefined)
    },

    async resetPassword({ token, newPassword }) {
      const problem = checkResetToken(token)
      if (problem) return reject(problem.code, problem.message)
      demoPasswordsByEmail.set(DEMO_RESET_TARGET_EMAIL, newPassword)
      return respond(undefined)
    },
  }
}
