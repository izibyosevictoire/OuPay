import {
  COLLECTION_CODE_STATUS_HINTS,
  COLLECTION_CODE_STATUS_LABELS,
  ELIGIBILITY_ISSUE_LABELS,
} from '@/constants/collectionCodes'
import { createTestBackend } from '@/test/merchantTestDouble'
import { SAMPLE_COLLECTION_CODES } from './sampleCollectionCodes'
import { MOCK_STORAGE_KEYS } from './mockStorageKeys'
import { SAMPLE_MERCHANT_ID } from './sampleMerchants'
import { SAMPLE_BRANCH_IDS } from './sampleOrganization'

const M = SAMPLE_MERCHANT_ID
const COUNTER = 'cc-sample-001' // ACTIVE, bank-issued code, real account, held by Aline (mem-004) at Remera
const DECLARED = 'cc-sample-002' // REQUEST_DECLARED
const REQUESTED = 'cc-sample-003' // REQUESTED
const SIMULATED = 'cc-sample-005' // ACTIVE on a simulated account
const ALINE = 'mem-004'
const ALINE_USER = 'usr-demo-cashier'
const NOW = '2026-09-20T10:00:00+02:00'

function setup(
  signedInAs: Parameters<ReturnType<typeof createTestBackend>['signInAs']>[0] = 'owner',
) {
  const backend = createTestBackend()
  backend.signInAs(signedInAs)
  return { ...backend, codes: backend.fastCollectionCodes }
}
type Setup = ReturnType<typeof setup>

const issuesOf = async (s: Setup, id = COUNTER) => (await s.codes.getCode(M, id)).eligibilityIssues

const setMembership = (s: Setup, status: 'SUSPENDED' | 'REVOKED') =>
  s.store.saveMemberships(
    s.store.loadMemberships().map((m) => (m.id === ALINE ? { ...m, status } : m)),
  )

const endAlineAtRemera = (s: Setup) =>
  s.store.saveBranchAssignments(
    s.store
      .loadBranchAssignments()
      .map((a) =>
        a.membershipId === ALINE && a.branchId === SAMPLE_BRANCH_IDS.remera
          ? { ...a, status: 'ENDED' as const, endedAt: NOW }
          : a,
      ),
  )

