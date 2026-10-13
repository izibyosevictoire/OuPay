import type { AuthSession, LoginCredentials, RegisterInput } from '@/types/auth'

export type AuthServiceErrorCode =
  | 'invalid_credentials'
  | 'account_unavailable'
  | 'email_taken'
  | 'session_expired'
  | 'invalid_token'
  | 'expired_token'
  | 'validation'
  | 'rate_limited'
  | 'invalid_invitation'
  | 'invitation_email_mismatch'
  | 'service_unavailable'

export class AuthServiceError extends Error {
  readonly code: AuthServiceErrorCode

  constructor(code: AuthServiceErrorCode, message: string) {
    super(message)
    this.name = 'AuthServiceError'
    this.code = code
  }
}

/**
 * Contract for authentication. The mock implements it for the demo; a real client would
 * talk to a backend that owns credentials, secure (HTTP-only cookie) sessions, password
 * resets, throttling and account protection. The frontend never sees a password again
 * after submitting it, and never holds a token.
 */
export interface AuthService {
  register(input: RegisterInput): Promise<AuthSession>
  login(credentials: LoginCredentials, options: { rememberMe: boolean }): Promise<AuthSession>
  logout(): Promise<void>
  /** Resolves null when signed out; rejects with `session_expired` when the session ran out. */
  getCurrentSession(): Promise<AuthSession | null>
  /** Always resolves, whether or not the account exists, so it cannot be used to probe accounts. */
  requestPasswordReset(email: string): Promise<void>
  /** Lets the reset page show an invalid or expired link before asking for a new password. */
  verifyPasswordResetToken(token: string): Promise<void>
  resetPassword(input: { token: string; newPassword: string }): Promise<void>
  /** Signed in: needs the current password; every OTHER device is signed out. */
  changePassword(input: { currentPassword: string; newPassword: string }): Promise<void>
  /** Signed in: sends a fresh verification link (rate limited; resolves quietly when already verified). */
  requestEmailVerification(): Promise<void>
  /** The link in the verification e-mail; works once, signed in or not. */
  confirmEmailVerification(token: string): Promise<void>
}
