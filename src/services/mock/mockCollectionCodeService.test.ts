import {
  CollectionCodeServiceError,
  type CollectionCodeServiceErrorCode,
} from '@/services/collectionCodeService'
import { createTestBackend } from '@/test/merchantTestDouble'
import { SAMPLE_MERCHANT_ID, SAMPLE_SECOND_MERCHANT_ID } from './sampleMerchants'
import { SAMPLE_BRANCH_IDS } from './sampleOrganization'

const M = SAMPLE_MERCHANT_ID
const COUNTER = 'cc-sample-001' // ACTIVE, bank-approved, not simulated, held by Aline (mem-004)
const PENDING = 'cc-sample-002' // REQUEST_DECLARED, City Centre
const REQUESTED = 'cc-sample-003' // REQUESTED, no branch
const CLOSED = 'cc-sample-004' // DEACTIVATED
const SIMULATED = 'cc-sample-005' // ACTIVE but on a simulated account, held by a collection point
const ALINE = 'mem-004'
const GRACE = 'mem-003'
const ERIC = 'mem-005' // suspended
const INVITEE = 'mem-008' // invited, not active

function setup(
  signedInAs: Parameters<ReturnType<typeof createTestBackend>['signInAs']>[0] = 'owner',
) {
  const backend = createTestBackend()
  backend.signInAs(signedInAs)
  return { ...backend, codes: backend.fastCollectionCodes }
}
type Setup = ReturnType<typeof setup>

let counter = 0
const requestId = () => `aaaaaaaa-bbbb-4ccc-8ddd-${String(++counter).padStart(12, '0')}`

async function codeOf(promise: Promise<unknown>): Promise<CollectionCodeServiceErrorCode> {
  try {
    await promise
  } catch (error) {
    if (error instanceof CollectionCodeServiceError) return error.code
    throw error
  }
  throw new Error('expected the call to be rejected')
}

const request = (s: Setup, over: Partial<Parameters<Setup['codes']['requestCode']>[1]> = {}) =>
  s.codes.requestCode(M, {
    clientOperationId: requestId(),
    settlementDestinationId: 'dst-sample-001',
    displayLabel: 'New counter',
    ...over,
  })

