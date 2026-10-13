import type { StaffMember } from '@/types/staff'
import { getAvailableStaffActions } from '@/features/staff/staffActions'
import { canPerformStaffAction, getInvitableRoles, isRoleEscalation } from './staffPolicy'

describe('staff action policy', () => {
  it('lets owners do everything to anyone', () => {
    for (const action of [
      'invite',
      'change_role',
      'assign_branches',
      'suspend',
      'reactivate',
      'revoke',
    ] as const) {
      for (const target of ['OWNER', 'MANAGER', 'CASHIER'] as const) {
        expect(canPerformStaffAction('OWNER', action, target)).toBe(true)
      }
    }
  })

  it('limits managers to operational actions on cashiers, never roles', () => {
    for (const action of [
      'invite',
      'assign_branches',
      'suspend',
      'reactivate',
      'revoke',
    ] as const) {
      expect(canPerformStaffAction('MANAGER', action, 'CASHIER')).toBe(true)
      expect(canPerformStaffAction('MANAGER', action, 'MANAGER')).toBe(false)
      expect(canPerformStaffAction('MANAGER', action, 'OWNER')).toBe(false)
    }
    expect(canPerformStaffAction('MANAGER', 'change_role', 'CASHIER')).toBe(false)
  })

  it('gives cashiers and signed-out users nothing', () => {
    expect(canPerformStaffAction('CASHIER', 'assign_branches', 'CASHIER')).toBe(false)
    expect(canPerformStaffAction(null, 'invite', 'CASHIER')).toBe(false)
  })

  it('offers invitable roles by actor', () => {
    expect(getInvitableRoles('OWNER')).toEqual(['MANAGER', 'CASHIER'])
    expect(getInvitableRoles('MANAGER')).toEqual(['CASHIER'])
    expect(getInvitableRoles('CASHIER')).toEqual([])
  })

  it('ranks roles for escalation checks', () => {
    expect(isRoleEscalation('CASHIER', 'MANAGER')).toBe(true)
    expect(isRoleEscalation('MANAGER', 'OWNER')).toBe(true)
    expect(isRoleEscalation('OWNER', 'CASHIER')).toBe(false)
    expect(isRoleEscalation('MANAGER', 'MANAGER')).toBe(false)
  })
})

const member = (overrides: Partial<StaffMember>): StaffMember => ({
  merchantId: 'm',
  membershipId: 'mem',
  userId: 'u',
  fullName: 'Someone',
  email: 's@example.rw',
  phoneNumber: '',
  role: 'CASHIER',
  status: 'ACTIVE',
  branchIds: [],
  joinedAt: '2026-01-01T00:00:00Z',
  ...overrides,
})

describe('row actions follow the lifecycle', () => {
  it('offers the full set for an active cashier to an owner', () => {
    expect(getAvailableStaffActions('OWNER', member({}), false)).toEqual([
      'assign_branches',
      'change_role',
      'suspend',
      'revoke',
    ])
  })

  it('offers reactivate (not suspend) for suspended members, and no branch changes', () => {
    expect(getAvailableStaffActions('OWNER', member({ status: 'SUSPENDED' }), false)).toEqual([
      'change_role',
      'reactivate',
      'revoke',
    ])
  })

  it('offers only invitation actions for invited members', () => {
    const invited = member({
      status: 'INVITED',
      pendingInvitation: { id: 'i', demoToken: 't', createdAt: 'x' },
    })
    expect(getAvailableStaffActions('OWNER', invited, false)).toEqual(['open_invitation', 'revoke'])
  })

  it('offers only "invite again" for revoked members, and nothing for revoked owners', () => {
    expect(getAvailableStaffActions('OWNER', member({ status: 'REVOKED' }), false)).toEqual([
      'invite_again',
    ])
    expect(
      getAvailableStaffActions('OWNER', member({ status: 'REVOKED', role: 'OWNER' }), false),
    ).toEqual([])
  })

  it('hides role and lifecycle actions on your own row', () => {
    expect(getAvailableStaffActions('OWNER', member({ role: 'OWNER' }), true)).toEqual([
      'assign_branches',
    ])
  })

  it('shows managers only cashier operations', () => {
    expect(getAvailableStaffActions('MANAGER', member({}), false)).toEqual([
      'assign_branches',
      'suspend',
      'revoke',
    ])
    expect(getAvailableStaffActions('MANAGER', member({ role: 'MANAGER' }), false)).toEqual([])
    expect(getAvailableStaffActions('CASHIER', member({}), false)).toEqual([])
  })
})
