import { canPerformStaffAction, isRoleEscalation } from '@/features/auth/permissions/staffPolicy'
import { OrganizationServiceError } from '@/services/organizationService'
import type { StaffService } from '@/services/staffService'
import type { BusinessMembership, MembershipStatus } from '@/types/auth'
import type { StaffInvitation, StaffMember } from '@/types/staff'
import { createMockAuthStore, type MockAuthStore } from './mockAuthStore'
import {
  loadStoredMerchants,
  resolveDefaultStorage,
  type MerchantStorage,
} from './mockMerchantService'
import { createOperationRunner, requireActor } from './mockOrganizationAccess'

interface MockStaffServiceOptions {
  authStore?: MockAuthStore
  /** Where the mock merchant records live; used only to show a business name on invitations. */
  merchantStorage?: MerchantStorage
  delayInMilliseconds?: number
}

const normalizeEmail = (email: string) => email.trim().toLowerCase()
const ROLE_ORDER = { OWNER: 0, MANAGER: 1, CASHIER: 2 } as const

/**
 * Allowed membership transitions. REVOKED is terminal: access is never restored
 * automatically, a new invitation (a new membership) is required.
 */
const TRANSITIONS: Record<MembershipStatus, MembershipStatus[]> = {
  INVITED: ['ACTIVE', 'REVOKED'],
  ACTIVE: ['SUSPENDED', 'REVOKED'],
  SUSPENDED: ['ACTIVE', 'REVOKED'],
  REVOKED: [],
}