describe('the code registry: reading', () => {
  it('lists the business’s codes newest first and nothing of another business', async () => {
    const s = setup()
    const page = await s.codes.listCodes(M)
    expect(page.items.map((c) => c.id)).toEqual([SIMULATED, CLOSED, REQUESTED, PENDING, COUNTER])
    expect(page.items.every((c) => c.id !== 'cc-sample-006')).toBe(true)
    expect(page.nextCursor).toBeNull()
  })

  it('pages with a cursor and filters by status, branch and text', async () => {
    const s = setup()
    const first = await s.codes.listCodes(M, { limit: 2 })
    expect(first.items).toHaveLength(2)
    expect(first.nextCursor).not.toBeNull()
    const second = await s.codes.listCodes(M, { limit: 2, cursor: first.nextCursor })
    expect(second.items.map((c) => c.id)).not.toContain(first.items[0]!.id)
    expect(
      (await s.codes.listCodes(M, { status: 'REQUEST_DECLARED' })).items.map((c) => c.id),
    ).toEqual([PENDING])
    expect(
      (await s.codes.listCodes(M, { branchId: SAMPLE_BRANCH_IDS.cityCentre })).items.map(
        (c) => c.id,
      ),
    ).toEqual([SIMULATED, PENDING])
    expect((await s.codes.listCodes(M, { q: 'CC-7KQ2' })).items.map((c) => c.id)).toEqual([COUNTER])
    expect((await s.codes.listCodes(M, { q: 'illustrative-001' })).items.map((c) => c.id)).toEqual([
      COUNTER,
    ])
    expect(await codeOf(s.codes.listCodes(M, { cursor: '-4' }))).toBe('validation')
  })

  it('tells apart an internal reference, a pending code and a bank-approved one', async () => {
    const s = setup()
    const pending = await s.codes.getCode(M, PENDING)
    expect(pending.internalRef).toMatch(/^CC-/)
    expect(pending.externalCodeState).toBe('NOT_ISSUED')
    expect(pending.externalCode).toBeNull()
    expect(pending.payable).toBe(false)
    const approved = await s.codes.getCode(M, COUNTER)
    expect(approved.externalCodeState).toBe('BANK_APPROVED')
    expect(approved.externalCode).toBe('DEMO-ILLUSTRATIVE-001')
    expect(approved.approval).toMatchObject({
      source: 'OPERATOR',
      evidenceRef: 'DEMO-EVIDENCE-0001',
    })
    expect(approved.payable).toBe(true)
    expect(approved.internalRef).not.toBe(approved.externalCode)
  })

  it('never makes a simulated or non-active code payable', async () => {
    const s = setup()
    const simulated = await s.codes.getCode(M, SIMULATED)
    expect(simulated.status).toBe('ACTIVE')
    expect(simulated.externalCodeState).toBe('BANK_APPROVED')
    expect(simulated.simulated).toBe(true)
    expect(simulated.payable).toBe(false)
    const suspended = await s.codes.suspend(M, COUNTER, {
      expectedVersion: (await s.codes.getCode(M, COUNTER)).version,
      reason: 'Paused for a check.',
    })
    expect(suspended.payable).toBe(false)
  })

  it('has no way to approve, activate or record a bank-issued code', () => {
    const names = Object.keys(setup().codes)
    expect(
      names.filter((n) => /approve|^activate|issued|markBank|setExternal|recordBank/i.test(n)),
    ).toEqual([])
    expect([...names].sort()).toEqual(
      [
        'assign',
        'deactivate',
        'declareSubmission',
        'endAssignment',
        'getCode',
        'getMyCode',
        'getOptions',
        'listAssignments',
        'listCodes',
        'reassign',
        'requestCode',
        'suspend',
      ].sort(),
    )
  })

  it('isolates businesses', async () => {
    const s = setup('cafeOwner')
    const own = await s.codes.listCodes(SAMPLE_SECOND_MERCHANT_ID)
    expect(own.items.map((c) => c.id)).toEqual(['cc-sample-006'])
    expect(await codeOf(s.codes.listCodes(M))).toBe('not_found')
    expect(await codeOf(s.codes.getCode(M, COUNTER))).toBe('not_found')
    // The owner of the shop cannot read the cafe's code through the shop either.
    const owner = setup()
    expect(await codeOf(owner.codes.getCode(M, 'cc-sample-006'))).toBe('not_found')
    // The shop owner is only a cashier of the cafe, so even the cafe's registry is closed to them.
    expect(await codeOf(owner.codes.listCodes(SAMPLE_SECOND_MERCHANT_ID))).toBe('forbidden')
  })

  it('shows the registry to owners and managers only', async () => {
    expect((await setup('manager').codes.listCodes(M)).items.length).toBeGreaterThan(0)
    expect(await codeOf(setup('cashier').codes.listCodes(M))).toBe('forbidden')
    expect(await codeOf(setup('cashier').codes.getCode(M, COUNTER))).toBe('forbidden')
    expect(await codeOf(setup('cashier').codes.listAssignments(M, COUNTER))).toBe('forbidden')
  })

  it('offers settlement accounts only to those who can request codes, and members with their branches', async () => {
    const owner = await setup().codes.getOptions(M)
    expect(owner.destinations.map((d) => d.id)).toEqual(['dst-sample-001'])
    expect(owner.destinations[0]).toMatchObject({ simulated: true, connectionStatus: 'CONNECTED' })
    const aline = owner.members.find((m) => m.membershipId === ALINE)!
    expect(aline.branchIds.sort()).toEqual(
      [SAMPLE_BRANCH_IDS.cityCentre, SAMPLE_BRANCH_IDS.remera].sort(),
    )
    expect(owner.members.find((m) => m.membershipId === ERIC)).toBeUndefined()
    expect((await setup('manager').codes.getOptions(M)).destinations).toEqual([])
  })
})

