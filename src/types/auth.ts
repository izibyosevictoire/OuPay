/** PENDING: invited by email but has not set up an account yet; cannot sign in. */
export type UserStatus = 'ACTIVE' | 'SUSPENDED' | 'PENDING'

/**
 * A person with an OuPay login. Deliberately has NO role: roles belong to a
 * membership, because one user can hold different roles in different businesses.
 */
export interface User {
  id: string
  fullName: string
  email: string
  /** Normalised international format, e.g. +250788123456. */
  phoneNumber: string
  status: UserStatus
  /** Server-backed mode only: whether the e-mail address has been confirmed. Absent in demo mode. */
  emailVerified?: boolean
  createdAt: string
  updatedAt: string
}

export type BusinessRole = 'OWNER' | 'MANAGER' | 'CASHIER'
export type MembershipStatus = 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'REVOKED'

/** Links one user to one business with one role. A user may have many. */
export interface BusinessMembership {
  id: string
  userId: string
  merchantId: string
  role: BusinessRole
  status: MembershipStatus
  createdAt: string
  updatedAt: string
}

/**
 * What the frontend knows after signing in. Contains no credentials or tokens:
 * a real backend would keep the secure session in an HTTP-only cookie.
 */
export interface AuthSession {
  user: User
  /** Every membership, whatever its status, so the UI can explain suspended or revoked access. */
  memberships: BusinessMembership[]
  expiresAt: string
}

export interface LoginCredentials {
  email: string
  password: string
}

export interface RegisterInput {
  fullName: string
  email: string
  phoneNumber: string
  password: string
  /**
   * Set when registering from an invitation link. It proves the person received the
   * invitation, which is what lets them claim an email that was invited but has no account.
   */
  invitationToken?: string
}
