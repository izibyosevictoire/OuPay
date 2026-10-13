import type { StaffInvitation } from '@/types/staff'
import { createMockAuthService } from './mockAuthService'
import { createMemoryStorage, createMockAuthStore } from './mockAuthStore'
import { createMockBranchService } from './mockBranchService'
import { createMockStaffService } from './mockStaffService'
import {
  DEMO_INVITE_EXISTING_USER_TOKEN,
  DEMO_INVITE_NEW_USER_TOKEN,
  DEMO_PASSWORD,
  DEMO_USER_IDS,
} from './sampleAccounts'
import { SAMPLE_BRANCH_IDS } from './sampleOrganization'
import { SAMPLE_MERCHANT_ID, SAMPLE_SECOND_MERCHANT_ID } from './sampleMerchants'

type DemoUser = keyof typeof DEMO_USER_IDS

// Membership IDs in the Sample Business seed data.
const OWNER = 'mem-001'
const MANAGER = 'mem-003'
const CASHIER = 'mem-004'
const SUSPENDED_CASHIER = 'mem-005'
const REVOKED_MANAGER = 'mem-006'
const INVITED_MANAGER = 'mem-008'

function createHarness(signedInAs: DemoUser | null = 'owner') {
  const store = createMockAuthStore({
    persistentStorage: createMemoryStorage(),
    sessionStorage: createMemoryStorage(),
  })
  if (signedInAs) store.startSession(DEMO_USER_IDS[signedInAs], false, 60_000)
  return {
    store,
    staff: createMockStaffService({
      authStore: store,
      merchantStorage: createMemoryStorage(),
      delayInMilliseconds: 0,
    }),
    branches: createMockBranchService({ authStore: store, delayInMilliseconds: 0 }),
    auth: createMockAuthService({ store, delayInMilliseconds: 0 }),
    signInAs: (user: DemoUser) => store.startSession(DEMO_USER_IDS[user], false, 60_000),
    membership: (id: string) => store.loadMemberships().find((m) => m.id === id)!,
  }
}

const invite = (email: string, overrides = {}) => ({
  email,
  role: 'CASHIER' as const,
  branchIds: [] as string[],
  ...overrides,
})