describe('the code registry: requesting', () => {
  it('records an internal request that is not approved and not payable', async () => {
    const s = setup()
    const result = await request(s, { branchId: SAMPLE_BRANCH_IDS.remera })
    expect(result.replayed).toBe(false)
    expect(result.code).toMatchObject({
      status: 'REQUESTED',
      externalCodeState: 'NOT_ISSUED',
      externalCode: null,
      approval: null,
      payable: false,
      simulated: true,
      branchName: 'Remera Main',
      settlementAccountLabel: 'Main collections account',
      version: 0,
    })
    expect(result.code.internalRef).toMatch(/^CC-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{8}$/)
    expect((await s.codes.listCodes(M)).items[0]!.id).toBe(result.code.id)
  })

  it('is idempotent by request id, and a different request under the same id is a conflict', async () => {
    const s = setup()
    const id = requestId()
    const first = await request(s, { clientOperationId: id })
    const again = await request(s, { clientOperationId: id })
    expect(again.replayed).toBe(true)
    expect(again.code.id).toBe(first.code.id)
    expect(
      (await s.codes.listCodes(M)).items.filter((c) => c.displayLabel === 'New counter'),
    ).toHaveLength(1)
    expect(await codeOf(request(s, { clientOperationId: id, displayLabel: 'Something else' }))).toBe(
      'client_request_id_reuse',
    )
    expect(await codeOf(request(s, { clientOperationId: 'not-a-uuid' }))).toBe('validation')
  })

  it('validates the label, the settlement account and the branch', async () => {
    const s = setup()
    expect(await codeOf(request(s, { displayLabel: '   ' }))).toBe('validation')
    expect(await codeOf(request(s, { displayLabel: 'x'.repeat(61) }))).toBe('validation')
    expect(await codeOf(request(s, { settlementDestinationId: 'dst-sample-101' }))).toBe(
      'not_found',
    )
    expect(await codeOf(request(s, { settlementDestinationId: 'dst-nope' }))).toBe('not_found')
    expect(await codeOf(request(s, { branchId: SAMPLE_BRANCH_IDS.nyamirambo }))).toBe(
      'branch_not_eligible',
    )
    expect(await codeOf(request(s, { branchId: SAMPLE_BRANCH_IDS.cafe }))).toBe(
      'branch_not_eligible',
    )
  })

  it('refuses a settlement account whose connection is not live', async () => {
    const s = setup()
    s.ledger.bankConnections.save(
      s.ledger.bankConnections
        .load()
        .map((c) => (c.id === 'bcn-sample-001' ? { ...c, status: 'DISABLED' as const } : c)),
    )
    expect(await codeOf(request(s))).toBe('settlement_account_unavailable')
  })

  it('is the owner’s alone', async () => {
    expect(await codeOf(request(setup('manager')))).toBe('forbidden')
    expect(await codeOf(request(setup('cashier')))).toBe('forbidden')
  })
})

