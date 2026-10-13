import { createMockBranchService } from './mockBranchService'
import { createMemoryStorage, createMockAuthStore } from './mockAuthStore'
import { DEMO_USER_IDS } from './sampleAccounts'
import { SAMPLE_BRANCH_IDS } from './sampleOrganization'
import { SAMPLE_MERCHANT_ID, SAMPLE_SECOND_MERCHANT_ID } from './sampleMerchants'
import type { CreateBranchInput } from '@/types/branch'

type DemoUser = keyof typeof DEMO_USER_IDS

function createHarness(signedInAs: DemoUser | null = 'owner') {
  const store = createMockAuthStore({
    persistentStorage: createMemoryStorage(),
    sessionStorage: createMemoryStorage(),
  })
  if (signedInAs) store.startSession(DEMO_USER_IDS[signedInAs], false, 60_000)
  const branches = createMockBranchService({ authStore: store, delayInMilliseconds: 0 })
  return {
    store,
    branches,
    signInAs: (user: DemoUser) => store.startSession(DEMO_USER_IDS[user], false, 60_000),
  }
}

const newBranch: CreateBranchInput = {
  name: 'Kimironko Market',
  code: 'kim1',
  location: {
    province: 'Kigali City',
    district: 'Gasabo',
    sector: 'Kimironko',
    physicalAddress: 'Market stall 4',
  },
  contactPhone: '+250788123456',
  status: 'ACTIVE',
}

describe('branch listing', () => {
  it('lists the merchant branches with staff counts that exclude revoked and ended assignments', async () => {
    const { branches } = createHarness()
    const list = await branches.listBranches(SAMPLE_MERCHANT_ID)
    expect(list.map((b) => [b.name, b.assignedStaffCount])).toEqual([
      ['City Centre', 1], // Aline; Diane's assignment ended when she was revoked
      ['Nyamirambo Kiosk', 1], // Eric (suspended members still count)
      ['Remera Main', 2], // Aline and Grace
    ])
  })

  it('shows branch details with the staff assigned to it', async () => {
    const { branches } = createHarness()
    const { branch, assignedStaff } = await branches.getBranch(
      SAMPLE_MERCHANT_ID,
      SAMPLE_BRANCH_IDS.remera,
    )
    expect(branch.code).toBe('RM01')
    expect(assignedStaff.map((s) => s.fullName).sort()).toEqual(['Aline Uwase', 'Grace Mukamana'])
  })
})

describe('creating and editing branches', () => {
  it('creates a branch with a generated immutable id and an upper-case code', async () => {
    const { branches } = createHarness()
    const created = await branches.createBranch(SAMPLE_MERCHANT_ID, newBranch)
    expect(created.id).toMatch(/^brn-/)
    expect(created.code).toBe('KIM1')
    expect(created.merchantId).toBe(SAMPLE_MERCHANT_ID)
    expect(created.createdAt).toBe(created.updatedAt)
    const list = await branches.listBranches(SAMPLE_MERCHANT_ID)
    expect(list.find((b) => b.id === created.id)?.assignedStaffCount).toBe(0)
  })

  it('rejects a duplicate code within the merchant, ignoring case', async () => {
    const { branches } = createHarness()
    await expect(
      branches.createBranch(SAMPLE_MERCHANT_ID, { ...newBranch, code: 'rm01' }),
    ).rejects.toMatchObject({ code: 'duplicate_branch_code' })
  })

  it('allows the same code in a different merchant', async () => {
    const { branches, signInAs } = createHarness()
    signInAs('cafeOwner')
    const created = await branches.createBranch(SAMPLE_SECOND_MERCHANT_ID, {
      ...newBranch,
      code: 'RM01',
    })
    expect(created.code).toBe('RM01')
  })

  it('keeps id, merchant, status and creation date unchanged when editing', async () => {
    const { branches } = createHarness()
    const before = (await branches.getBranch(SAMPLE_MERCHANT_ID, SAMPLE_BRANCH_IDS.cityCentre))
      .branch
    const after = await branches.updateBranch(SAMPLE_MERCHANT_ID, SAMPLE_BRANCH_IDS.cityCentre, {
      name: 'City Centre Plaza',
      code: 'kcc', // same code as itself is fine
      location: before.location,
      contactPhone: undefined,
    })
    expect(after).toMatchObject({
      id: before.id,
      merchantId: before.merchantId,
      status: before.status,
      createdAt: before.createdAt,
      name: 'City Centre Plaza',
      code: 'KCC',
    })
    expect(Date.parse(after.updatedAt)).toBeGreaterThan(Date.parse(before.updatedAt))
  })

  it('refuses to edit a code into another branch’s code', async () => {
    const { branches } = createHarness()
    await expect(
      branches.updateBranch(SAMPLE_MERCHANT_ID, SAMPLE_BRANCH_IDS.cityCentre, {
        name: 'City Centre',
        code: 'RM01',
        location: newBranch.location,
      }),
    ).rejects.toMatchObject({ code: 'duplicate_branch_code' })
  })
})

