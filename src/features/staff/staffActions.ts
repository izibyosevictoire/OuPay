import { canPerformStaffAction } from '@/features/auth/permissions/staffPolicy'
import type { BusinessRole } from '@/types/auth'
import type { StaffMember } from '@/types/staff'

export type StaffRowAction =
  | 'assign_branches'
  | 'change_role'
  | 'suspend'
  | 'reactivate'
  | 'revoke'
  | 'open_invitation'
  | 'invite_again'

/**
 * Which actions to offer for a row. Combines the centralized permission policy (who may act
 * on whom) with the membership lifecycle (what each status allows). The mock service
 * enforces the same rules, and a real backend must too; this only decides what to show.
 */
export function getAvailableStaffActions(
  actorRole: BusinessRole | null,
  member: StaffMember,
  isSelf: boolean,
): StaffRowAction[] {
  const may = (action: Parameters<typeof canPerformStaffAction>[1]) =>
    canPerformStaffAction(actorRole, action, member.role)
  const { status } = member
  const actions: StaffRowAction[] = []

  if (status === 'ACTIVE' && may('assign_branches')) actions.push('assign_branches')
  // People do not manage their own role or lifecycle from this screen.
  if (!isSelf) {
    if ((status === 'ACTIVE' || status === 'SUSPENDED') && may('change_role'))
      actions.push('change_role')
    if (status === 'ACTIVE' && may('suspend')) actions.push('suspend')
    if (status === 'SUSPENDED' && may('reactivate')) actions.push('reactivate')
    if (status === 'INVITED' && member.pendingInvitation && may('revoke'))
      actions.push('open_invitation')
    if ((status === 'ACTIVE' || status === 'SUSPENDED' || status === 'INVITED') && may('revoke')) {
      actions.push('revoke')
    }
  }
  // A revoked membership is never restored; the way back is a fresh invitation.
  if (status === 'REVOKED' && member.role !== 'OWNER' && may('invite')) actions.push('invite_again')
  return actions
}