describe('the code registry: lifecycle', () => {
  it('records a bank request made by the owner, once, and it is not approval', async () => {
    const s = setup()
    const before = await s.codes.getCode(M, REQUESTED)
    const updated = await s.codes.declareSubmission(M, REQUESTED, {
      expectedVersion: before.version,
      bankRequestRef: '  EQ-CASE-77  ',
    })
    expect(updated).toMatchObject({
      status: 'REQUEST_DECLARED',
      bankRequestRef: 'EQ-CASE-77',
      externalCodeState: 'NOT_ISSUED',
      externalCode: null,
      approval: null,
      payable: false,
      version: before.version + 1,
    })
    expect(
      await codeOf(
        s.codes.declareSubmission(M, REQUESTED, {
          expectedVersion: updated.version,
          bankRequestRef: 'again',
        }),
      ),
    ).toBe('code_status_invalid')
    expect(
      await codeOf(
        s.codes.declareSubmission(M, PENDING, { expectedVersion: 0, bankRequestRef: 'x' }),
      ),
    ).toBe('version_conflict')
    expect(
      await codeOf(
        s.codes.declareSubmission(M, 'cc-nope', { expectedVersion: 0, bankRequestRef: 'x' }),
      ),
    ).toBe('not_found')
  })

  it('needs a bank reference', async () => {
    const s = setup()
    const code = await request(s)
    expect(
      await codeOf(
        s.codes.declareSubmission(M, code.code.id, { expectedVersion: 0, bankRequestRef: '  ' }),
      ),
    ).toBe('validation')
  })

  it('suspends only an active code, and checks the version and the reason', async () => {
    const s = setup()
    expect(await codeOf(s.codes.suspend(M, REQUESTED, { expectedVersion: 0, reason: 'x' }))).toBe(
      'code_status_invalid',
    )
    expect(await codeOf(s.codes.suspend(M, PENDING, { expectedVersion: 1, reason: 'x' }))).toBe(
      'code_status_invalid',
    )
    const code = await s.codes.getCode(M, COUNTER)
    expect(
      await codeOf(s.codes.suspend(M, COUNTER, { expectedVersion: code.version + 5, reason: 'x' })),
    ).toBe('version_conflict')
    expect(
      await codeOf(s.codes.suspend(M, COUNTER, { expectedVersion: code.version, reason: ' ' })),
    ).toBe('validation')
    const suspended = await s.codes.suspend(M, COUNTER, {
      expectedVersion: code.version,
      reason: 'Audit',
    })
    expect(suspended).toMatchObject({ status: 'SUSPENDED', statusReason: 'Audit', payable: false })
    // A suspended code can not be reactivated from the merchant side: there is nothing to call.
    expect(
      await codeOf(
        s.codes.suspend(M, COUNTER, { expectedVersion: suspended.version, reason: 'again' }),
      ),
    ).toBe('code_status_invalid')
  })

  it('deactivates for good, ends the open assignment and keeps its history', async () => {
    const s = setup()
    const code = await s.codes.getCode(M, COUNTER)
    const closed = await s.codes.deactivate(M, COUNTER, {
      expectedVersion: code.version,
      reason: 'Counter closed',
    })
    expect(closed).toMatchObject({
      status: 'DEACTIVATED',
      statusReason: 'Counter closed',
      currentAssignment: null,
    })
    const history = (await s.codes.listAssignments(M, COUNTER)).items
    expect(history).toHaveLength(2)
    expect(history[0]).toMatchObject({
      assigneeName: 'Aline Uwase',
      endReason: 'Code deactivated: Counter closed',
    })
    expect(history[0]!.validTo).not.toBeNull()
    expect(
      await codeOf(
        s.codes.deactivate(M, COUNTER, { expectedVersion: closed.version, reason: 'again' }),
      ),
    ).toBe('code_status_invalid')
    expect(
      await codeOf(s.codes.deactivate(M, CLOSED, { expectedVersion: 2, reason: 'again' })),
    ).toBe('code_status_invalid')
    expect(await codeOf(s.codes.assign(M, COUNTER, { collectionPointLabel: 'Anyone' }))).toBe(
      'code_status_invalid',
    )
  })

  it('lets a deactivated code never be handed out again', async () => {
    const s = setup()
    expect(await codeOf(s.codes.assign(M, CLOSED, { collectionPointLabel: 'Kiosk' }))).toBe(
      'code_status_invalid',
    )
    expect(
      await codeOf(
        s.codes.reassign(M, CLOSED, {
          expectedAssignmentId: 'x',
          membershipId: ALINE,
          reason: 'x',
        }),
      ),
    ).toBe('code_status_invalid')
  })

  it('leaves suspending and deactivating to the owner', async () => {
    const manager = setup('manager')
    expect(
      await codeOf(manager.codes.suspend(M, COUNTER, { expectedVersion: 3, reason: 'x' })),
    ).toBe('forbidden')
    expect(
      await codeOf(manager.codes.deactivate(M, COUNTER, { expectedVersion: 3, reason: 'x' })),
    ).toBe('forbidden')
    expect(
      await codeOf(
        manager.codes.declareSubmission(M, REQUESTED, { expectedVersion: 0, bankRequestRef: 'x' }),
      ),
    ).toBe('forbidden')
  })
})