describe('staff list', () => {
  it('joins memberships with users and active branch assignments, owners first', async () => {
    const { staff } = createHarness()
    const rows = await staff.listStaff(SAMPLE_MERCHANT_ID)
    expect(rows).toHaveLength(7)
    expect(rows[0]).toMatchObject({ role: 'OWNER', fullName: 'Sample Owner', status: 'ACTIVE' })
    const aline = rows.find((r) => r.membershipId === CASHIER)!
    expect(aline).toMatchObject({ email: 'cashier@oupay.demo', role: 'CASHIER', status: 'ACTIVE' })
    expect(aline.branchIds.sort()).toEqual(
      [SAMPLE_BRANCH_IDS.remera, SAMPLE_BRANCH_IDS.cityCentre].sort(),
    )
    expect(rows.find((r) => r.membershipId === SUSPENDED_CASHIER)?.status).toBe('SUSPENDED')
    expect(rows.find((r) => r.membershipId === REVOKED_MANAGER)?.branchIds).toEqual([])
  })

  it('shows pending invitations with the branches they will assign, and a demo token', async () => {
    const { staff } = createHarness()
    const invited = (await staff.listStaff(SAMPLE_MERCHANT_ID)).find(
      (r) => r.membershipId === INVITED_MANAGER,
    )!
    expect(invited.status).toBe('INVITED')
    expect(invited.branchIds).toEqual([SAMPLE_BRANCH_IDS.remera])
    expect(invited.pendingInvitation?.demoToken).toBe(DEMO_INVITE_EXISTING_USER_TOKEN)
  })

  it('shows only this business’s staff', async () => {
    const { staff, signInAs } = createHarness()
    signInAs('cafeOwner')
    const rows = await staff.listStaff(SAMPLE_SECOND_MERCHANT_ID)
    expect(rows.map((r) => r.fullName).sort()).toEqual(['Claudine Mukashema', 'Sample Owner'])
    await expect(staff.listStaff(SAMPLE_MERCHANT_ID)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('is restricted to owners and managers', async () => {
    const { staff, signInAs } = createHarness()
    signInAs('manager')
    await expect(staff.listStaff(SAMPLE_MERCHANT_ID)).resolves.toBeTruthy()
    signInAs('cashier')
    await expect(staff.listStaff(SAMPLE_MERCHANT_ID)).rejects.toMatchObject({ code: 'forbidden' })
    signInAs('suspended')
    await expect(staff.listStaff(SAMPLE_MERCHANT_ID)).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('invitations', () => {
  it('creates an INVITED membership, never an ACTIVE one', async () => {
    const { staff, store } = createHarness()
    const invitation = await staff.inviteStaff(
      SAMPLE_MERCHANT_ID,
      invite('Fresh.Hire@Example.rw', { branchIds: [SAMPLE_BRANCH_IDS.remera], note: 'Welcome' }),
    )
    expect(invitation).toMatchObject({
      email: 'fresh.hire@example.rw',
      role: 'CASHIER',
      status: 'PENDING',
      note: 'Welcome',
    })
    const membership = store.loadMemberships().find((m) => m.id === invitation.membershipId)!
    expect(membership).toMatchObject({
      status: 'INVITED',
      role: 'CASHIER',
      merchantId: SAMPLE_MERCHANT_ID,
    })
    // No branch assignment exists until acceptance.
    expect(store.loadBranchAssignments().filter((a) => a.membershipId === membership.id)).toEqual(
      [],
    )
  })

  it('simulates a pending invitation for a new email without an active account', async () => {
    const { staff, store, auth } = createHarness()
    await staff.inviteStaff(SAMPLE_MERCHANT_ID, invite('brand.new@example.rw'))
    const user = store.loadUsers().find((u) => u.email === 'brand.new@example.rw')!
    expect(user.status).toBe('PENDING')
    // It cannot be used to sign in, whatever password is tried.
    await expect(
      auth.login({ email: 'brand.new@example.rw', password: DEMO_PASSWORD }, { rememberMe: false }),
    ).rejects.toMatchObject({ code: 'invalid_credentials' })
  })

  it('links an invitation for an existing user to that User', async () => {
    const { staff, store } = createHarness()
    const before = store.loadUsers().length
    const invitation = await staff.inviteStaff(SAMPLE_MERCHANT_ID, invite('newcomer@oupay.demo'))
    expect(store.loadUsers()).toHaveLength(before)
    expect(store.loadMemberships().find((m) => m.id === invitation.membershipId)?.userId).toBe(
      DEMO_USER_IDS.newcomer,
    )
  })

  it('rejects duplicate invitations and invitations to current members', async () => {
    const { staff } = createHarness()
    await staff.inviteStaff(SAMPLE_MERCHANT_ID, invite('dup@example.rw'))
    await expect(
      staff.inviteStaff(SAMPLE_MERCHANT_ID, invite('DUP@example.rw')),
    ).rejects.toMatchObject({
      code: 'duplicate_invitation',
    })
    // Already ACTIVE, SUSPENDED and INVITED in the seed data.
    for (const email of [
      'cashier@oupay.demo',
      'suspended@oupay.demo',
      'invitee@oupay.demo',
      'new.hire@example.rw',
    ]) {
      await expect(staff.inviteStaff(SAMPLE_MERCHANT_ID, invite(email))).rejects.toMatchObject({
        code: 'duplicate_invitation',
      })
    }
  })

  it('allows a new invitation after access was revoked, as a fresh membership', async () => {
    const { staff, store } = createHarness()
    const invitation = await staff.inviteStaff(SAMPLE_MERCHANT_ID, invite('revoked@oupay.demo'))
    expect(invitation.membershipId).not.toBe(REVOKED_MANAGER)
    expect(store.loadMemberships().find((m) => m.id === REVOKED_MANAGER)?.status).toBe('REVOKED')
  })

  it('validates branches: must exist in this business and be active', async () => {
    const { staff } = createHarness()
    await expect(
      staff.inviteStaff(
        SAMPLE_MERCHANT_ID,
        invite('a@example.rw', { branchIds: [SAMPLE_BRANCH_IDS.nyamirambo] }),
      ),
    ).rejects.toMatchObject({ code: 'branch_inactive' })
    await expect(
      staff.inviteStaff(
        SAMPLE_MERCHANT_ID,
        invite('a@example.rw', { branchIds: [SAMPLE_BRANCH_IDS.cafe] }),
      ),
    ).rejects.toMatchObject({ code: 'not_found' })
    await expect(
      staff.inviteStaff(
        SAMPLE_MERCHANT_ID,
        invite('a@example.rw', { branchIds: [SAMPLE_BRANCH_IDS.remera, SAMPLE_BRANCH_IDS.remera] }),
      ),
    ).rejects.toMatchObject({ code: 'duplicate_assignment' })
  })

  it('lets managers invite cashiers only, and never lets cashiers invite', async () => {
    const { staff, signInAs } = createHarness()
    signInAs('manager')
    await expect(
      staff.inviteStaff(SAMPLE_MERCHANT_ID, invite('c1@example.rw')),
    ).resolves.toBeTruthy()
    await expect(
      staff.inviteStaff(SAMPLE_MERCHANT_ID, invite('m1@example.rw', { role: 'MANAGER' })),
    ).rejects.toMatchObject({ code: 'forbidden' })
    signInAs('cashier')
    await expect(
      staff.inviteStaff(SAMPLE_MERCHANT_ID, invite('c2@example.rw')),
    ).rejects.toMatchObject({
      code: 'forbidden',
    })
  })

  it('lists invitations for the merchant only', async () => {
    const { staff, signInAs } = createHarness()
    expect((await staff.listInvitations(SAMPLE_MERCHANT_ID)).map((i) => i.status)).toEqual([
      'PENDING',
      'PENDING',
    ])
    signInAs('cafeOwner')
    expect(await staff.listInvitations(SAMPLE_SECOND_MERCHANT_ID)).toEqual([])
  })
})

describe('accepting invitations', () => {
  it('activates the membership of an existing user and creates the planned assignments', async () => {
    const { staff, store, signInAs } = createHarness(null)
    signInAs('invitee')
    const membership = await staff.acceptInvitation(DEMO_INVITE_EXISTING_USER_TOKEN)
    expect(membership).toMatchObject({ id: INVITED_MANAGER, status: 'ACTIVE', role: 'MANAGER' })
    expect(
      store
        .loadBranchAssignments()
        .filter((a) => a.membershipId === INVITED_MANAGER && a.status === 'ACTIVE')
        .map((a) => a.branchId),
    ).toEqual([SAMPLE_BRANCH_IDS.remera])
    expect(
      store.loadInvitations().find((i) => i.demoToken === DEMO_INVITE_EXISTING_USER_TOKEN)?.status,
    ).toBe('ACCEPTED')
  })

  it('cannot be accepted twice', async () => {
    const { staff, signInAs } = createHarness(null)
    signInAs('invitee')
    await staff.acceptInvitation(DEMO_INVITE_EXISTING_USER_TOKEN)
    await expect(staff.acceptInvitation(DEMO_INVITE_EXISTING_USER_TOKEN)).rejects.toMatchObject({
      code: 'invalid_invitation',
    })
  })

  it('requires the signed-in account to match the invited email', async () => {
    const { staff, signInAs } = createHarness(null)
    await expect(staff.acceptInvitation(DEMO_INVITE_EXISTING_USER_TOKEN)).rejects.toMatchObject({
      code: 'unauthenticated',
    })
    signInAs('cashier')
    await expect(staff.acceptInvitation(DEMO_INVITE_EXISTING_USER_TOKEN)).rejects.toMatchObject({
      code: 'invitation_email_mismatch',
    })
    await expect(staff.acceptInvitation('demo-nope')).rejects.toMatchObject({
      code: 'invalid_invitation',
    })
  })

  it('lets a brand-new email claim its pending account with the invitation link, then accept', async () => {
    const { staff, store, auth } = createHarness(null)
    const session = await auth.register({
      fullName: 'Nadine Uwera',
      email: 'new.hire@example.rw',
      phoneNumber: '+250788555000',
      password: 'Sunrise2026',
      invitationToken: DEMO_INVITE_NEW_USER_TOKEN,
    })
    expect(session.user).toMatchObject({ status: 'ACTIVE', fullName: 'Nadine Uwera' })
    // Registering alone grants nothing: the membership is still INVITED.
    expect(session.memberships.map((m) => m.status)).toEqual(['INVITED'])
    const membership = await staff.acceptInvitation(DEMO_INVITE_NEW_USER_TOKEN)
    expect(membership.status).toBe('ACTIVE')
    expect(store.loadUsers().filter((u) => u.email === 'new.hire@example.rw')).toHaveLength(1)
  })

  it('does not let anyone claim an invited email without the invitation link', async () => {
    const { auth } = createHarness(null)
    const claim = {
      fullName: 'Intruder',
      email: 'new.hire@example.rw',
      phoneNumber: '+250788555111',
      password: 'Sunrise2026',
    }
    await expect(auth.register(claim)).rejects.toMatchObject({ code: 'email_taken' })
    await expect(
      auth.register({ ...claim, invitationToken: DEMO_INVITE_EXISTING_USER_TOKEN }),
    ).rejects.toMatchObject({ code: 'email_taken' })
  })

  it('skips planned branches that became inactive before acceptance', async () => {
    const { staff, branches, store, signInAs } = createHarness()
    await branches.changeBranchStatus(SAMPLE_MERCHANT_ID, SAMPLE_BRANCH_IDS.remera, 'INACTIVE')
    signInAs('invitee')
    await staff.acceptInvitation(DEMO_INVITE_EXISTING_USER_TOKEN)
    expect(store.loadBranchAssignments().filter((a) => a.membershipId === INVITED_MANAGER)).toEqual(
      [],
    )
  })

  it('previews an invitation without a session, revealing only what the invitee needs', async () => {
    const { staff } = createHarness(null)
    const existing = await staff.getInvitationPreview(DEMO_INVITE_EXISTING_USER_TOKEN)
    expect(existing).toEqual({
      email: 'invitee@oupay.demo',
      role: 'MANAGER',
      businessName: 'Sample Shop',
      status: 'PENDING',
      inviteeHasActiveAccount: true,
    })
    const brandNew = await staff.getInvitationPreview(DEMO_INVITE_NEW_USER_TOKEN)
    expect(brandNew.inviteeHasActiveAccount).toBe(false)
    await expect(staff.getInvitationPreview('bogus')).rejects.toMatchObject({
      code: 'invalid_invitation',
    })
  })
})

describe('roles', () => {
  it('lets an owner change a role', async () => {
    const { staff } = createHarness()
    const updated = await staff.updateMembershipRole(SAMPLE_MERCHANT_ID, CASHIER, 'MANAGER')
    expect(updated.role).toBe('MANAGER')
  })

  it('does not let managers or cashiers change roles', async () => {
    const { staff, signInAs } = createHarness()
    signInAs('manager')
    await expect(
      staff.updateMembershipRole(SAMPLE_MERCHANT_ID, CASHIER, 'MANAGER'),
    ).rejects.toMatchObject({
      code: 'forbidden',
    })
    signInAs('cashier')
    await expect(
      staff.updateMembershipRole(SAMPLE_MERCHANT_ID, CASHIER, 'OWNER'),
    ).rejects.toMatchObject({
      code: 'self_escalation',
    })
  })

  it('prevents self-escalation and names it as such', async () => {
    const { staff, signInAs, membership } = createHarness()
    signInAs('manager')
    await expect(
      staff.updateMembershipRole(SAMPLE_MERCHANT_ID, MANAGER, 'OWNER'),
    ).rejects.toMatchObject({
      code: 'self_escalation',
    })
    expect(membership(MANAGER).role).toBe('MANAGER')
  })

  it('protects the last active owner from demotion, but not once there are two', async () => {
    const { staff } = createHarness()
    await expect(
      staff.updateMembershipRole(SAMPLE_MERCHANT_ID, OWNER, 'MANAGER'),
    ).rejects.toMatchObject({
      code: 'last_owner',
    })
    await staff.updateMembershipRole(SAMPLE_MERCHANT_ID, MANAGER, 'OWNER')
    await expect(
      staff.updateMembershipRole(SAMPLE_MERCHANT_ID, OWNER, 'MANAGER'),
    ).resolves.toMatchObject({
      role: 'MANAGER',
    })
  })

  it('only changes roles of active or suspended members', async () => {
    const { staff } = createHarness()
    for (const id of [REVOKED_MANAGER, INVITED_MANAGER]) {
      await expect(
        staff.updateMembershipRole(SAMPLE_MERCHANT_ID, id, 'CASHIER'),
      ).rejects.toMatchObject({
        code: 'membership_not_active',
      })
    }
  })
})

describe('membership lifecycle', () => {
  it('suspends and reactivates', async () => {
    const { staff } = createHarness()
    expect((await staff.suspendMembership(SAMPLE_MERCHANT_ID, CASHIER)).status).toBe('SUSPENDED')
    expect((await staff.reactivateMembership(SAMPLE_MERCHANT_ID, CASHIER)).status).toBe('ACTIVE')
    expect((await staff.reactivateMembership(SAMPLE_MERCHANT_ID, SUSPENDED_CASHIER)).status).toBe(
      'ACTIVE',
    )
  })

  it('rejects transitions the lifecycle does not allow', async () => {
    const { staff } = createHarness()
    // ACTIVE cannot be "reactivated"; SUSPENDED cannot be suspended again.
    await expect(staff.reactivateMembership(SAMPLE_MERCHANT_ID, CASHIER)).rejects.toMatchObject({
      code: 'invalid_transition',
    })
    await expect(
      staff.suspendMembership(SAMPLE_MERCHANT_ID, SUSPENDED_CASHIER),
    ).rejects.toMatchObject({
      code: 'invalid_transition',
    })
    // INVITED members have nothing to suspend.
    await expect(
      staff.suspendMembership(SAMPLE_MERCHANT_ID, INVITED_MANAGER),
    ).rejects.toMatchObject({
      code: 'invalid_transition',
    })
  })

  it('revokes from any live status and ends branch assignments', async () => {
    const { staff, store } = createHarness()
    await staff.revokeMembership(SAMPLE_MERCHANT_ID, CASHIER)
    expect(
      store
        .loadBranchAssignments()
        .filter((a) => a.membershipId === CASHIER)
        .every((a) => a.status === 'ENDED'),
    ).toBe(true)
    await staff.revokeMembership(SAMPLE_MERCHANT_ID, SUSPENDED_CASHIER)
    await staff.revokeMembership(SAMPLE_MERCHANT_ID, INVITED_MANAGER)
    // Revoking an invitation also cancels the invitation itself.
    expect(store.loadInvitations().find((i) => i.membershipId === INVITED_MANAGER)?.status).toBe(
      'REVOKED',
    )
  })

  it('never restores revoked access automatically', async () => {
    const { staff } = createHarness()
    await staff.revokeMembership(SAMPLE_MERCHANT_ID, CASHIER)
    await expect(staff.reactivateMembership(SAMPLE_MERCHANT_ID, CASHIER)).rejects.toMatchObject({
      code: 'invalid_transition',
      message: expect.stringContaining('new invitation'),
    })
    await expect(staff.revokeMembership(SAMPLE_MERCHANT_ID, CASHIER)).rejects.toMatchObject({
      code: 'invalid_transition',
    })
    await expect(
      staff.suspendMembership(SAMPLE_MERCHANT_ID, REVOKED_MANAGER),
    ).rejects.toMatchObject({
      code: 'invalid_transition',
    })
  })

  it('removes effective access immediately for a revoked or suspended member', async () => {
    const { staff, auth, signInAs } = createHarness()
    await staff.revokeMembership(SAMPLE_MERCHANT_ID, CASHIER)
    await staff.suspendMembership(SAMPLE_MERCHANT_ID, MANAGER)

    signInAs('cashier')
    expect((await auth.getCurrentSession())?.memberships.map((m) => m.status)).toEqual(['REVOKED'])
    await expect(staff.listStaff(SAMPLE_MERCHANT_ID)).rejects.toMatchObject({ code: 'not_found' })
    signInAs('manager')
    await expect(staff.listStaff(SAMPLE_MERCHANT_ID)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('protects the last active owner from suspension and revocation', async () => {
    const { staff, signInAs } = createHarness()
    await staff.updateMembershipRole(SAMPLE_MERCHANT_ID, MANAGER, 'OWNER')
    signInAs('manager') // now an owner, acting on the original owner
    await staff.revokeMembership(SAMPLE_MERCHANT_ID, OWNER) // allowed: another owner remains
    signInAs('cafeOwner')
    // The cafe has one owner; nobody may remove them.
    await expect(
      staff.revokeMembership(SAMPLE_SECOND_MERCHANT_ID, 'mem-007'),
    ).rejects.toMatchObject({
      code: 'last_owner',
    })
  })

  it('refuses suspending the last owner even when another member tries', async () => {
    const { staff } = createHarness()
    await expect(staff.suspendMembership(SAMPLE_MERCHANT_ID, OWNER)).rejects.toMatchObject({
      code: 'forbidden', // self-suspension is blocked before the last-owner rule
    })
    await staff.updateMembershipRole(SAMPLE_MERCHANT_ID, MANAGER, 'OWNER')
    await staff.suspendMembership(SAMPLE_MERCHANT_ID, MANAGER)
    await expect(staff.revokeMembership(SAMPLE_MERCHANT_ID, OWNER)).rejects.toMatchObject({
      code: 'last_owner', // the only ACTIVE owner left (the other is suspended)
    })
  })

  it('lets managers manage cashiers only', async () => {
    const { staff, signInAs } = createHarness()
    signInAs('manager')
    await expect(staff.suspendMembership(SAMPLE_MERCHANT_ID, CASHIER)).resolves.toBeTruthy()
    await expect(staff.suspendMembership(SAMPLE_MERCHANT_ID, OWNER)).rejects.toMatchObject({
      code: 'forbidden',
    })
    await expect(staff.revokeMembership(SAMPLE_MERCHANT_ID, INVITED_MANAGER)).rejects.toMatchObject(
      {
        code: 'forbidden',
      },
    )
  })

  it('answers not found for memberships of other businesses', async () => {
    const { staff, signInAs } = createHarness()
    // The cafe's owner membership, requested through the sample business.
    await expect(staff.suspendMembership(SAMPLE_MERCHANT_ID, 'mem-007')).rejects.toMatchObject({
      code: 'not_found',
    })
    // The owner is only a cashier at the cafe, so the cafe itself is off limits.
    await expect(
      staff.suspendMembership(SAMPLE_SECOND_MERCHANT_ID, 'mem-007'),
    ).rejects.toMatchObject({
      code: 'forbidden',
    })
    signInAs('cafeOwner')
    await expect(staff.suspendMembership(SAMPLE_SECOND_MERCHANT_ID, CASHIER)).rejects.toMatchObject(
      {
        code: 'not_found',
      },
    )
  })
})

describe('typed invitation record', () => {
  it('carries what the acceptance flow needs', async () => {
    const { staff } = createHarness()
    const invitation: StaffInvitation = await staff.inviteStaff(
      SAMPLE_MERCHANT_ID,
      invite('typed@example.rw'),
    )
    expect(invitation.demoToken).toMatch(/^demo-invite-/)
    expect(invitation.invitedByUserId).toBe(DEMO_USER_IDS.owner)
  })
})
