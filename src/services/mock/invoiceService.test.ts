import { totalsAreConsistent } from '@/lib/invoiceCalculations'
import { todayInKigali } from '@/lib/invoiceLifecycle'
import type { InvoiceDraftInput, InvoiceItemInput, TaxRate } from '@/types/invoice'
import { createMockAuthService } from './mockAuthService'
import { createMemoryStorage, createMockAuthStore } from './mockAuthStore'
import { createMockBranchService } from './mockBranchService'
import { createMockInvoiceService } from './mockInvoiceService'
import { createMockStaffService } from './mockStaffService'
import { DEMO_USER_IDS } from './sampleAccounts'
import { SAMPLE_BRANCH_IDS } from './sampleOrganization'
import { SAMPLE_MERCHANT_ID, SAMPLE_SECOND_MERCHANT_ID } from './sampleMerchants'

type DemoUser = keyof typeof DEMO_USER_IDS

const VAT_18: TaxRate = { category: 'STANDARD', rateBp: 1800 }
const NO_VAT: TaxRate = { category: 'NOT_APPLICABLE', rateBp: 0 }

function createHarness(signedInAs: DemoUser | null = 'owner') {
  const store = createMockAuthStore({
    persistentStorage: createMemoryStorage(),
    sessionStorage: createMemoryStorage(),
  })
  if (signedInAs) store.startSession(DEMO_USER_IDS[signedInAs], false, 60_000)
  const merchantStorage = createMemoryStorage()
  return {
    store,
    invoices: createMockInvoiceService({
      authStore: store,
      merchantStorage,
      delayInMilliseconds: 0,
    }),
    branches: createMockBranchService({ authStore: store, delayInMilliseconds: 0 }),
    staff: createMockStaffService({ authStore: store, merchantStorage, delayInMilliseconds: 0 }),
    auth: createMockAuthService({ store, delayInMilliseconds: 0 }),
    signInAs: (user: DemoUser) => store.startSession(DEMO_USER_IDS[user], false, 60_000),
  }
}

const item = (overrides: Partial<InvoiceItemInput> = {}): InvoiceItemInput => ({
  description: 'Consulting',
  quantity: 2,
  unitPrice: 10_000,
  discount: 0,
  taxRate: NO_VAT,
  ...overrides,
})

const nextWeek = () => {
  const date = new Date()
  date.setDate(date.getDate() + 7)
  return todayInKigali(date)
}

/** A valid draft by Aline (cashier) at Remera Main. */
const draftInput = (overrides: Partial<InvoiceDraftInput> = {}): InvoiceDraftInput => ({
  branchId: SAMPLE_BRANCH_IDS.remera,
  assignedToUserId: DEMO_USER_IDS.cashier,
  customer: { name: 'Mama Jane Shop' },
  items: [item()],
  taxMode: 'EXCLUSIVE',
  dueAt: nextWeek(),
  ...overrides,
})