describe('eligibility for collection is computed live', () => {
  it('is eligible only when every condition holds', async () => {
    const code = await setup().codes.getCode(M, COUNTER)
    expect(code).toMatchObject({ bankProvisioned: true, payable: true, eligibilityIssues: [] })
  })

  it('stops when the holder is suspended or revoked, while the history is exactly as it was', async () => {
    for (const status of ['SUSPENDED', 'REVOKED'] as const) {
      const s = setup()
      const before = (await s.codes.listAssignments(M, COUNTER)).items
      setMembership(s, status)
      const code = await s.codes.getCode(M, COUNTER)
      expect(code.bankProvisioned).toBe(true)
      expect(code.payable).toBe(false)
      expect(code.eligibilityIssues).toEqual(['ASSIGNEE_NOT_ACTIVE'])
      // The open assignment record is untouched: only the live status shown beside it differs.
      expect(code.currentAssignment).toMatchObject({ assigneeName: 'Aline Uwase', validTo: null })
      const after = (await s.codes.listAssignments(M, COUNTER)).items
      const frozen = (rows: typeof before) =>
        rows.map((a) => ({ ...a, assigneeCurrentStatus: null }))
      expect(frozen(after)).toEqual(frozen(before))
    }
  })

  it('stops when the holder’s user account is not active', async () => {
    const s = setup()
    s.store.saveUsers(
      s.store
        .loadUsers()
        .map((u) => (u.id === ALINE_USER ? { ...u, status: 'SUSPENDED' as const } : u)),
    )
    expect(await issuesOf(s)).toEqual(['ASSIGNEE_NOT_ACTIVE'])
  })

  it('stops when the branch is inactive', async () => {
    const s = setup()
    s.store.saveBranches(
      s.store
        .loadBranches()
        .map((b) =>
          b.id === SAMPLE_BRANCH_IDS.remera ? { ...b, status: 'INACTIVE' as const } : b,
        ),
    )
    expect(await issuesOf(s)).toContain('BRANCH_INACTIVE')
    expect((await s.codes.getCode(M, COUNTER)).payable).toBe(false)
  })

  it('stops when the holder no longer works at the branch', async () => {
    const s = setup()
    endAlineAtRemera(s)
    expect(await issuesOf(s)).toEqual(['ASSIGNEE_NOT_AT_BRANCH'])
  })

  it('stops when the settlement account is disconnected', async () => {
    const s = setup()
    // A real settlement account whose connection can change (the sample code uses a fictional, always-connected one).
    s.ledger.bankConnections.save([
      ...s.ledger.bankConnections.load(),
      {
        id: 'bcn-real',
        merchantId: M,
        providerId: 'EQUITY_MOCK',
        status: 'CONNECTED',
        accountNickname: 'Real',
        bankAccountId: 'acct-real',
        maskedAccount: '••••1111',
        isSimulated: false,
        lastError: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ])
    s.ledger.paymentDestinations.save([
      ...s.ledger.paymentDestinations.load(),
      {
        id: 'dst-real',
        merchantId: M,
        bankConnectionId: 'bcn-real',
        label: 'Real',
        bankAccountId: 'acct-real',
        maskedAccount: '••••1111',
        providerId: 'EQUITY_MOCK',
        isSimulated: false,
        createdAt: NOW,
      },
    ])
    s.store.saveRecords(
      MOCK_STORAGE_KEYS.collectionCodes,
      s.store
        .loadRecords<{ id: string; settlementDestinationId: string }>(
          MOCK_STORAGE_KEYS.collectionCodes,
          SAMPLE_COLLECTION_CODES,
        )
        .map((c) => (c.id === COUNTER ? { ...c, settlementDestinationId: 'dst-real' } : c)),
    )
    expect((await s.codes.getCode(M, COUNTER)).payable).toBe(true)
    s.ledger.bankConnections.save(
      s.ledger.bankConnections
        .load()
        .map((c) => (c.id === 'bcn-real' ? { ...c, status: 'DISABLED' as const } : c)),
    )
    expect(await issuesOf(s)).toEqual(['SETTLEMENT_ACCOUNT_NOT_CONNECTED'])
  })

  it('needs a holder, and a collection point has no person to check', async () => {
    const s = setup()
    const current = (await s.codes.getCode(M, COUNTER)).currentAssignment!
    await s.codes.endAssignment(M, COUNTER, { expectedAssignmentId: current.id, reason: 'Moved' })
    expect(await issuesOf(s)).toEqual(['NOT_ASSIGNED'])
    await s.codes.assign(M, COUNTER, { collectionPointLabel: 'Counter 2' })
    expect(await issuesOf(s)).toEqual([])
    // Aline being suspended changes nothing for a collection point.
    setMembership(s, 'SUSPENDED')
    expect((await s.codes.getCode(M, COUNTER)).payable).toBe(true)
  })

  it('never makes a simulated code eligible, whatever else is true', async () => {
    const s = setup()
    const code = await s.codes.getCode(M, SIMULATED)
    expect(code).toMatchObject({ bankProvisioned: false, payable: false })
    expect(code.eligibilityIssues).toContain('SIMULATED')
    expect(code.eligibilityIssues).not.toContain('NOT_BANK_APPROVED')
    const created = await s.codes.requestCode(M, {
      clientOperationId: 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001',
      settlementDestinationId: 'dst-sample-001',
      displayLabel: 'Fresh',
    })
    expect(created.code.payable).toBe(false)
    expect(created.code.eligibilityIssues).toEqual(
      expect.arrayContaining(['SIMULATED', 'NOT_BANK_APPROVED', 'NOT_ASSIGNED']),
    )
  })

  it('lists every reason a code that has not been provisioned is not eligible', async () => {
    const s = setup()
    expect(await issuesOf(s, REQUESTED)).toEqual(['SIMULATED', 'NOT_BANK_APPROVED', 'NOT_ASSIGNED'])
    expect((await s.codes.getCode(M, REQUESTED)).bankProvisioned).toBe(false)
  })
})

describe('evidence and bank references are for owners only', () => {
  it('gives owners the evidence reference and the declared reference', async () => {
    const owner = setup()
    expect((await owner.codes.getCode(M, COUNTER)).approval).toEqual({
      source: 'OPERATOR',
      approvedAt: expect.any(String),
      evidenceRef: 'DEMO-EVIDENCE-0001',
    })
    expect((await owner.codes.getCode(M, DECLARED)).bankRequestRef).toBe('EQ-REQ-DEMO-0002')
  })

  it('never gives a manager an evidence reference or a bank reference, in any answer', async () => {
    const manager = setup('manager')
    expect((await manager.codes.getCode(M, COUNTER)).approval).toEqual({
      source: 'OPERATOR',
      approvedAt: expect.any(String),
      evidenceRef: null,
    })
    expect((await manager.codes.getCode(M, DECLARED)).bankRequestRef).toBeNull()
    const everything = JSON.stringify([
      await manager.codes.listCodes(M),
      await manager.codes.getCode(M, COUNTER),
      await manager.codes.getCode(M, DECLARED),
      await manager.codes.listAssignments(M, COUNTER),
      await manager.codes.getOptions(M),
      await manager.codes.getMyCode(M),
    ])
    expect(everything).not.toContain('DEMO-EVIDENCE-0001')
    expect(everything).not.toContain('SIMULATED-EVIDENCE')
    expect(everything).not.toContain('EQ-REQ-DEMO')
  })

  it('never gives an agent evidence, a bank reference or the internal reference', async () => {
    const mine = JSON.stringify(await setup('cashier').codes.getMyCode(M))
    expect(mine).not.toContain('EVIDENCE')
    expect(mine).not.toContain('EQ-REQ')
    expect(mine).not.toContain('CC-7KQ2M9XA')
  })

  it('shows only masked account identifiers', async () => {
    const owner = setup()
    const everything = JSON.stringify([
      await owner.codes.listCodes(M),
      await owner.codes.getOptions(M),
    ])
    expect(everything).not.toMatch(/acct-|bankAccountId|providerAccountId/)
    for (const code of (await owner.codes.listCodes(M)).items) {
      expect(code.settlementAccountMasked).toMatch(/^••••[0-9]{4}$/)
    }
  })
})

describe('my code follows eligibility', () => {
  it('shows no code value when the code is not eligible, and says why in plain words', async () => {
    const s = setup()
    s.store.saveBranches(
      s.store
        .loadBranches()
        .map((b) =>
          b.id === SAMPLE_BRANCH_IDS.remera ? { ...b, status: 'INACTIVE' as const } : b,
        ),
    )
    s.signInAs('cashier')
    const mine = await s.codes.getMyCode(M)
    expect(mine.code).toMatchObject({ payable: false, externalCode: null })
    expect(mine.code?.message).toMatch(/branch is not active/)
    expect(JSON.stringify(mine)).not.toContain('DEMO-ILLUSTRATIVE-001')
  })

  it('shows the code value only while it is eligible', async () => {
    const s = setup('cashier')
    expect((await s.codes.getMyCode(M)).code).toMatchObject({
      payable: true,
      externalCode: 'DEMO-ILLUSTRATIVE-001',
    })
    endAlineAtRemera(s)
    const mine = await s.codes.getMyCode(M)
    expect(mine.code).toMatchObject({ payable: false, externalCode: null })
    expect(mine.code?.message).toMatch(/no longer assigned/)
  })
})

describe('wording never implies Equity acknowledged anything', () => {
  const IMPLIES =
    /\b(received|receiving|reviewing|under review|accepted|processing|in progress|awaiting equity|pending)\b/i

  it('keeps every status label, hint and eligibility reason free of such claims', () => {
    const statuses = Object.keys(
      COLLECTION_CODE_STATUS_LABELS,
    ) as (keyof typeof COLLECTION_CODE_STATUS_LABELS)[]
    for (const status of statuses) {
      expect(COLLECTION_CODE_STATUS_LABELS[status]).not.toMatch(IMPLIES)
      expect(COLLECTION_CODE_STATUS_HINTS[status]).not.toMatch(IMPLIES)
    }
    expect(COLLECTION_CODE_STATUS_LABELS.REQUEST_DECLARED).toBe(
      'Request declared by owner (not confirmed by Equity)',
    )
    for (const label of Object.values(ELIGIBILITY_ISSUE_LABELS)) expect(label).not.toMatch(IMPLIES)
  })

  it('keeps every message an agent can be shown free of such claims', async () => {
    const s = setup()
    const messages: string[] = []
    const agentMessage = async () => {
      s.signInAs('cashier')
      const mine = await s.codes.getMyCode(M)
      s.signInAs('owner')
      return mine.code?.message ?? ''
    }
    messages.push(await agentMessage()) // eligible
    // Make the two unprovisioned sample codes look like real-account codes, so their own wording is what is shown.
    s.store.saveRecords(
      MOCK_STORAGE_KEYS.collectionCodes,
      s.store
        .loadRecords<{ id: string }>(MOCK_STORAGE_KEYS.collectionCodes, SAMPLE_COLLECTION_CODES)
        .map((c) => (c.id === REQUESTED || c.id === DECLARED ? { ...c, simulated: false } : c)),
    )
    const move = async (from: string, to: string) => {
      const current = (await s.codes.getCode(M, from)).currentAssignment!
      await s.codes.endAssignment(M, from, { expectedAssignmentId: current.id, reason: 'Moving' })
      await s.codes.assign(M, to, { membershipId: ALINE })
    }
    await move(COUNTER, REQUESTED) // only requested inside OuPay
    messages.push(await agentMessage())
    await move(REQUESTED, DECLARED) // the owner declared a request
    messages.push(await agentMessage())
    expect(messages.every((m) => m.length > 0)).toBe(true)
    for (const message of messages) expect(message).not.toMatch(IMPLIES)
    expect(messages[2]).toMatch(/OuPay has no confirmation from Equity/)
    expect(messages[1]).toMatch(/requested inside OuPay only/)
  })
})