describe('the code registry: assignments', () => {
  it('gives a code to a collection point or to an eligible member, once', async () => {
    const s = setup()
    const point = await s.codes.assign(M, REQUESTED, { collectionPointLabel: '  Market stall ' })
    expect(point).toMatchObject({
      assigneeKind: 'COLLECTION_POINT',
      assigneeName: 'Market stall',
      collectionPointLabel: 'Market stall',
      membershipId: null,
      validTo: null,
      assignedByName: 'Sample Owner',
    })
    expect(await codeOf(s.codes.assign(M, REQUESTED, { membershipId: ALINE }))).toBe(
      'already_assigned',
    )
    const member = await s.codes.assign(M, PENDING, { membershipId: ALINE })
    expect(member).toMatchObject({
      assigneeKind: 'MEMBER',
      assigneeName: 'Aline Uwase',
      assigneeRole: 'CASHIER',
      branchName: 'City Centre',
      branchCode: 'KCC',
      assigneeCurrentStatus: 'ACTIVE',
    })
    expect((await s.codes.getCode(M, PENDING)).currentAssignment?.id).toBe(member.id)
  })

  it('refuses people and branches that are not eligible', async () => {
    const s = setup()
    expect(await codeOf(s.codes.assign(M, REQUESTED, { membershipId: ERIC }))).toBe(
      'assignee_not_eligible',
    )
    expect(await codeOf(s.codes.assign(M, REQUESTED, { membershipId: INVITEE }))).toBe(
      'assignee_not_eligible',
    )
    expect(await codeOf(s.codes.assign(M, REQUESTED, { membershipId: 'mem-007' }))).toBe(
      'assignee_not_eligible',
    )
    // Grace works at Remera only; the code belongs to City Centre.
    expect(await codeOf(s.codes.assign(M, PENDING, { membershipId: GRACE }))).toBe(
      'assignee_not_eligible',
    )
    expect(
      await codeOf(
        s.codes.assign(M, PENDING, { membershipId: ALINE, branchId: SAMPLE_BRANCH_IDS.remera }),
      ),
    ).toBe('branch_not_eligible')
    expect(
      await codeOf(
        s.codes.assign(M, REQUESTED, {
          membershipId: ALINE,
          branchId: SAMPLE_BRANCH_IDS.nyamirambo,
        }),
      ),
    ).toBe('branch_not_eligible')
    expect(
      await codeOf(
        s.codes.assign(M, REQUESTED, { membershipId: ALINE, collectionPointLabel: 'Both' }),
      ),
    ).toBe('validation')
    expect(await codeOf(s.codes.assign(M, REQUESTED, {}))).toBe('validation')
    expect(
      await codeOf(s.codes.assign(M, REQUESTED, { collectionPointLabel: 'x'.repeat(61) })),
    ).toBe('validation')
  })

  it('lets a code without a branch be placed at a chosen branch, for a member who works there', async () => {
    const s = setup()
    const given = await s.codes.assign(M, REQUESTED, {
      membershipId: ALINE,
      branchId: SAMPLE_BRANCH_IDS.cityCentre,
    })
    expect(given.branchCode).toBe('KCC')
    const other = setup()
    expect(
      await codeOf(
        other.codes.assign(M, REQUESTED, {
          membershipId: GRACE,
          branchId: SAMPLE_BRANCH_IDS.cityCentre,
        }),
      ),
    ).toBe('assignee_not_eligible')
  })

  it('reassigns atomically: the old assignment ends exactly when the new one starts', async () => {
    const s = setup()
    const current = (await s.codes.getCode(M, COUNTER)).currentAssignment!
    const next = await s.codes.reassign(M, COUNTER, {
      expectedAssignmentId: current.id,
      collectionPointLabel: 'Counter 2',
      reason: 'Aline moved to the till',
    })
    expect(next).toMatchObject({
      assigneeKind: 'COLLECTION_POINT',
      assigneeName: 'Counter 2',
      validTo: null,
    })
    const history = (await s.codes.listAssignments(M, COUNTER)).items
    expect(history.map((a) => a.assigneeName)).toEqual(['Counter 2', 'Aline Uwase', 'Front desk'])
    const ended = history[1]!
    expect(ended.validTo).toBe(next.validFrom)
    expect(ended).toMatchObject({
      endReason: 'Aline moved to the till',
      endedByName: 'Sample Owner',
    })
    expect(history.filter((a) => a.validTo === null)).toHaveLength(1)
  })

  it('never leaves a code without its agent when a reassignment is refused', async () => {
    const s = setup()
    const current = (await s.codes.getCode(M, COUNTER)).currentAssignment!
    expect(
      await codeOf(
        s.codes.reassign(M, COUNTER, {
          expectedAssignmentId: current.id,
          membershipId: ERIC,
          reason: 'Swap',
        }),
      ),
    ).toBe('assignee_not_eligible')
    expect(
      await codeOf(
        s.codes.reassign(M, COUNTER, {
          expectedAssignmentId: current.id,
          membershipId: ALINE,
          reason: 'Same',
        }),
      ),
    ).toBe('already_assigned')
    expect(
      await codeOf(
        s.codes.reassign(M, COUNTER, {
          expectedAssignmentId: current.id,
          collectionPointLabel: 'X',
          reason: ' ',
        }),
      ),
    ).toBe('validation')
    expect(
      await codeOf(
        s.codes.reassign(M, COUNTER, {
          expectedAssignmentId: 'stale',
          collectionPointLabel: 'X',
          reason: 'r',
        }),
      ),
    ).toBe('assignment_changed')
    expect((await s.codes.getCode(M, COUNTER)).currentAssignment?.id).toBe(current.id)
    expect((await s.codes.listAssignments(M, COUNTER)).items).toHaveLength(2)
    expect(
      await codeOf(
        s.codes.reassign(M, REQUESTED, {
          expectedAssignmentId: 'x',
          collectionPointLabel: 'X',
          reason: 'r',
        }),
      ),
    ).toBe('no_open_assignment')
  })

  it('ends an assignment with a reason, once, for the assignment the person saw', async () => {
    const s = setup()
    const current = (await s.codes.getCode(M, SIMULATED)).currentAssignment!
    expect(
      await codeOf(
        s.codes.endAssignment(M, SIMULATED, { expectedAssignmentId: current.id, reason: '  ' }),
      ),
    ).toBe('validation')
    expect(
      await codeOf(
        s.codes.endAssignment(M, SIMULATED, { expectedAssignmentId: 'stale', reason: 'r' }),
      ),
    ).toBe('assignment_changed')
    const ended = await s.codes.endAssignment(M, SIMULATED, {
      expectedAssignmentId: current.id,
      reason: 'Stall closed',
    })
    expect(ended).toMatchObject({ endReason: 'Stall closed', endedByName: 'Sample Owner' })
    expect(ended.validTo).not.toBeNull()
    expect((await s.codes.getCode(M, SIMULATED)).currentAssignment).toBeNull()
    expect(
      await codeOf(
        s.codes.endAssignment(M, SIMULATED, { expectedAssignmentId: current.id, reason: 'again' }),
      ),
    ).toBe('no_open_assignment')
  })

  it('keeps history immutable: snapshots survive staff changes and nothing is deleted', async () => {
    const s = setup()
    const before = (await s.codes.listAssignments(M, COUNTER)).items
    // Aline is suspended and her name and branch change afterwards.
    s.store.saveMemberships(
      s.store
        .loadMemberships()
        .map((m) => (m.id === ALINE ? { ...m, status: 'SUSPENDED' as const } : m)),
    )
    s.store.saveUsers(
      s.store
        .loadUsers()
        .map((u) => (u.id === 'usr-demo-cashier' ? { ...u, fullName: 'Renamed Person' } : u)),
    )
    s.store.saveBranches(
      s.store
        .loadBranches()
        .map((b) => (b.id === SAMPLE_BRANCH_IDS.remera ? { ...b, name: 'Renamed Branch' } : b)),
    )
    const after = (await s.codes.listAssignments(M, COUNTER)).items
    expect(after).toHaveLength(before.length)
    const aline = after.find((a) => a.membershipId === ALINE)!
    expect(aline.assigneeName).toBe('Aline Uwase')
    expect(aline.branchName).toBe('Remera Main')
    // The open assignment shows her CURRENT status so someone can act, without rewriting anything.
    expect(aline.assigneeCurrentStatus).toBe('SUSPENDED')
    expect(after.find((a) => a.validTo !== null)!.assigneeCurrentStatus).toBeNull()
    // And a suspended person can no longer be given a code.
    expect(await codeOf(s.codes.assign(M, REQUESTED, { membershipId: ALINE }))).toBe(
      'assignee_not_eligible',
    )
  })

  it('lets a manager act only on codes of branches they work at, and never on codes with no branch', async () => {
    const manager = setup('manager')
    expect(await codeOf(manager.codes.assign(M, REQUESTED, { collectionPointLabel: 'X' }))).toBe(
      'forbidden',
    )
    expect(await codeOf(manager.codes.assign(M, PENDING, { collectionPointLabel: 'X' }))).toBe(
      'forbidden',
    )
    const current = (await manager.codes.getCode(M, COUNTER)).currentAssignment!
    const next = await manager.codes.reassign(M, COUNTER, {
      expectedAssignmentId: current.id,
      collectionPointLabel: 'Counter 2',
      reason: 'Rota change',
    })
    expect(next.assignedByName).toBe('Grace Mukamana')
    expect(
      await codeOf(
        manager.codes.endAssignment(M, SIMULATED, { expectedAssignmentId: 'x', reason: 'r' }),
      ),
    ).toBe('forbidden')
  })

  it('keeps cashiers out of assigning', async () => {
    const cashier = setup('cashier')
    expect(await codeOf(cashier.codes.assign(M, REQUESTED, { collectionPointLabel: 'X' }))).toBe(
      'forbidden',
    )
    expect(
      await codeOf(
        cashier.codes.endAssignment(M, COUNTER, { expectedAssignmentId: 'x', reason: 'r' }),
      ),
    ).toBe('forbidden')
  })

  it('pages the history newest first', async () => {
    const s = setup()
    const first = await s.codes.listAssignments(M, COUNTER, { limit: 1 })
    expect(first.items[0]!.assigneeName).toBe('Aline Uwase')
    const second = await s.codes.listAssignments(M, COUNTER, { limit: 1, cursor: first.nextCursor })
    expect(second.items[0]!.assigneeName).toBe('Front desk')
    expect(second.nextCursor).toBeNull()
    expect(await codeOf(s.codes.listAssignments(M, 'cc-nope'))).toBe('not_found')
  })
})