describe('listing and reading', () => {
  it('gives owners and managers every invoice of the merchant, newest first', async () => {
    for (const user of ['owner', 'manager'] as const) {
      const { invoices } = createHarness(user)
      const page = await invoices.listInvoices(SAMPLE_MERCHANT_ID)
      expect(page.totalCount).toBe(7)
      expect(page.nextCursor).toBeNull()
      expect(page.items[0]?.invoiceNumber).toBe('SMP-INV-1040')
      expect(page.items.every((invoice) => invoice.merchantId === SAMPLE_MERCHANT_ID)).toBe(true)
    }
  })

  it('gives a cashier only the invoices assigned to them', async () => {
    const { invoices } = createHarness('cashier')
    const page = await invoices.listInvoices(SAMPLE_MERCHANT_ID)
    expect(page.items.map((i) => i.invoiceNumber).sort()).toEqual([
      'SMP-INV-1040',
      'SMP-INV-1041',
      'SMP-INV-1042',
      'SMP-INV-1043',
      'SMP-INV-1045',
      'SMP-INV-1046',
    ])
    expect(page.items.every((i) => i.assignedToUserId === DEMO_USER_IDS.cashier)).toBe(true)
  })

  it('hides other cashiers’ invoices as if they did not exist', async () => {
    const { invoices } = createHarness('cashier')
    const others = (
      await createHarness('owner').invoices.listInvoices(SAMPLE_MERCHANT_ID)
    ).items.find((i) => i.invoiceNumber === 'SMP-INV-1044')!
    await expect(invoices.getInvoice(SAMPLE_MERCHANT_ID, others.id)).rejects.toMatchObject({
      code: 'not_found',
    })
  })

  it('supports the pagination-shaped request contract', async () => {
    const { invoices } = createHarness()
    const page = await invoices.listInvoices(SAMPLE_MERCHANT_ID, { limit: 2 })
    expect(page.items).toHaveLength(2)
    expect(page.totalCount).toBe(7)
  })

  it('never serves one merchant’s invoices through another', async () => {
    const { invoices, signInAs } = createHarness()
    // The owner belongs to both businesses; each id returns only its own data.
    const cafe = await invoices.listInvoices(SAMPLE_SECOND_MERCHANT_ID)
    expect(cafe.items.map((i) => i.invoiceNumber)).toEqual(['SMP-CAFE-2001'])
    const shopInvoice = (await invoices.listInvoices(SAMPLE_MERCHANT_ID)).items[0]!
    await expect(
      invoices.getInvoice(SAMPLE_SECOND_MERCHANT_ID, shopInvoice.id),
    ).rejects.toMatchObject({
      code: 'not_found',
    })
    signInAs('cafeOwner')
    await expect(invoices.listInvoices(SAMPLE_MERCHANT_ID)).rejects.toMatchObject({
      code: 'not_found',
    })
    await expect(invoices.getInvoice(SAMPLE_MERCHANT_ID, shopInvoice.id)).rejects.toMatchObject({
      code: 'not_found',
    })
    await expect(invoices.createDraft(SAMPLE_MERCHANT_ID, draftInput())).rejects.toMatchObject({
      code: 'not_found',
    })
  })

  it('requires sign-in and refuses suspended or revoked members', async () => {
    await expect(
      createHarness(null).invoices.listInvoices(SAMPLE_MERCHANT_ID),
    ).rejects.toMatchObject({
      code: 'unauthenticated',
    })
    for (const user of ['suspended', 'revoked'] as const) {
      await expect(
        createHarness(user).invoices.listInvoices(SAMPLE_MERCHANT_ID),
      ).rejects.toMatchObject({
        code: 'not_found',
      })
    }
  })

  it('stores totals that satisfy the documented identity', async () => {
    const { items } = await createHarness().invoices.listInvoices(SAMPLE_MERCHANT_ID)
    for (const invoice of items) expect(totalsAreConsistent(invoice, invoice.taxMode)).toBe(true)
  })
})