describe('branch status and inactive branches', () => {
  it('deactivates without touching history: assignments stay on the branch', async () => {
    const { branches } = createHarness()
    const updated = await branches.changeBranchStatus(
      SAMPLE_MERCHANT_ID,
      SAMPLE_BRANCH_IDS.remera,
      'INACTIVE',
    )
    expect(updated.status).toBe('INACTIVE')
    const assignments = await branches.listBranchAssignments(SAMPLE_MERCHANT_ID, {
      branchId: SAMPLE_BRANCH_IDS.remera,
    })
    expect(assignments.filter((a) => a.status === 'ACTIVE')).toHaveLength(2)
  })

  it('refuses new assignments to an inactive branch but lets existing ones be kept or removed', async () => {
    const { branches } = createHarness()
    // Aline (mem-004) works at Remera and City Centre.
    await branches.changeBranchStatus(SAMPLE_MERCHANT_ID, SAMPLE_BRANCH_IDS.remera, 'INACTIVE')
    await expect(
      branches.updateBranchAssignments(SAMPLE_MERCHANT_ID, 'mem-004', [
        SAMPLE_BRANCH_IDS.remera,
        SAMPLE_BRANCH_IDS.cityCentre,
        SAMPLE_BRANCH_IDS.nyamirambo, // already inactive: a new assignment is refused
      ]),
    ).rejects.toMatchObject({ code: 'branch_inactive' })

    const kept = await branches.updateBranchAssignments(SAMPLE_MERCHANT_ID, 'mem-004', [
      SAMPLE_BRANCH_IDS.remera,
      SAMPLE_BRANCH_IDS.cityCentre,
    ])
    expect(kept.map((a) => a.branchId).sort()).toEqual(
      [SAMPLE_BRANCH_IDS.remera, SAMPLE_BRANCH_IDS.cityCentre].sort(),
    )
    const removed = await branches.updateBranchAssignments(SAMPLE_MERCHANT_ID, 'mem-004', [
      SAMPLE_BRANCH_IDS.cityCentre,
    ])
    expect(removed.map((a) => a.branchId)).toEqual([SAMPLE_BRANCH_IDS.cityCentre])
  })

  it('can reactivate a branch so it receives assignments again', async () => {
    const { branches } = createHarness()
    await branches.changeBranchStatus(SAMPLE_MERCHANT_ID, SAMPLE_BRANCH_IDS.nyamirambo, 'ACTIVE')
    const result = await branches.updateBranchAssignments(SAMPLE_MERCHANT_ID, 'mem-004', [
      SAMPLE_BRANCH_IDS.nyamirambo,
    ])
    expect(result).toHaveLength(1)
  })
})

