import type { BusinessMembership } from '@/types/auth'
import type {
  InvitationPreview,
  InviteStaffInput,
  InvitableRole,
  StaffInvitation,
  StaffMember,
} from '@/types/staff'
import type { BusinessRole } from '@/types/auth'

/**
 * Staff are existing Users plus BusinessMemberships; there is no separate cashier account.
 * Like the branch service, every method takes the merchant explicitly and a real backend
 * must authorise each call itself.
 */
export interface StaffService {
  listStaff(merchantId: string): Promise<StaffMember[]>
  /** Creates an INVITED membership (never ACTIVE). No email is sent by the mock. */
  inviteStaff(merchantId: string, input: InviteStaffInput): Promise<StaffInvitation>
  listInvitations(merchantId: string): Promise<StaffInvitation[]>
  /** Open to anyone holding the link; reveals only what an invitee needs. */
  getInvitationPreview(token: string): Promise<InvitationPreview>
  /** Activates the invitation for the signed-in user, whose email must match the invitation. */
  acceptInvitation(token: string): Promise<BusinessMembership>
  updateMembershipRole(
    merchantId: string,
    membershipId: string,
    role: BusinessRole,
  ): Promise<BusinessMembership>
  suspendMembership(merchantId: string, membershipId: string): Promise<BusinessMembership>
  reactivateMembership(merchantId: string, membershipId: string): Promise<BusinessMembership>
  /** Terminal: a revoked membership is never reactivated, a new invitation is required. */
  revokeMembership(merchantId: string, membershipId: string): Promise<BusinessMembership>
}

export type { InvitableRole }