export function createMockStaffService(options: MockStaffServiceOptions = {}): StaffService {
  const store = options.authStore ?? createMockAuthStore()
  const merchantStorage = options.merchantStorage ?? resolveDefaultStorage()
  const run = createOperationRunner(options.delayInMilliseconds ?? 400)

  const findMembership = (merchantId: string, membershipId: string): BusinessMembership => {
    const membership = store
      .loadMemberships()
      .find((candidate) => candidate.id === membershipId && candidate.merchantId === merchantId)
    if (!membership) {
      throw new OrganizationServiceError('not_found', 'This staff member could not be found.')
    }
    return membership
  }

  const saveMembership = (updated: BusinessMembership) =>
    store.saveMemberships(store.loadMemberships().map((m) => (m.id === updated.id ? updated : m)))

  const activeOwnerCount = (merchantId: string) =>
    store
      .loadMemberships()
      .filter((m) => m.merchantId === merchantId && m.role === 'OWNER' && m.status === 'ACTIVE')
      .length

  /** A business must always keep at least one active owner. */
  const assertNotLastActiveOwner = (target: BusinessMembership) => {
    if (
      target.role === 'OWNER' &&
      target.status === 'ACTIVE' &&
      activeOwnerCount(target.merchantId) <= 1
    ) {
      throw new OrganizationServiceError(
        'last_owner',
        'This is the last active owner. Promote another owner first.',
      )
    }
  }

  const assertTransition = (target: BusinessMembership, next: MembershipStatus) => {
    if (!TRANSITIONS[target.status].includes(next)) {
      throw new OrganizationServiceError(
        'invalid_transition',
        target.status === 'REVOKED'
          ? 'Revoked access cannot be restored. Send a new invitation instead.'
          : `A ${target.status.toLowerCase()} member cannot become ${next.toLowerCase()}.`,
      )
    }
  }

  const assertMayManage = (
    actor: BusinessMembership,
    action: Parameters<typeof canPerformStaffAction>[1],
    target: BusinessMembership,
  ) => {
    if (!canPerformStaffAction(actor.role, action, target.role)) {
      throw new OrganizationServiceError('forbidden', 'You do not have permission to do that.')
    }
  }

  const assertBranchesAreAssignable = (merchantId: string, branchIds: string[]) => {
    if (new Set(branchIds).size !== branchIds.length) {
      throw new OrganizationServiceError(
        'duplicate_assignment',
        'A branch was selected more than once.',
      )
    }
    const branches = store.loadBranches().filter((b) => b.merchantId === merchantId)
    for (const branchId of branchIds) {
      const branch = branches.find((candidate) => candidate.id === branchId)
      if (!branch)
        throw new OrganizationServiceError('not_found', 'A selected branch could not be found.')
      if (branch.status !== 'ACTIVE') {
        throw new OrganizationServiceError(
          'branch_inactive',
          `${branch.name} is inactive and cannot receive new assignments.`,
        )
      }
    }
  }

  const changeStatus = (
    merchantId: string,
    membershipId: string,
    next: MembershipStatus,
    action: 'suspend' | 'reactivate' | 'revoke',
  ) => {
    const { membership: actor } = requireActor(store, merchantId, 'cashiers:manage')
    const target = findMembership(merchantId, membershipId)
    assertMayManage(actor, action, target)
    if (action === 'suspend' && actor.id === target.id) {
      throw new OrganizationServiceError('forbidden', 'You cannot suspend your own membership.')
    }
    assertTransition(target, next)
    if (next === 'SUSPENDED' || next === 'REVOKED') assertNotLastActiveOwner(target)

    const now = new Date().toISOString()
    const updated: BusinessMembership = { ...target, status: next, updatedAt: now }
    saveMembership(updated)

    if (next === 'REVOKED') {
      // Revocation ends every branch assignment and any pending invitation.
      store.saveBranchAssignments(
        store
          .loadBranchAssignments()
          .map((a) =>
            a.membershipId === membershipId && a.status === 'ACTIVE'
              ? { ...a, status: 'ENDED', endedAt: now, updatedAt: now }
              : a,
          ),
      )
      store.saveInvitations(
        store
          .loadInvitations()
          .map((i) =>
            i.membershipId === membershipId && i.status === 'PENDING'
              ? { ...i, status: 'REVOKED', updatedAt: now }
              : i,
          ),
      )
    }
    return updated
  }

  return {
    listStaff: (merchantId) =>
      run(() => {
        requireActor(store, merchantId, 'cashiers:manage')
        const users = store.loadUsers()
        const assignments = store.loadBranchAssignments().filter((a) => a.status === 'ACTIVE')
        const invitations = store.loadInvitations().filter((i) => i.status === 'PENDING')

        return store
          .loadMemberships()
          .filter((membership) => membership.merchantId === merchantId)
          .flatMap<StaffMember>((membership) => {
            const user = users.find((candidate) => candidate.id === membership.userId)
            if (!user) return []
            const invitation =
              membership.status === 'INVITED'
                ? invitations.find((i) => i.membershipId === membership.id)
                : undefined
            return [
              {
                merchantId,
                membershipId: membership.id,
                userId: user.id,
                fullName: user.fullName,
                email: user.email,
                phoneNumber: user.phoneNumber,
                role: membership.role,
                status: membership.status,
                // Invited people are not assigned yet; show where they will start.
                branchIds: invitation
                  ? invitation.branchIds
                  : assignments
                      .filter((a) => a.membershipId === membership.id)
                      .map((a) => a.branchId),
                joinedAt: membership.createdAt,
                pendingInvitation: invitation && {
                  id: invitation.id,
                  demoToken: invitation.demoToken,
                  note: invitation.note,
                  createdAt: invitation.createdAt,
                },
              },
            ]
          })
          .sort(
            (a, b) =>
              ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.fullName.localeCompare(b.fullName),
          )
      }),

    inviteStaff: (merchantId, input) =>
      run(() => {
        const { user: inviter, membership: actor } = requireActor(
          store,
          merchantId,
          'cashiers:manage',
        )
        // Managers may only invite cashiers; inviting managers is a membership/role decision.
        if (!canPerformStaffAction(actor.role, 'invite', input.role)) {
          throw new OrganizationServiceError('forbidden', 'You cannot invite someone to this role.')
        }
        assertBranchesAreAssignable(merchantId, input.branchIds)

        const email = normalizeEmail(input.email)
        const users = store.loadUsers()
        const memberships = store.loadMemberships()
        let invitee = users.find((candidate) => normalizeEmail(candidate.email) === email)

        const alreadyInvolved = memberships.some(
          (m) => m.merchantId === merchantId && m.userId === invitee?.id && m.status !== 'REVOKED',
        )
        if (alreadyInvolved) {
          throw new OrganizationServiceError(
            'duplicate_invitation',
            'This person is already a member or has a pending invitation.',
          )
        }

        const now = new Date().toISOString()
        if (!invitee) {
          // New email: a PENDING user placeholder with no way to sign in until acceptance.
          invitee = {
            id: `usr-${crypto.randomUUID().slice(0, 8)}`,
            fullName: email,
            email,
            phoneNumber: '',
            status: 'PENDING',
            createdAt: now,
            updatedAt: now,
          }
          store.saveUsers([...users, invitee])
        }

        const membership: BusinessMembership = {
          id: `mem-${crypto.randomUUID().slice(0, 8)}`,
          userId: invitee.id,
          merchantId,
          role: input.role,
          status: 'INVITED',
          createdAt: now,
          updatedAt: now,
        }
        store.saveMemberships([...memberships, membership])

        const invitation: StaffInvitation = {
          id: `inv-staff-${crypto.randomUUID().slice(0, 8)}`,
          merchantId,
          email,
          role: input.role,
          branchIds: input.branchIds,
          note: input.note || undefined,
          membershipId: membership.id,
          invitedByUserId: inviter.id,
          status: 'PENDING',
          demoToken: `demo-invite-${crypto.randomUUID().slice(0, 8)}`,
          createdAt: now,
          updatedAt: now,
        }
        store.saveInvitations([...store.loadInvitations(), invitation])
        return invitation
      }),

    listInvitations: (merchantId) =>
      run(() => {
        requireActor(store, merchantId, 'cashiers:manage')
        return store.loadInvitations().filter((i) => i.merchantId === merchantId)
      }),

    getInvitationPreview: (token) =>
      run(() => {
        const invitation = store.loadInvitations().find((i) => i.demoToken === token)
        if (!invitation) {
          throw new OrganizationServiceError(
            'invalid_invitation',
            'This invitation link is not valid.',
          )
        }
        const merchant = loadStoredMerchants(merchantStorage).find(
          (m) => m.id === invitation.merchantId,
        )
        const existing = store
          .loadUsers()
          .find((user) => normalizeEmail(user.email) === invitation.email)
        return {
          email: invitation.email,
          role: invitation.role,
          businessName: merchant ? (merchant.tradingName ?? merchant.legalName) : 'a business',
          status: invitation.status,
          inviteeHasActiveAccount: existing?.status === 'ACTIVE',
        }
      }),

    acceptInvitation: (token) =>
      run(() => {
        const session = store.readSession()
        if (!session)
          throw new OrganizationServiceError('unauthenticated', 'Please sign in to continue.')
        const user = store.loadUsers().find((candidate) => candidate.id === session.userId)
        const invitation = store.loadInvitations().find((i) => i.demoToken === token)
        if (!invitation || invitation.status !== 'PENDING') {
          throw new OrganizationServiceError(
            'invalid_invitation',
            'This invitation is no longer valid. Ask for a new one.',
          )
        }
        // The signed-in account must be the one invited, which links the invitation to that User.
        if (!user || normalizeEmail(user.email) !== invitation.email) {
          throw new OrganizationServiceError(
            'invitation_email_mismatch',
            'This invitation was sent to a different email address.',
          )
        }
        const membership = findMembership(invitation.merchantId, invitation.membershipId)
        assertTransition(membership, 'ACTIVE')

        const now = new Date().toISOString()
        const activated: BusinessMembership = { ...membership, status: 'ACTIVE', updatedAt: now }
        saveMembership(activated)
        store.saveInvitations(
          store
            .loadInvitations()
            .map((i) =>
              i.id === invitation.id ? { ...i, status: 'ACCEPTED', updatedAt: now } : i,
            ),
        )

        // Create the planned assignments, skipping branches deactivated or removed meanwhile.
        const usable = store
          .loadBranches()
          .filter(
            (b) =>
              b.merchantId === invitation.merchantId &&
              b.status === 'ACTIVE' &&
              invitation.branchIds.includes(b.id),
          )
        store.saveBranchAssignments([
          ...store.loadBranchAssignments(),
          ...usable.map((branch) => ({
            id: `asg-${crypto.randomUUID().slice(0, 8)}`,
            merchantId: invitation.merchantId,
            membershipId: membership.id,
            branchId: branch.id,
            status: 'ACTIVE' as const,
            createdAt: now,
            updatedAt: now,
          })),
        ])
        return activated
      }),

    updateMembershipRole: (merchantId, membershipId, role) =>
      run(() => {
        const { membership: actor } = requireActor(store, merchantId)
        const target = findMembership(merchantId, membershipId)
        // Checked before permissions so an attempt to raise your own role is named as such.
        if (actor.id === target.id && isRoleEscalation(target.role, role)) {
          throw new OrganizationServiceError('self_escalation', 'You cannot raise your own role.')
        }
        assertMayManage(actor, 'change_role', target)
        if (target.status !== 'ACTIVE' && target.status !== 'SUSPENDED') {
          throw new OrganizationServiceError(
            'membership_not_active',
            'Only active or suspended members can change role.',
          )
        }
        if (role !== 'OWNER') assertNotLastActiveOwner(target)
        const updated: BusinessMembership = { ...target, role, updatedAt: new Date().toISOString() }
        saveMembership(updated)
        return updated
      }),

    suspendMembership: (merchantId, membershipId) =>
      run(() => changeStatus(merchantId, membershipId, 'SUSPENDED', 'suspend')),

    reactivateMembership: (merchantId, membershipId) =>
      run(() => changeStatus(merchantId, membershipId, 'ACTIVE', 'reactivate')),

    revokeMembership: (merchantId, membershipId) =>
      run(() => changeStatus(merchantId, membershipId, 'REVOKED', 'revoke')),
  }
}