describe('creating drafts', () => {
  it('creates a draft with server-computed totals, snapshots and a unique number', async () => {
    const { invoices } = createHarness()
    const draft = await invoices.createDraft(
      SAMPLE_MERCHANT_ID,
      draftInput({ items: [item({ quantity: 3, unitPrice: 1000, taxRate: VAT_18 })] }),
    )
    expect(draft).toMatchObject({
      status: 'DRAFT',
      paymentStatus: 'UNPAID',
      currency: 'RWF',
      version: 1,
      subtotal: 3000,
      taxTotal: 540,
      grandTotal: 3540,
      createdByUserId: DEMO_USER_IDS.owner,
      assignedToUserId: DEMO_USER_IDS.cashier,
      assignedToName: 'Aline Uwase',
    })
    expect(draft.invoiceNumber).toBe('INV-1047') // after the highest seeded number
    expect(draft.merchantSnapshot.legalName).toBe('Sample Business Ltd')
    expect(draft.branchSnapshot).toMatchObject({ name: 'Remera Main', code: 'RM01' })
    expect(draft.issuedAt).toBeUndefined()
  })

  it('never lets a draft start out paid, whatever it is asked', async () => {
    const { invoices } = createHarness()
    const forged = {
      ...draftInput(),
      paymentStatus: 'PAID',
      status: 'ISSUED',
      grandTotal: 1,
    } as unknown as InvoiceDraftInput
    const draft = await invoices.createDraft(SAMPLE_MERCHANT_ID, forged)
    expect(draft.paymentStatus).toBe('UNPAID')
    expect(draft.status).toBe('DRAFT')
    expect(draft.grandTotal).toBe(20_000) // recomputed, client total ignored
  })

  it('numbers invoices sequentially per merchant and never reuses a number', async () => {
    const { invoices } = createHarness()
    const first = await invoices.createDraft(SAMPLE_MERCHANT_ID, draftInput())
    await invoices.cancelDraft(SAMPLE_MERCHANT_ID, first.id, first.version)
    const second = await invoices.createDraft(SAMPLE_MERCHANT_ID, draftInput())
    expect(first.invoiceNumber).toBe('INV-1047')
    expect(second.invoiceNumber).toBe('INV-1048')
  })

  it.each([
    ['a missing customer name', { customer: { name: '  ' } }],
    ['no items', { items: [] }],
    ['an item without description', { items: [item({ description: ' ' })] }],
    ['a zero quantity', { items: [item({ quantity: 0 })] }],
    ['a quantity with 4 decimals', { items: [item({ quantity: 1.2345 })] }],
    ['a fractional price', { items: [item({ unitPrice: 10.5 })] }],
    ['a negative price', { items: [item({ unitPrice: -5 })] }],
    [
      'a discount above the line amount',
      { items: [item({ quantity: 1, unitPrice: 100, discount: 101 })] },
    ],
    [
      'an out-of-range tax rate',
      { items: [item({ taxRate: { category: 'STANDARD', rateBp: 20_000 } })] },
    ],
    ['a bad due date', { dueAt: 'tomorrow' }],
    ['a bad customer email', { customer: { name: 'A', email: 'nope' } }],
    ['a bad customer TIN', { customer: { name: 'A', tin: '123' } }],
  ])('rejects %s', async (_label, override) => {
    const { invoices } = createHarness()
    await expect(
      invoices.createDraft(SAMPLE_MERCHANT_ID, draftInput(override)),
    ).rejects.toMatchObject({
      code: 'validation',
    })
  })

  it('allows incomplete-but-valid drafts that could not be issued yet (zero price)', async () => {
    const { invoices } = createHarness()
    const draft = await invoices.createDraft(
      SAMPLE_MERCHANT_ID,
      draftInput({ items: [item({ unitPrice: 0 })] }),
    )
    expect(draft.grandTotal).toBe(0)
    await expect(
      invoices.issueInvoice(SAMPLE_MERCHANT_ID, draft.id, draft.version),
    ).rejects.toMatchObject({
      code: 'validation',
    })
  })
})