describe('the code registry: my code', () => {
  it('shows an agent their own approved code, and only that', async () => {
    const mine = await setup('cashier').codes.getMyCode(M)
    expect(mine.assignment).toMatchObject({ assigneeName: 'Aline Uwase', validTo: null })
    expect(mine.code).toMatchObject({
      id: COUNTER,
      payable: true,
      externalCode: 'DEMO-ILLUSTRATIVE-001',
      simulated: false,
    })
  })

  it('never shows a code value for a code that is not payable', async () => {
    const owner = setup()
    const code = await owner.codes.getCode(M, COUNTER)
    await owner.codes.suspend(M, COUNTER, { expectedVersion: code.version, reason: 'Check' })
    owner.signInAs('cashier')
    const mine = await owner.codes.getMyCode(M)
    expect(mine.code).toMatchObject({ status: 'SUSPENDED', payable: false, externalCode: null })
    expect(mine.code?.message).toMatch(/Do not give it to customers/)
  })

  it('shows nothing to someone who holds no code, and nothing about other people’s codes', async () => {
    expect(await setup('manager').codes.getMyCode(M)).toEqual({ assignment: null, code: null })
    const cashier = setup('cashier')
    expect((await cashier.codes.getMyCode(M)).code?.id).toBe(COUNTER)
  })

  it('needs an active membership of the business', async () => {
    expect(await codeOf(setup('cafeOwner').codes.getMyCode(M))).toBe('not_found')
    expect(await codeOf(setup('suspended').codes.getMyCode(M))).toBe('not_found')
  })
})