describe('branch assignments', () => {
  it('ends removed assignments instead of deleting them, and records timestamps', async () => {
    const { branches } = createHarness()
    await branches.updateBranchAssignments(SAMPLE_MERCHANT_ID, 'mem-004', [
      SAMPLE_BRANCH_IDS.remera,
    ])
    const all = await branches.listBranchAssignments(SAMPLE_MERCHANT_ID, {
      membershipId: 'mem-004',
    })
    const ended = all.find((a) => a.branchId === SAMPLE_BRANCH_IDS.cityCentre)
    expect(ended).toMatchObject({ status: 'ENDED' })
    expect(ended?.endedAt).toBeDefined()
  })

  it('never creates a duplicate active assignment', async () => {
    const { branches } = createHarness()
    await expect(
      branches.updateBranchAssignments(SAMPLE_MERCHANT_ID, 'mem-004', [
        SAMPLE_BRANCH_IDS.remera,
        SAMPLE_BRANCH_IDS.remera,
      ]),
    ).rejects.toMatchObject({ code: 'duplicate_assignment' })

    await branches.updateBranchAssignments(SAMPLE_MERCHANT_ID, 'mem-004', [
      SAMPLE_BRANCH_IDS.remera,
    ])
    const active = (
      await branches.listBranchAssignments(SAMPLE_MERCHANT_ID, { membershipId: 'mem-004' })
    ).filter((a) => a.status === 'ACTIVE' && a.branchId === SAMPLE_BRANCH_IDS.remera)
    expect(active).toHaveLength(1)
  })

  it('rejects branches and memberships from a different merchant', async () => {
    const { branches } = createHarness()
    await expect(
      branches.updateBranchAssignments(SAMPLE_MERCHANT_ID, 'mem-004', [SAMPLE_BRANCH_IDS.cafe]),
    ).rejects.toMatchObject({ code: 'not_found' })
    await expect(
      branches.updateBranchAssignments(SAMPLE_MERCHANT_ID, 'mem-007', [SAMPLE_BRANCH_IDS.remera]),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('only assigns ACTIVE memberships', async () => {
    const { branches } = createHarness()
    for (const membershipId of [
      'mem-005' /* suspended */,
      'mem-006' /* revoked */,
      'mem-008' /* invited */,
    ]) {
      await expect(
        branches.updateBranchAssignments(SAMPLE_MERCHANT_ID, membershipId, [
          SAMPLE_BRANCH_IDS.remera,
        ]),
      ).rejects.toMatchObject({ code: 'membership_not_active' })
    }
  })

  it('lets a manager assign cashiers but not other managers or owners', async () => {
    const { branches, signInAs } = createHarness()
    signInAs('manager')
    await expect(
      branches.updateBranchAssignments(SAMPLE_MERCHANT_ID, 'mem-004', [SAMPLE_BRANCH_IDS.remera]),
    ).resolves.toHaveLength(1)
    await expect(
      branches.updateBranchAssignments(SAMPLE_MERCHANT_ID, 'mem-003', [SAMPLE_BRANCH_IDS.remera]),
    ).rejects.toMatchObject({ code: 'forbidden' })
    await expect(
      branches.updateBranchAssignments(SAMPLE_MERCHANT_ID, 'mem-001', [SAMPLE_BRANCH_IDS.remera]),
    ).rejects.toMatchObject({ code: 'forbidden' })
  })
})

describe('multi-business isolation and authorization', () => {
  it('requires a signed-in user', async () => {
    const { branches } = createHarness(null)
    await expect(branches.listBranches(SAMPLE_MERCHANT_ID)).rejects.toMatchObject({
      code: 'unauthenticated',
    })
  })

  it('answers "not found" for businesses the caller does not belong to', async () => {
    const { branches, signInAs } = createHarness()
    signInAs('cafeOwner')
    await expect(branches.listBranches(SAMPLE_MERCHANT_ID)).rejects.toMatchObject({
      code: 'not_found',
    })
    await expect(
      branches.getBranch(SAMPLE_MERCHANT_ID, SAMPLE_BRANCH_IDS.remera),
    ).rejects.toMatchObject({ code: 'not_found' })
    await expect(branches.createBranch(SAMPLE_MERCHANT_ID, newBranch)).rejects.toMatchObject({
      code: 'not_found',
    })
    signInAs('newcomer')
    await expect(branches.listBranches(SAMPLE_MERCHANT_ID)).rejects.toMatchObject({
      code: 'not_found',
    })
  })

  it('does not serve one merchant’s branch through another merchant’s id', async () => {
    const { branches } = createHarness()
    // The owner belongs to both businesses; a branch is only reachable via its own merchant.
    await expect(
      branches.getBranch(SAMPLE_SECOND_MERCHANT_ID, SAMPLE_BRANCH_IDS.remera),
    ).rejects.toBeTruthy()
    const cafeOwner = createHarness('cafeOwner')
    await expect(
      cafeOwner.branches.getBranch(SAMPLE_SECOND_MERCHANT_ID, SAMPLE_BRANCH_IDS.remera),
    ).rejects.toMatchObject({ code: 'not_found' })
    const own = await cafeOwner.branches.listBranches(SAMPLE_SECOND_MERCHANT_ID)
    expect(own.map((b) => b.name)).toEqual(['Cafe Nyamirambo'])
  })

  it('forbids cashiers from branch management even in their own business', async () => {
    const { branches, signInAs } = createHarness()
    signInAs('cashier')
    await expect(branches.listBranches(SAMPLE_MERCHANT_ID)).rejects.toMatchObject({
      code: 'forbidden',
    })
    await expect(branches.createBranch(SAMPLE_MERCHANT_ID, newBranch)).rejects.toMatchObject({
      code: 'forbidden',
    })
    // The same person, as owner elsewhere... is a cashier at the cafe, so also forbidden there.
    signInAs('owner')
    await expect(branches.listBranches(SAMPLE_SECOND_MERCHANT_ID)).rejects.toMatchObject({
      code: 'forbidden',
    })
  })

  it('stops a suspended or revoked member from using the service at all', async () => {
    const { branches, signInAs } = createHarness()
    for (const user of ['suspended', 'revoked'] as const) {
      signInAs(user)
      await expect(branches.listBranches(SAMPLE_MERCHANT_ID)).rejects.toMatchObject({
        code: 'not_found',
      })
    }
  })
})
