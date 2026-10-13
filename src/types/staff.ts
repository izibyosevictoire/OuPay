import type { BusinessRole, MembershipStatus } from './auth'
import type { MerchantOwned } from './merchant'

/** Roles an invitation can grant. Owners are created by registering a business or promotion. */
export type InvitableRole = Extract<BusinessRole, 'MANAGER' | 'CASHIER'>

export type InvitationStatus = 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED'

/**
 * A pending offer to join a business. Creating one never creates an ACTIVE membership:
 * the membership is INVITED until the invitee accepts.
 */
export interface StaffInvitation extends MerchantOwned {
  id: string
  /** Normalised to lower case. */
  email: string
  role: InvitableRole
  /** Branches to assign on acceptance; validated as ACTIVE branches of this merchant when invited. */
  branchIds: string[]
  note?: string
  /** The INVITED membership this invitation will activate. */
  membershipId: string
  invitedByUserId: string
  status: InvitationStatus
  /**
   * MOCK ONLY. The real backend e-mails a single-use, expiring, unguessable link and never returns the
   * token to the inviter's browser, so this is absent in server-backed mode.
   */
  demoToken?: string
  /** Server-backed mode: when the link stops working. */
  expiresAt?: string
  createdAt: string
  updatedAt: string
}

export interface InviteStaffInput {
  email: string
  role: InvitableRole
  branchIds: string[]
  note?: string
}

/** One row of the staff list: a membership joined with its user and active branch assignments. */
export interface StaffMember extends MerchantOwned {
  membershipId: string
  userId: string
  fullName: string
  email: string
  phoneNumber: string
  role: BusinessRole
  status: MembershipStatus
  /** Active assignments (and, for INVITED rows, the branches the invitation will assign). */
  branchIds: string[]
  /** Membership creation date: when they joined, or were invited. */
  joinedAt: string
  /** Set while the membership is INVITED. */
  pendingInvitation?: Pick<StaffInvitation, 'id' | 'demoToken' | 'note' | 'createdAt'>
}

/** What an invitee may see before signing in or accepting. Deliberately minimal. */
export interface InvitationPreview {
  email: string
  role: InvitableRole
  businessName: string
  status: InvitationStatus
  /** Lets the page offer "sign in" for existing users and "create account" for new ones. */
  inviteeHasActiveAccount: boolean
}

export type { MembershipStatus }
