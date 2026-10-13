import type { BusinessRole } from '@/types/auth'
import type { InvitableRole } from '@/types/staff'
import { hasPermission } from './permissions'

export type StaffAction =
  'invite' | 'change_role' | 'assign_branches' | 'suspend' | 'reactivate' | 'revoke'

/**
 * Who may do what to whom, derived only from the central permission table:
 * - `membership:manage` (owners): every action on every member. Role changes live here.
 * - `cashiers:manage` (managers): operational actions on CASHIER members only: invite
 *   cashiers, assign branches, suspend, reactivate and revoke. Never roles, and never
 *   other managers or owners.
 * - Everyone else: nothing.
 *
 * `targetRole` is the member's current role, or the role being invited for `invite`.
 * The UI uses this to hide actions; the mock services call the same function to refuse
 * them, and a real backend must enforce the equivalent rules on its own.
 */
export function canPerformStaffAction(
  actorRole: BusinessRole | null | undefined,
  action: StaffAction,
  targetRole: BusinessRole,
): boolean {
  if (hasPermission(actorRole, 'membership:manage')) return true
  if (hasPermission(actorRole, 'cashiers:manage')) {
    return action !== 'change_role' && targetRole === 'CASHIER'
  }
  return false
}

/** Roles the actor may offer in an invitation. */
export function getInvitableRoles(actorRole: BusinessRole | null | undefined): InvitableRole[] {
  return (['MANAGER', 'CASHIER'] as const).filter((role) =>
    canPerformStaffAction(actorRole, 'invite', role),
  )
}

const ROLE_RANK: Record<BusinessRole, number> = { CASHIER: 0, MANAGER: 1, OWNER: 2 }

/** True when moving from one role to another gives more authority. */
export const isRoleEscalation = (from: BusinessRole, to: BusinessRole) =>
  ROLE_RANK[to] > ROLE_RANK[from]