describe('branch and assignee rules', () => {
  it('refuses an inactive branch for a new invoice', async () => {
    const { invoices } = createHarness()
    await expect(
      invoices.createDraft(
        SAMPLE_MERCHANT_ID,
        draftInput({ branchId: SAMPLE_BRANCH_IDS.nyamirambo }),
      ),
    ).rejects.toMatchObject({ code: 'branch_inactive' })
  })

  it('refuses a branch of another business', async () => {
    const { invoices } = createHarness()
    await expect(
      invoices.createDraft(SAMPLE_MERCHANT_ID, draftInput({ branchId: SAMPLE_BRANCH_IDS.cafe })),
    ).rejects.toMatchObject({ code: 'validation' })
  })

  it('requires the assignee to be an ACTIVE member actively assigned to that branch', async () => {
    const { invoices } = createHarness()
    // Aline is assigned to Remera and City Centre, not elsewhere; Eric is suspended; Diane revoked.
    for (const assignedToUserId of [
      DEMO_USER_IDS.suspended,
      DEMO_USER_IDS.revoked,
      DEMO_USER_IDS.newcomer,
      'usr-ghost',
    ]) {
      await expect(
        invoices.createDraft(SAMPLE_MERCHANT_ID, draftInput({ assignedToUserId })),
      ).rejects.toMatchObject({ code: 'assignee_not_eligible' })
    }
  })

  it('lets owners and managers pick any eligible assignee, including a manager', async () => {
    for (const user of ['owner', 'manager'] as const) {
      const { invoices } = createHarness(user)
      const draft = await invoices.createDraft(
        SAMPLE_MERCHANT_ID,
        draftInput({ assignedToUserId: DEMO_USER_IDS.manager }),
      )
      expect(draft.assignedToName).toBe('Grace Mukamana')
    }
  })

  it('forces a cashier to create invoices for themselves, at their own branches', async () => {
    const { invoices } = createHarness('cashier')
    const own = await invoices.createDraft(SAMPLE_MERCHANT_ID, draftInput())
    expect(own).toMatchObject({
      createdByUserId: DEMO_USER_IDS.cashier,
      assignedToUserId: DEMO_USER_IDS.cashier,
    })
    await expect(
      invoices.createDraft(
        SAMPLE_MERCHANT_ID,
        draftInput({ assignedToUserId: DEMO_USER_IDS.manager }),
      ),
    ).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('rejects a branch the assignee is not assigned to, even when it is active', async () => {
    const { invoices, branches } = createHarness('owner')
    const created = await branches.createBranch(SAMPLE_MERCHANT_ID, {
      name: 'Kimironko',
      code: 'KIM1',
      location: {
        province: 'Kigali City',
        district: 'Gasabo',
        sector: 'Kimironko',
        physicalAddress: 'Market',
      },
      status: 'ACTIVE',
    })
    // Aline works at Remera and City Centre only.
    await expect(
      invoices.createDraft(SAMPLE_MERCHANT_ID, draftInput({ branchId: created.id })),
    ).rejects.toMatchObject({ code: 'assignee_not_eligible' })
  })

  it('offers form options limited by role: cashiers get only themselves and their branches', async () => {
    const cashier =
      await createHarness('cashier').invoices.getInvoiceFormOptions(SAMPLE_MERCHANT_ID)
    expect(cashier.assignees.map((a) => a.fullName)).toEqual(['Aline Uwase'])
    expect(cashier.branches.map((b) => b.name)).toEqual(['City Centre', 'Remera Main'])

    const owner = await createHarness('owner').invoices.getInvoiceFormOptions(SAMPLE_MERCHANT_ID)
    expect(owner.assignees.map((a) => a.fullName)).toEqual(['Aline Uwase', 'Grace Mukamana'])
    // Inactive branches are never offered.
    expect(owner.branches.map((b) => b.name)).toEqual(['City Centre', 'Remera Main'])
  })

  it('offers no options to someone without an active branch assignment', async () => {
    const { invoices, signInAs } = createHarness()
    signInAs('cafeOwner') // owner of the cafe, but not assigned to any branch
    const options = await invoices.getInvoiceFormOptions(SAMPLE_SECOND_MERCHANT_ID)
    expect(options.assignees.map((a) => a.fullName)).toEqual(['Sample Owner'])
    signInAs('suspended')
    await expect(invoices.getInvoiceFormOptions(SAMPLE_MERCHANT_ID)).rejects.toMatchObject({
      code: 'not_found',
    })
  })
})

describe('editing drafts', () => {
  it('updates content, recomputes totals, bumps the version, keeps the number and creator', async () => {
    const { invoices } = createHarness()
    const draft = await invoices.createDraft(SAMPLE_MERCHANT_ID, draftInput())
    const updated = await invoices.updateDraft(
      SAMPLE_MERCHANT_ID,
      draft.id,
      draftInput({
        customer: { name: 'New Name' },
        items: [item({ quantity: 1, unitPrice: 500 })],
      }),
      draft.version,
    )
    expect(updated).toMatchObject({
      invoiceNumber: draft.invoiceNumber,
      createdByUserId: draft.createdByUserId,
      grandTotal: 500,
      version: 2,
      status: 'DRAFT',
    })
    expect(updated.customer.name).toBe('New Name')
  })

  it('detects concurrent edits with the version', async () => {
    const { invoices } = createHarness()
    const draft = await invoices.createDraft(SAMPLE_MERCHANT_ID, draftInput())
    await invoices.updateDraft(SAMPLE_MERCHANT_ID, draft.id, draftInput(), draft.version)
    await expect(
      invoices.updateDraft(SAMPLE_MERCHANT_ID, draft.id, draftInput(), draft.version),
    ).rejects.toMatchObject({ code: 'version_conflict' })
  })

  it('does not allow issued, cancelled or voided invoices to be edited', async () => {
    const { invoices } = createHarness()
    const list = (await invoices.listInvoices(SAMPLE_MERCHANT_ID)).items
    for (const number of ['SMP-INV-1044', 'SMP-INV-1045', 'SMP-INV-1046']) {
      const target = list.find((i) => i.invoiceNumber === number)!
      await expect(
        invoices.updateDraft(SAMPLE_MERCHANT_ID, target.id, draftInput(), target.version),
      ).rejects.toMatchObject({ code: 'invalid_transition' })
    }
  })

  it('refuses to move a draft to a branch that has since become inactive', async () => {
    const { invoices, branches } = createHarness()
    const draft = await invoices.createDraft(SAMPLE_MERCHANT_ID, draftInput())
    await branches.changeBranchStatus(SAMPLE_MERCHANT_ID, SAMPLE_BRANCH_IDS.remera, 'INACTIVE')
    await expect(
      invoices.updateDraft(SAMPLE_MERCHANT_ID, draft.id, draftInput(), draft.version),
    ).rejects.toMatchObject({ code: 'branch_inactive' })
  })

  it('lets a cashier edit only their own drafts', async () => {
    const owner = createHarness('owner')
    const own = (await owner.invoices.listInvoices(SAMPLE_MERCHANT_ID)).items.find(
      (i) => i.invoiceNumber === 'SMP-INV-1040',
    )!
    owner.signInAs('cashier')
    const updated = await owner.invoices.updateDraft(
      SAMPLE_MERCHANT_ID,
      own.id,
      draftInput({ branchId: SAMPLE_BRANCH_IDS.cityCentre }),
      own.version,
    )
    expect(updated.version).toBe(2)
    // Someone else's draft looks like it does not exist.
    owner.signInAs('owner')
    const others = await owner.invoices.createDraft(
      SAMPLE_MERCHANT_ID,
      draftInput({ assignedToUserId: DEMO_USER_IDS.manager }),
    )
    owner.signInAs('cashier')
    await expect(
      owner.invoices.updateDraft(SAMPLE_MERCHANT_ID, others.id, draftInput(), others.version),
    ).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('issuing', () => {
  it('issues a draft: sets the issue date, freezes snapshots, and leaves payment UNPAID', async () => {
    const { invoices } = createHarness()
    const draft = await invoices.createDraft(SAMPLE_MERCHANT_ID, draftInput())
    const issued = await invoices.issueInvoice(SAMPLE_MERCHANT_ID, draft.id, draft.version)
    expect(issued).toMatchObject({ status: 'ISSUED', paymentStatus: 'UNPAID', version: 2 })
    expect(issued.issuedAt).toBeDefined()
    expect(issued.grandTotal).toBe(draft.grandTotal)
  })

  it('cannot issue twice, or issue a cancelled draft', async () => {
    const { invoices } = createHarness()
    const draft = await invoices.createDraft(SAMPLE_MERCHANT_ID, draftInput())
    const issued = await invoices.issueInvoice(SAMPLE_MERCHANT_ID, draft.id, draft.version)
    await expect(
      invoices.issueInvoice(SAMPLE_MERCHANT_ID, draft.id, issued.version),
    ).rejects.toMatchObject({
      code: 'invalid_transition',
    })
    const other = await invoices.createDraft(SAMPLE_MERCHANT_ID, draftInput())
    const cancelled = await invoices.cancelDraft(SAMPLE_MERCHANT_ID, other.id, other.version)
    await expect(
      invoices.issueInvoice(SAMPLE_MERCHANT_ID, other.id, cancelled.version),
    ).rejects.toMatchObject({
      code: 'invalid_transition',
    })
  })

  it('applies the stricter issue rules: due date not in the past, total above zero', async () => {
    const { invoices } = createHarness()
    const past = await invoices.createDraft(SAMPLE_MERCHANT_ID, draftInput({ dueAt: '2020-01-01' }))
    await expect(
      invoices.issueInvoice(SAMPLE_MERCHANT_ID, past.id, past.version),
    ).rejects.toMatchObject({
      code: 'validation',
      message: expect.stringContaining('past'),
    })
    // Still a draft after the failed attempt.
    expect((await invoices.getInvoice(SAMPLE_MERCHANT_ID, past.id)).status).toBe('DRAFT')
  })

  it('re-validates the branch when issuing, so an inactive branch blocks it', async () => {
    const { invoices, branches } = createHarness()
    const draft = await invoices.createDraft(SAMPLE_MERCHANT_ID, draftInput())
    await branches.changeBranchStatus(SAMPLE_MERCHANT_ID, SAMPLE_BRANCH_IDS.remera, 'INACTIVE')
    await expect(
      invoices.issueInvoice(SAMPLE_MERCHANT_ID, draft.id, draft.version),
    ).rejects.toMatchObject({
      code: 'branch_inactive',
    })
  })

  it('re-validates the assignment when issuing: a revoked cashier cannot be the seller', async () => {
    const { invoices, staff } = createHarness()
    const draft = await invoices.createDraft(SAMPLE_MERCHANT_ID, draftInput())
    await staff.revokeMembership(SAMPLE_MERCHANT_ID, 'mem-004')
    await expect(
      invoices.issueInvoice(SAMPLE_MERCHANT_ID, draft.id, draft.version),
    ).rejects.toMatchObject({
      code: 'assignee_not_eligible',
    })
  })

  it('checks the version when issuing', async () => {
    const { invoices } = createHarness()
    const draft = await invoices.createDraft(SAMPLE_MERCHANT_ID, draftInput())
    await expect(
      invoices.issueInvoice(SAMPLE_MERCHANT_ID, draft.id, draft.version + 5),
    ).rejects.toMatchObject({
      code: 'version_conflict',
    })
  })
})

describe('historical references are preserved', () => {
  it('keeps invoices, their ownership and their branch after the branch is deactivated', async () => {
    const { invoices, branches } = createHarness()
    const before = await invoices.listInvoices(SAMPLE_MERCHANT_ID)
    await branches.changeBranchStatus(SAMPLE_MERCHANT_ID, SAMPLE_BRANCH_IDS.remera, 'INACTIVE')
    const after = await invoices.listInvoices(SAMPLE_MERCHANT_ID)
    expect(after.items).toEqual(before.items)
    const onRemera = after.items.filter((i) => i.branchId === SAMPLE_BRANCH_IDS.remera)
    expect(onRemera.length).toBeGreaterThan(0)
    expect(onRemera.every((i) => i.branchSnapshot.name === 'Remera Main')).toBe(true)
  })

  it('does not rewrite invoice ownership when a cashier is suspended, revoked or reassigned', async () => {
    const { invoices, staff, branches } = createHarness()
    const before = (await invoices.listInvoices(SAMPLE_MERCHANT_ID)).items.map((i) => [
      i.id,
      i.assignedToUserId,
      i.assignedToName,
    ])
    await staff.suspendMembership(SAMPLE_MERCHANT_ID, 'mem-004')
    await staff.revokeMembership(SAMPLE_MERCHANT_ID, 'mem-004')
    await branches.updateBranchAssignments(SAMPLE_MERCHANT_ID, 'mem-003', [
      SAMPLE_BRANCH_IDS.cityCentre,
    ])
    const after = (await invoices.listInvoices(SAMPLE_MERCHANT_ID)).items.map((i) => [
      i.id,
      i.assignedToUserId,
      i.assignedToName,
    ])
    expect(after).toEqual(before)
  })

  it('keeps the merchant snapshot on issued invoices when the business profile later changes', async () => {
    const harness = createHarness()
    const issued = (await harness.invoices.listInvoices(SAMPLE_MERCHANT_ID)).items.find(
      (i) => i.invoiceNumber === 'SMP-INV-1044',
    )!
    expect(issued.merchantSnapshot.legalName).toBe('Sample Business Ltd')
    // A later read still returns the frozen snapshot, independent of live merchant data.
    const again = await harness.invoices.getInvoice(SAMPLE_MERCHANT_ID, issued.id)
    expect(again.merchantSnapshot).toEqual(issued.merchantSnapshot)
  })
})

describe('cancelling and voiding', () => {
  it('cancels a draft and keeps the record', async () => {
    const { invoices } = createHarness()
    const draft = await invoices.createDraft(SAMPLE_MERCHANT_ID, draftInput())
    const cancelled = await invoices.cancelDraft(SAMPLE_MERCHANT_ID, draft.id, draft.version)
    expect(cancelled.status).toBe('CANCELLED')
    expect(cancelled.cancelledAt).toBeDefined()
    expect((await invoices.getInvoice(SAMPLE_MERCHANT_ID, draft.id)).customer.name).toBe(
      'Mama Jane Shop',
    )
  })

  it('does not cancel an issued invoice: it can only be voided', async () => {
    const { invoices } = createHarness()
    const issued = (await invoices.listInvoices(SAMPLE_MERCHANT_ID)).items.find(
      (i) => i.invoiceNumber === 'SMP-INV-1044',
    )!
    await expect(
      invoices.cancelDraft(SAMPLE_MERCHANT_ID, issued.id, issued.version),
    ).rejects.toMatchObject({
      code: 'invalid_transition',
    })
  })

  it('lets an owner void an unpaid issued invoice with a reason, keeping all its data', async () => {
    const { invoices } = createHarness()
    const target = (await invoices.listInvoices(SAMPLE_MERCHANT_ID)).items.find(
      (i) => i.invoiceNumber === 'SMP-INV-1044',
    )!
    const voided = await invoices.voidInvoice(
      SAMPLE_MERCHANT_ID,
      target.id,
      { reason: 'Duplicate invoice' },
      target.version,
    )
    expect(voided).toMatchObject({
      status: 'VOIDED',
      voidReason: 'Duplicate invoice',
      grandTotal: target.grandTotal,
    })
    expect(voided.voidedAt).toBeDefined()
    expect(voided.items).toEqual(target.items)
    expect(voided.paymentStatus).toBe('UNPAID') // voiding never changes payment status
  })

  it('refuses to void without a reason, or when payment activity exists', async () => {
    const { invoices } = createHarness()
    const list = (await invoices.listInvoices(SAMPLE_MERCHANT_ID)).items
    const unpaid = list.find((i) => i.invoiceNumber === 'SMP-INV-1044')!
    await expect(
      invoices.voidInvoice(SAMPLE_MERCHANT_ID, unpaid.id, { reason: ' ' }, unpaid.version),
    ).rejects.toMatchObject({
      code: 'validation',
    })
    for (const number of ['SMP-INV-1042' /* PAID */, 'SMP-INV-1043' /* PARTIALLY_PAID */]) {
      const target = list.find((i) => i.invoiceNumber === number)!
      await expect(
        invoices.voidInvoice(SAMPLE_MERCHANT_ID, target.id, { reason: 'Mistake' }, target.version),
      ).rejects.toMatchObject({ code: 'void_not_allowed' })
    }
  })

  it('lets only owners void', async () => {
    const owner = createHarness('owner')
    const target = (await owner.invoices.listInvoices(SAMPLE_MERCHANT_ID)).items.find(
      (i) => i.invoiceNumber === 'SMP-INV-1041',
    )!
    for (const user of ['manager', 'cashier'] as const) {
      owner.signInAs(user)
      await expect(
        owner.invoices.voidInvoice(
          SAMPLE_MERCHANT_ID,
          target.id,
          { reason: 'Mistake' },
          target.version,
        ),
      ).rejects.toMatchObject({ code: 'forbidden' })
    }
  })

  it('treats cancelled and voided invoices as final', async () => {
    const { invoices } = createHarness()
    const list = (await invoices.listInvoices(SAMPLE_MERCHANT_ID)).items
    for (const number of ['SMP-INV-1045', 'SMP-INV-1046']) {
      const target = list.find((i) => i.invoiceNumber === number)!
      await expect(
        invoices.issueInvoice(SAMPLE_MERCHANT_ID, target.id, target.version),
      ).rejects.toMatchObject({ code: 'invalid_transition' })
      await expect(
        invoices.cancelDraft(SAMPLE_MERCHANT_ID, target.id, target.version),
      ).rejects.toMatchObject({ code: 'invalid_transition' })
      await expect(
        invoices.voidInvoice(SAMPLE_MERCHANT_ID, target.id, { reason: 'Again' }, target.version),
      ).rejects.toMatchObject({ code: 'invalid_transition' })
    }
  })

  it('has no way to mark an invoice as paid', () => {
    const { invoices } = createHarness()
    expect(Object.keys(invoices).sort()).toEqual(
      [
        'cancelDraft',
        'createDraft',
        'getInvoice',
        'getInvoiceFormOptions',
        'issueInvoice',
        'listInvoices',
        'updateDraft',
        'voidInvoice',
      ].sort(),
    )
  })
})
