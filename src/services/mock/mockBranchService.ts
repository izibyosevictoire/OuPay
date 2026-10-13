import { canPerformStaffAction } from '@/features/auth/permissions/staffPolicy'
import type { BranchService } from '@/services/branchService'
import { OrganizationServiceError } from '@/services/organizationService'
import type { Branch, BranchAssignment, BranchStaffMember, BranchSummary } from '@/types/branch'
import { createMockAuthStore, type MockAuthStore } from './mockAuthStore'
import { createOperationRunner, requireActor } from './mockOrganizationAccess'

interface MockBranchServiceOptions {
  authStore?: MockAuthStore
  delayInMilliseconds?: number
}

const normalizeCode = (code: string) => code.trim().toUpperCase()

export function createMockBranchService(options: MockBranchServiceOptions = {}): BranchService {
  const store = options.authStore ?? createMockAuthStore()
  const run = createOperationRunner(options.delayInMilliseconds ?? 400)

  const merchantBranches = (merchantId: string) =>
    store.loadBranches().filter((branch) => branch.merchantId === merchantId)

  const findBranch = (merchantId: string, branchId: string): Branch => {
    const branch = merchantBranches(merchantId).find((candidate) => candidate.id === branchId)
    if (!branch) throw new OrganizationServiceError('not_found', 'This branch could not be found.')
    return branch
  }

  const assertCodeIsUnique = (merchantId: string, code: string, exceptBranchId?: string) => {
    const taken = merchantBranches(merchantId).some(
      (branch) => branch.id !== exceptBranchId && normalizeCode(branch.code) === code,
    )
    if (taken) {
      throw new OrganizationServiceError(
        'duplicate_branch_code',
        'Another branch in this business already uses this code.',
      )
    }
  }

  const saveBranch = (updated: Branch) =>
    store.saveBranches(
      store.loadBranches().map((branch) => (branch.id === updated.id ? updated : branch)),
    )

  const isCountedStaff = (membershipId: string) => {
    const status = store.loadMemberships().find((m) => m.id === membershipId)?.status
    return status === 'ACTIVE' || status === 'SUSPENDED'
  }

  return {
    listBranches: (merchantId) =>
      run(() => {
        requireActor(store, merchantId, 'branches:manage')
        const assignments = store
          .loadBranchAssignments()
          .filter((a) => a.merchantId === merchantId && a.status === 'ACTIVE')
        return merchantBranches(merchantId)
          .map<BranchSummary>((branch) => ({
            ...branch,
            assignedStaffCount: assignments.filter(
              (a) => a.branchId === branch.id && isCountedStaff(a.membershipId),
            ).length,
          }))
          .sort((a, b) => a.name.localeCompare(b.name))
      }),

    getBranch: (merchantId, branchId) =>
      run(() => {
        requireActor(store, merchantId, 'branches:manage')
        const branch = findBranch(merchantId, branchId)
        const users = store.loadUsers()
        const memberships = store.loadMemberships()
        const assignedStaff = store
          .loadBranchAssignments()
          .filter(
            (a) => a.merchantId === merchantId && a.branchId === branchId && a.status === 'ACTIVE',
          )
          .flatMap<BranchStaffMember>((assignment) => {
            const membership = memberships.find((m) => m.id === assignment.membershipId)
            const user = users.find((u) => u.id === membership?.userId)
            if (!membership || !user || !isCountedStaff(membership.id)) return []
            return [
              {
                membershipId: membership.id,
                fullName: user.fullName,
                role: membership.role,
                membershipStatus: membership.status,
                assignedAt: assignment.createdAt,
              },
            ]
          })
        return { branch, assignedStaff }
      }),

    createBranch: (merchantId, input) =>
      run(() => {
        requireActor(store, merchantId, 'branches:manage')
        const code = normalizeCode(input.code)
        assertCodeIsUnique(merchantId, code)
        const now = new Date().toISOString()
        const branch: Branch = {
          ...input,
          code,
          id: `brn-${crypto.randomUUID().slice(0, 8)}`,
          merchantId,
          createdAt: now,
          updatedAt: now,
        }
        store.saveBranches([...store.loadBranches(), branch])
        return branch
      }),

    updateBranch: (merchantId, branchId, input) =>
      run(() => {
        requireActor(store, merchantId, 'branches:manage')
        const existing = findBranch(merchantId, branchId)
        const code = normalizeCode(input.code)
        assertCodeIsUnique(merchantId, code, branchId)
        // Spread order keeps id, merchantId, status and createdAt immutable here.
        const updated: Branch = {
          ...existing,
          name: input.name,
          code,
          location: input.location,
          contactPhone: input.contactPhone,
          updatedAt: new Date().toISOString(),
        }
        saveBranch(updated)
        return updated
      }),

    changeBranchStatus: (merchantId, branchId, status) =>
      run(() => {
        requireActor(store, merchantId, 'branches:manage')
        const existing = findBranch(merchantId, branchId)
        // History is untouched: assignments and (future) invoices keep pointing at this branch.
        const updated: Branch = { ...existing, status, updatedAt: new Date().toISOString() }
        saveBranch(updated)
        return updated
      }),

    listBranchAssignments: (merchantId, filter = {}) =>
      run(() => {
        requireActor(store, merchantId, 'cashiers:manage')
        return store
          .loadBranchAssignments()
          .filter(
            (a) =>
              a.merchantId === merchantId &&
              (!filter.membershipId || a.membershipId === filter.membershipId) &&
              (!filter.branchId || a.branchId === filter.branchId),
          )
      }),

    updateBranchAssignments: (merchantId, membershipId, branchIds) =>
      run(() => {
        const { membership: actor } = requireActor(store, merchantId, 'cashiers:manage')
        const target = store
          .loadMemberships()
          .find((m) => m.id === membershipId && m.merchantId === merchantId)
        if (!target)
          throw new OrganizationServiceError('not_found', 'This staff member could not be found.')
        if (!canPerformStaffAction(actor.role, 'assign_branches', target.role)) {
          throw new OrganizationServiceError(
            'forbidden',
            'You cannot change this person’s branches.',
          )
        }
        if (target.status !== 'ACTIVE') {
          throw new OrganizationServiceError(
            'membership_not_active',
            'Only active staff can be assigned to branches.',
          )
        }
        if (new Set(branchIds).size !== branchIds.length) {
          throw new OrganizationServiceError(
            'duplicate_assignment',
            'A branch was selected more than once.',
          )
        }

        const all = store.loadBranchAssignments()
        const currentlyAssigned = new Set(
          all
            .filter((a) => a.membershipId === membershipId && a.status === 'ACTIVE')
            .map((a) => a.branchId),
        )
        // Every branch must belong to this merchant; only new ones must also be active.
        for (const branchId of branchIds) {
          const branch = findBranch(merchantId, branchId)
          if (!currentlyAssigned.has(branchId) && branch.status !== 'ACTIVE') {
            throw new OrganizationServiceError(
              'branch_inactive',
              `${branch.name} is inactive and cannot receive new assignments.`,
            )
          }
        }

        const now = new Date().toISOString()
        const wanted = new Set(branchIds)
        const updated: BranchAssignment[] = all.map((a) =>
          a.membershipId === membershipId && a.status === 'ACTIVE' && !wanted.has(a.branchId)
            ? { ...a, status: 'ENDED', endedAt: now, updatedAt: now }
            : a,
        )
        const added: BranchAssignment[] = branchIds
          .filter((branchId) => !currentlyAssigned.has(branchId))
          .map((branchId) => ({
            id: `asg-${crypto.randomUUID().slice(0, 8)}`,
            merchantId,
            membershipId,
            branchId,
            status: 'ACTIVE',
            createdAt: now,
            updatedAt: now,
          }))
        store.saveBranchAssignments([...updated, ...added])
        return [...updated, ...added].filter(
          (a) => a.membershipId === membershipId && a.status === 'ACTIVE',
        )
      }),
  }
}
