import { KIGALI_DEMO_ACCOUNTS, KIGALI_DEMO_PASSWORD } from '@/lib/demoAccounts'
import { addExactDecimals, formatExactDecimal, parseExactDecimal } from '@/lib/exactDecimal'
import { DEMO_PASSWORD } from '../sampleAccounts'
import { initialiseDemoData, rebaseSeedDates } from '../demoData'
import { MOCK_STORAGE_KEYS } from '../mockStorageKeys'
import { KIGALI_SEEDS, SAMPLE_SEEDS, type MockSeedSet } from '../seeds'
import { createMemoryStorage } from '../mockAuthStore'
import { KD_ITEM_IDS } from './commerce'
import { KD, KD_PEOPLE } from './organization'

const S = KIGALI_SEEDS

describe('the Kigali Demo Supermarket fixtures are what the demo promises', () => {
  it('is one business with three branches, three people, ten goods, two services and three payment points', () => {
    expect(S.merchants).toHaveLength(1)
    expect(S.merchants[0]).toMatchObject({ tradingName: 'Kigali Demo Supermarket', id: KD.merchantId, operatingMode: 'BUSINESS' })
    expect(S.branches.map((b) => b.name)).toEqual(['Kigali Main', 'Remera', 'Kimironko'])
    expect(S.users.map((u) => u.email)).toEqual(KIGALI_DEMO_ACCOUNTS.map((a) => a.email))
    expect(S.memberships.map((m) => m.role)).toEqual(['OWNER', 'MANAGER', 'CASHIER'])
    expect(S.catalogItems.filter((i) => i.itemType === 'GOODS')).toHaveLength(10)
    expect(S.catalogItems.filter((i) => i.itemType === 'SERVICE')).toHaveLength(2)
    expect(S.entryDevices.map((d) => d.deviceType).sort()).toEqual(['NFC_BRACELET', 'STATIC_QR', 'STATIC_QR'])
    expect(S.posDrafts).toHaveLength(2)
    expect(S.posDrafts.every((d) => d.status === 'DRAFT')).toBe(true)
  })

  it('has opening stock at every branch for goods only, and every balance is exactly the sum of its immutable movements', () => {
    const goods = new Set(S.catalogItems.filter((i) => i.itemType === 'GOODS').map((i) => i.id))
    for (const branch of S.branches) {
      expect(S.inventoryBalances.filter((b) => b.branchId === branch.id).length).toBeGreaterThan(0)
    }
    for (const balance of S.inventoryBalances) {
      expect(goods.has(balance.itemId)).toBe(true)
      const movements = S.inventoryMovements.filter((m) => m.branchId === balance.branchId && m.itemId === balance.itemId).sort((a, b) => a.seq - b.seq)
      expect(movements[0]!.movementType).toBe('OPENING')
      let running = parseExactDecimal('0')!
      for (const movement of movements) {
        running = addExactDecimals(running, parseExactDecimal(movement.quantityDelta)!)
        expect(movement.balanceAfter).toBe(formatExactDecimal(running))
      }
      expect(balance.quantityOnHand).toBe(formatExactDecimal(running))
    }
    // Every good is on the shelf somewhere.
    expect(new Set(S.inventoryBalances.map((b) => b.itemId))).toEqual(goods)
  })

  it('keeps people, branches, carts and payment points consistent with each other', () => {
    const branchIds = new Set(S.branches.map((b) => b.id))
    const membershipByUser = new Map(S.memberships.map((m) => [m.userId, m]))
    const assignedBranches = (userId: string) =>
      new Set(S.branchAssignments.filter((a) => a.membershipId === membershipByUser.get(userId)!.id && a.status === 'ACTIVE').map((a) => a.branchId))
    for (const a of S.branchAssignments) {
      expect(branchIds.has(a.branchId)).toBe(true)
      expect(S.memberships.some((m) => m.id === a.membershipId)).toBe(true)
    }
    // The cashier sees one branch; the manager two; the owner all three.
    expect([...assignedBranches(KD.users.cashier)]).toEqual([KD.branches.main])
    expect(assignedBranches(KD.users.manager).size).toBe(2)
    expect(assignedBranches(KD.users.owner).size).toBe(3)

    for (const draft of S.posDrafts) {
      expect(assignedBranches(draft.createdByUserId).has(draft.branchId)).toBe(true)
      expect(draft.totalRwf).toBe(draft.lines.reduce((total, l) => total + l.lineTotalRwf, 0))
      for (const line of draft.lines) {
        const item = S.catalogItems.find((i) => i.id === line.itemId)!
        expect(line.unitPriceRwf).toBe(item.pricePerSaleUnitRwf)
        expect(line.priceVersion).toBe(item.priceVersion)
        expect(line.lineTotalRwf).toBe(Number(line.quantityInSaleUnit) * item.pricePerSaleUnitRwf)
      }
    }
    for (const device of S.entryDevices) {
      expect(branchIds.has(device.branchId)).toBe(true)
      if (device.cashierUserId) expect(assignedBranches(device.cashierUserId).has(device.branchId)).toBe(true)
      expect(device.token).toMatch(/^[A-Za-z0-9_-]{22}$/)
      expect(S.entryDeviceAssignments.some((a) => a.deviceId === device.id && a.validTo === null)).toBe(true)
    }
    expect(new Set(S.entryDevices.map((d) => d.token)).size).toBe(3)
  })

  it('has a ledger that is simulated, in RWF, and adds up: payments, allocations, invoices and requests agree', () => {
    for (const t of S.bankTransactions) {
      expect(t).toMatchObject({ isSimulated: true, provider: 'EQUITY_MOCK', currency: 'RWF', merchantId: KD.merchantId })
      expect(t.providerTransactionId).toMatch(/^SIM-/)
    }
    expect(S.bankConnections.every((c) => c.isSimulated)).toBe(true)
    expect(S.paymentDestinations.every((d) => d.isSimulated)).toBe(true)
    for (const invoice of S.invoices) {
      expect(invoice.currency).toBe('RWF')
      expect(invoice.merchantId).toBe(KD.merchantId)
      expect(S.branches.some((b) => b.id === invoice.branchId)).toBe(true)
      expect(S.users.some((u) => u.id === invoice.createdByUserId)).toBe(true)
      expect(invoice.grandTotal).toBe(invoice.subtotal - invoice.discountTotal + invoice.taxTotal)
      const allocated = S.paymentAllocations.filter((a) => a.invoiceId === invoice.id && a.allocationStatus === 'ACTIVE').reduce((s, a) => s + a.amount, 0)
      expect(allocated).toBeLessThanOrEqual(invoice.grandTotal)
      if (invoice.paymentStatus === 'PAID') expect(allocated).toBe(invoice.grandTotal)
      if (invoice.paymentStatus === 'PARTIALLY_PAID') {
        expect(allocated).toBeGreaterThan(0)
        expect(allocated).toBeLessThan(invoice.grandTotal)
      }
      if (invoice.paymentStatus === 'UNPAID') expect(allocated).toBe(0)
    }
    for (const allocation of S.paymentAllocations) {
      const t = S.bankTransactions.find((x) => x.id === allocation.bankTransactionId)!
      expect(t.status).toBe('CONFIRMED')
      expect(allocation.amount).toBeLessThanOrEqual(t.amount)
    }
    // A transaction is never allocated more than it brought.
    for (const t of S.bankTransactions) {
      expect(S.paymentAllocations.filter((a) => a.bankTransactionId === t.id).reduce((s, a) => s + a.amount, 0)).toBeLessThanOrEqual(t.amount)
    }
    for (const request of S.paymentRequests) {
      const profile = S.paymentProfiles.find((p) => p.id === request.paymentProfileId)!
      expect(S.paymentDestinations.some((d) => d.id === profile.paymentDestinationId)).toBe(true)
      if (request.invoiceId) expect(S.invoices.find((i) => i.id === request.invoiceId)!.grandTotal).toBe(request.requestedAmount)
      // Any transaction tied to a request is for exactly that request's amount.
      for (const t of S.bankTransactions.filter((x) => x.paymentRequestId === request.id)) expect(t.amount).toBe(request.requestedAmount)
    }
    // Audit lines refer to real transactions and invoices.
    for (const entry of S.auditEntries) {
      expect(S.bankTransactions.some((t) => t.id === entry.bankTransactionId)).toBe(true)
      if (entry.invoiceId) expect(S.invoices.some((i) => i.id === entry.invoiceId)).toBe(true)
    }
  })

  it('never presents a made-up payment as an Equity confirmation and never ships a real code or approval', () => {
    for (const code of S.collectionCodes) {
      expect(code.merchantId).toBe(KD.merchantId)
      expect(S.branches.some((b) => b.id === code.branchId)).toBe(true)
      // Every code is simulated, on the simulated account: nothing here is a real Equity code or approval.
      expect(code.simulated).toBe(true)
      expect(S.paymentDestinations.find((d) => d.id === code.settlementDestinationId)!.isSimulated).toBe(true)
      expect(code.settlementAccountLabel).toMatch(/simulated/i)
      if (code.approval) expect(code.approval.evidenceRef).toMatch(/SIMULATED/)
      if (code.externalCode) expect(code.externalCode).toMatch(/^SIM-/)
    }
    for (const assignment of S.collectionCodeAssignments) {
      const code = S.collectionCodes.find((c) => c.id === assignment.codeId)!
      expect(code).toBeDefined()
      expect(assignment.branchId).toBe(code.branchId)
      // A person who holds a code works at its branch.
      if (assignment.assigneeKind === 'MEMBER') {
        expect(S.branchAssignments.some((a) => a.membershipId === assignment.membershipId && a.branchId === assignment.branchId && a.status === 'ACTIVE')).toBe(true)
      }
    }
    const text = JSON.stringify(S)
    expect(text).not.toMatch(/isSimulated":false/)
    expect(text).not.toMatch(/"provider":"EQUITY"/)
  })

  it('shares nothing with the ordinary sample set: no sample id, name or account leaks into the demo, and every record belongs to the demo business', () => {
    const text = JSON.stringify(S)
    expect(text).not.toMatch(/mrc-sample|usr-sample|brn-sample|Sample Shop|"owner@oupay\.demo|bcn-sample/)
    const merchantIds = new Set<string>()
    for (const collection of Object.values(S) as Record<string, unknown>[][]) {
      for (const record of collection) {
        if ('merchantId' in record) merchantIds.add(record.merchantId as string)
      }
    }
    expect([...merchantIds]).toEqual([KD.merchantId])
    // And the ordinary set is untouched by the demo's existence.
    expect(SAMPLE_SEEDS.merchants[0]!.id).toBe('mrc-sample-001')
    expect(SAMPLE_SEEDS.posDrafts).toEqual([])
  })

  it('uses the same public demo password as the mock sign-in, and lists exactly the three accounts', () => {
    expect(KIGALI_DEMO_PASSWORD).toBe(DEMO_PASSWORD)
    expect(KIGALI_DEMO_ACCOUNTS.map((a) => a.role)).toEqual(['Owner', 'Manager', 'Cashier'])
    expect(KD_PEOPLE.cashier.name).toBe('Patrick Nsengimana')
    expect(KD_ITEM_IDS.rice).toBe('kd-cat-rice')
  })
})

describe('first-open initialisation of the demo data', () => {
  const allKeys = (Object.keys(S) as (keyof MockSeedSet)[]).map((collection) => MOCK_STORAGE_KEYS[collection])

  it('writes every collection exactly once, the first time, and never again', () => {
    const storage = createMemoryStorage()
    expect(initialiseDemoData(storage, S, () => new Date('2026-11-07T10:00:00Z'))).toBe(true)
    for (const key of allKeys) expect(storage.getItem(key)).not.toBeNull()
    expect(storage.getItem(MOCK_STORAGE_KEYS.demoInitialisedAt)).toBe('2026-11-07T10:00:00.000Z')

    // A person edits something; a "refresh" (a second initialisation) must not put the example back.
    storage.setItem(MOCK_STORAGE_KEYS.branches, JSON.stringify([{ id: 'mine' }]))
    expect(initialiseDemoData(storage, S)).toBe(false)
    expect(storage.getItem(MOCK_STORAGE_KEYS.branches)).toBe(JSON.stringify([{ id: 'mine' }]))
  })

  it('keeps every example record in the demo namespace only', () => {
    expect(MOCK_STORAGE_KEYS.users).toMatch(/^oupay\.(mock|demo)\./)
    // Under test the build is not the demo, so the ordinary namespace is in use; the demo keys are asserted in demoMode.test.ts.
    expect(allKeys.every((k) => k.startsWith('oupay.'))).toBe(true)
  })
})

describe('the example dates move with the day the demo is opened', () => {
  const sample = { createdAt: '2026-11-05T09:42:00+02:00', dueAt: '2026-11-18', note: 'OP-DEMOKDS01', amount: 12600, nested: [{ at: '2026-10-21T10:05:00+02:00' }] }

  it('shifts date-times and dates by whole days, and leaves everything else exactly as it was', () => {
    const moved = rebaseSeedDates(sample, 10)
    expect(moved.createdAt).toBe('2026-11-15T07:42:00.000Z')
    expect(moved.dueAt).toBe('2026-11-28')
    expect(moved.note).toBe('OP-DEMOKDS01')
    expect(moved.amount).toBe(12600)
    expect(moved.nested[0]!.at).toBe('2026-10-31T08:05:00.000Z')
  })

  it('keeps the order and the gaps between records, and does nothing when the demo is opened on or before its own day', () => {
    const [a, b] = [rebaseSeedDates({ t: '2026-10-21T10:05:00+02:00' }, 400).t, rebaseSeedDates({ t: '2026-11-05T09:42:00+02:00' }, 400).t]
    expect(Date.parse(b) - Date.parse(a)).toBe(Date.parse('2026-11-05T09:42:00+02:00') - Date.parse('2026-10-21T10:05:00+02:00'))
    expect(rebaseSeedDates(sample, 0)).toBe(sample)
    expect(rebaseSeedDates(sample, -3)).toBe(sample)
  })

  it('writes shifted dates when the demo is first opened a year later, and the newest example is then recent', () => {
    const storage = createMemoryStorage()
    initialiseDemoData(storage, S, () => new Date('2027-11-07T08:00:00+02:00'))
    const invoices = JSON.parse(storage.getItem(MOCK_STORAGE_KEYS.invoices)!) as { issuedAt?: string; createdAt: string }[]
    const newest = Math.max(...invoices.map((i) => Date.parse(i.createdAt)))
    expect(new Date('2027-11-07T08:00:00+02:00').getTime() - newest).toBeLessThan(3 * 86_400_000)
  })
})
