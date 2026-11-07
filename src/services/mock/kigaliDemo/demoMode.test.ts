import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The demo experience, end to end through the REAL mock services, started the way the demo build starts them (the build-time switches below).
 * One in-memory "browser" (jsdom storage) is opened, closed and opened again, exactly like a person refreshing the page.
 */
const DEMO_ENV = { VITE_API_MODE: 'mock', VITE_DEMO_EXPERIENCE: 'true', VITE_ENABLE_DEMO_TOOLS: 'true' }

type Modules = Awaited<ReturnType<typeof loadModules>>
let m: Modules

async function loadModules() {
  const [
    store,
    ledgerStore,
    auth,
    merchants,
    branches,
    staff,
    catalog,
    inventory,
    pos,
    codeCheckout,
    entry,
    collection,
    dashboard,
    reports,
    invoices,
    simulator,
    demoData,
    keys,
    seeds,
    organization,
    payments,
    experience,
  ] = await Promise.all([
    import('../mockAuthStore'),
    import('../ledger/mockLedgerStore'),
    import('../mockAuthService'),
    import('../mockMerchantService'),
    import('../mockBranchService'),
    import('../mockStaffService'),
    import('../mockCatalogService'),
    import('../mockInventoryService'),
    import('../mockPosService'),
    import('../mockCodeCheckoutService'),
    import('../mockEntryDeviceService'),
    import('../mockCollectionCodeService'),
    import('../mockDashboardService'),
    import('../mockReportsService'),
    import('../mockInvoiceService'),
    import('../mockBankSimulator'),
    import('../demoData'),
    import('../mockStorageKeys'),
    import('../seeds'),
    import('./organization'),
    import('./payments'),
    import('@/lib/demoExperience'),
  ])
  return { store, ledgerStore, auth, merchants, branches, staff, catalog, inventory, pos, codeCheckout, entry, collection, dashboard, reports, invoices, simulator, demoData, keys, seeds, organization, payments, experience }
}

beforeAll(async () => {
  for (const [name, value] of Object.entries(DEMO_ENV)) vi.stubEnv(name, value)
  vi.resetModules()
  m = await loadModules()
})

afterAll(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

beforeEach(() => {
  window.localStorage.clear()
  window.sessionStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Opens the demo like a browser tab does: stores over the SAME browser storage, services with no artificial delay. */
function openDemo() {
  const persistent = window.localStorage
  const session = window.sessionStorage
  const store = m.store.createMockAuthStore({ persistentStorage: persistent, sessionStorage: session })
  const ledger = m.ledgerStore.createLedgerStore(store)
  const common = { authStore: store, merchantStorage: persistent, delayInMilliseconds: 0 }
  const invoiceService = m.invoices.createMockInvoiceService({ ...common, ledger })
  const codeCheckout = m.codeCheckout.createMockCodeCheckout({ ...common, ledger, invoiceService })
  return {
    store,
    ledger,
    auth: m.auth.createMockAuthService({ store, delayInMilliseconds: 0 }),
    merchants: m.merchants.createMockMerchantService({ storage: persistent, authStore: store, delayInMilliseconds: 0 }),
    branches: m.branches.createMockBranchService({ authStore: store, delayInMilliseconds: 0 }),
    staff: m.staff.createMockStaffService({ authStore: store, merchantStorage: persistent, delayInMilliseconds: 0 }),
    catalog: m.catalog.createMockCatalogService(common),
    inventory: m.inventory.createMockInventoryService(common),
    pos: m.pos.createMockPosService({ ...common, codeCheckout: codeCheckout.codeCheckoutService, billCart: codeCheckout.billCart }),
    codeCheckout,
    entry: m.entry.createMockEntryDevices({ ...common, publicCodeSaleService: codeCheckout.publicCodeSaleService }),
    dashboard: m.dashboard.createMockDashboardService({ authStore: store, ledger }),
    reports: m.reports.createMockReportsService({ authStore: store, ledger, delayInMilliseconds: 0 }),
    simulator: m.simulator.createMockBankSimulator({ authStore: store, ledger, delayInMilliseconds: 0 }),
  }
}

type Demo = ReturnType<typeof openDemo>

const signIn = async (demo: Demo, who: 'owner' | 'manager' | 'cashier') => {
  const { KD_PEOPLE } = m.organization
  await demo.auth.login({ email: KD_PEOPLE[who].email, password: 'DemoPass123!' }, { rememberMe: true })
}

const M = 'kd-mrc-001'
const MAIN = 'kd-brn-001'
const REMERA = 'kd-brn-002'

const requestId = (() => {
  let n = 0
  return () => `00000000-0000-4000-d000-${String(++n).padStart(12, '0')}`
})()

describe('opening the demo', () => {
  it('starts in the demo namespace and the demo build really is the demo', () => {
    expect(m.experience.DEMO_EXPERIENCE).toBe(true)
    expect(m.experience.MOCK_STORAGE_NAMESPACE).toBe('oupay.demo')
    expect(m.seeds.ACTIVE_SEEDS).toBe(m.seeds.KIGALI_SEEDS)
    expect(m.keys.MOCK_STORAGE_KEYS.users).toBe('oupay.demo.users')
  })

  it('opens with realistic examples already in every module, for the owner', async () => {
    const demo = openDemo()
    await signIn(demo, 'owner')
    expect((await demo.merchants.listMerchantsForCurrentUser()).map((x) => x.tradingName)).toEqual(['Kigali Demo Supermarket'])
    expect((await demo.branches.listBranches(M)).map((b) => b.name).sort()).toEqual(['Kigali Main', 'Kimironko', 'Remera'])
    expect((await demo.staff.listStaff(M)).map((s) => s.role).sort()).toEqual(['CASHIER', 'MANAGER', 'OWNER'])
    const items = await demo.catalog.listItems(M, {})
    expect(items.items.filter((i) => i.itemType === 'GOODS')).toHaveLength(10)
    expect(items.items.filter((i) => i.itemType === 'SERVICE')).toHaveLength(2)
    const balances = await demo.inventory.listBalances(M, {})
    expect(new Set(balances.items.map((b) => b.branchId))).toEqual(new Set([MAIN, REMERA, 'kd-brn-003']))
    expect((await demo.pos.listPosDrafts(M)).items).toHaveLength(2)
    const devices = await demo.entry.entryDeviceService.listDevices(M)
    expect(devices.map((d) => d.deviceType).sort()).toEqual(['NFC_BRACELET', 'STATIC_QR', 'STATIC_QR'])
    const summary = await demo.dashboard.getSummary({ merchantId: M })
    expect(summary).toMatchObject({ verifiedIncomingTotal: 356_120, allocatedTotal: 295_520, unappliedConfirmedTotal: 60_600, requiresReviewCount: 1, activeCashierCount: 1 })
  })

  it('shows the dashboard and the report the same figures, because both come from one demo ledger', async () => {
    const demo = openDemo()
    await signIn(demo, 'owner')
    const summary = await demo.dashboard.getSummary({ merchantId: M })
    const report = await demo.reports.getSummary(M, { from: '2000-01-01', to: '2099-12-31' })
    expect(report).toMatchObject({
      issuedInvoiceCount: 3,
      issuedTotalRwf: 537_520,
      activeAllocatedToIssuedInvoicesRwf: summary.allocatedTotal,
      outstandingForIssuedInvoicesRwf: 242_000,
      confirmedIncomingDuringPeriodRwf: summary.verifiedIncomingTotal,
      unappliedConfirmedDuringPeriodRwf: summary.unappliedConfirmedTotal,
    })
  })

  it('gives each role its own view of the same business: users, branches and carts stay consistent', async () => {
    const owner = openDemo()
    await signIn(owner, 'owner')
    expect((await owner.pos.listPosDrafts(M)).items).toHaveLength(2)
    await owner.auth.logout()

    const manager = openDemo()
    await signIn(manager, 'manager')
    // The manager works at Kigali Main and Remera: both carts are theirs to see.
    expect((await manager.pos.listPosDrafts(M)).items.map((d) => d.branchId).sort()).toEqual([MAIN, REMERA])
    await manager.auth.logout()

    const cashier = openDemo()
    await signIn(cashier, 'cashier')
    const drafts = (await cashier.pos.listPosDrafts(M)).items
    expect(drafts).toHaveLength(1)
    expect(drafts[0]).toMatchObject({ branchId: MAIN, createdByName: 'Patrick Nsengimana' })
    // A cashier can neither change the catalog nor read the financial report.
    await expect(cashier.catalog.createItem(M, { itemType: 'SERVICE', name: 'Not allowed', pricePerSaleUnitRwf: 100 })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(cashier.reports.getSummary(M, { from: '2026-01-01', to: '2026-12-31' })).rejects.toMatchObject({ code: 'forbidden' })
    // ...and cannot prepare a cart at a branch they do not work at.
    await expect(
      cashier.pos.createPosDraft(M, { clientRequestId: requestId(), idempotencyKey: 'demo-cashier-remera-1', branchId: REMERA, lines: [{ itemId: 'kd-cat-soda', quantity: '1', unit: 'pc', expectedPriceVersion: 1 }] }),
    ).rejects.toMatchObject({ code: 'branch_not_eligible' })
  })
})

describe('adding to the demo, and the business rules still hold', () => {
  it('lets the owner add a branch, a product, a price change, stock, a cart, a payment point and a staff invitation', async () => {
    const demo = openDemo()
    await signIn(demo, 'owner')

    const branch = await demo.branches.createBranch(M, { name: 'Huye Market', code: 'HUY4', status: 'ACTIVE', location: { province: 'Southern', district: 'Huye', sector: 'Ngoma', physicalAddress: 'Market Rd' } })
    expect((await demo.branches.listBranches(M)).map((b) => b.code)).toContain('HUY4')

    const item = await demo.catalog.createItem(M, { itemType: 'GOODS', name: 'Biscuits', code: 'BISC', measurementDimension: 'COUNT', saleUnit: 'pc', pricePerSaleUnitRwf: 400 })
    const repriced = await demo.catalog.updateItem(M, item.id, { expectedVersion: item.version, name: 'Biscuits', code: 'BISC', saleUnit: 'pc', pricePerSaleUnitRwf: 450, priceChangeReason: 'Supplier increase' })
    expect(repriced.priceVersion).toBe(2)
    expect((await demo.catalog.listPriceHistory(M, item.id)).map((p) => p.pricePerSaleUnitRwf)).toEqual(expect.arrayContaining([400, 450]))

    await demo.inventory.recordOpening(M, { clientOperationId: requestId(), branchId: branch.id, itemId: item.id, amount: '50', unit: 'pc' })
    await demo.inventory.receiveStock(M, { clientOperationId: requestId(), branchId: branch.id, itemId: item.id, amount: '10', unit: 'pc', reference: 'DN-1' })
    await demo.inventory.adjustStock(M, { clientOperationId: requestId(), branchId: branch.id, itemId: item.id, amount: '2', unit: 'pc', direction: 'OUT', reason: 'Damaged' })
    const stock = (await demo.inventory.listBalances(M, { branchId: branch.id })).items.find((b) => b.itemId === item.id)
    expect(Number(stock!.quantityOnHand)).toBe(58)

    const registered = await demo.entry.entryDeviceService.registerDevice(M, { clientRequestId: requestId(), deviceType: 'NFC_TAG', displayName: 'Huye door tag', branchId: branch.id, assignedCashierUserId: null })
    expect(registered.device.entryPath).toMatch(/^\/e\/[A-Za-z0-9_-]{22}$/)

    const invited = await demo.staff.inviteStaff(M, { email: 'new.cashier@example.rw', role: 'CASHIER', branchIds: [MAIN] })
    expect(invited.status).toBe('PENDING')

    const draft = await demo.pos.createPosDraft(M, { clientRequestId: requestId(), idempotencyKey: 'demo-owner-draft-001', branchId: MAIN, note: 'My own cart', lines: [{ itemId: 'kd-cat-rice', quantity: '3', unit: 'kg', expectedPriceVersion: 2 }] })
    expect(draft.totalRwf).toBe(3_600)
    expect((await demo.pos.listPosDrafts(M)).items).toHaveLength(3)
  })

  it('refuses what the real rules refuse: a duplicate code, stock below zero, a changed price, an unknown branch', async () => {
    const demo = openDemo()
    await signIn(demo, 'owner')
    await expect(demo.branches.createBranch(M, { name: 'Another', code: 'KGM1', status: 'ACTIVE', location: { province: 'Kigali City', district: 'Gasabo', sector: 'Remera', physicalAddress: 'KG 1 Ave' } })).rejects.toBeTruthy()
    await expect(demo.catalog.createItem(M, { itemType: 'GOODS', name: 'Rice again', code: 'RICE', measurementDimension: 'MASS', saleUnit: 'kg', pricePerSaleUnitRwf: 1 })).rejects.toBeTruthy()
    await expect(demo.inventory.adjustStock(M, { clientOperationId: requestId(), branchId: 'kd-brn-003', itemId: 'kd-cat-rice', amount: '9999', unit: 'kg', direction: 'OUT', reason: 'Too much' })).rejects.toBeTruthy()
    // The cart was priced at version 1 of rice, but rice is already at version 2.
    await expect(
      demo.pos.createPosDraft(M, { clientRequestId: requestId(), idempotencyKey: 'demo-owner-stale-001', branchId: MAIN, lines: [{ itemId: 'kd-cat-rice', quantity: '1', unit: 'kg', expectedPriceVersion: 1 }] }),
    ).rejects.toBeTruthy()
    await expect(demo.branches.getBranch(M, 'no-such-branch')).rejects.toBeTruthy()
  })
})

describe('persistence: refresh keeps what you did, never reseeds, and Reset restores the examples', () => {
  const addBranchAndItem = async (demo: Demo) => {
    await signIn(demo, 'owner')
    await demo.branches.createBranch(M, { name: 'Huye Market', code: 'HUY4', status: 'ACTIVE', location: { province: 'Southern', district: 'Huye', sector: 'Ngoma', physicalAddress: 'Market Rd' } })
    const rice = await demo.catalog.getItem(M, 'kd-cat-rice')
    await demo.catalog.updateItem(M, rice.id, { expectedVersion: rice.version, name: 'Rice (my edit)', code: 'RICE', saleUnit: 'kg', pricePerSaleUnitRwf: 1_350, priceChangeReason: 'My change' })
  }

  it('keeps the changes across a refresh, and does not put the original examples back over an edited record', async () => {
    await addBranchAndItem(openDemo())
    const firstOpened = window.localStorage.getItem('oupay.demo.demoInitialisedAt')
    expect(firstOpened).not.toBeNull()

    // "Refresh": a brand-new set of services over the same browser storage. The sign-in marker is remembered too.
    const again = openDemo()
    expect((await again.merchants.listMerchantsForCurrentUser()).map((x) => x.id)).toEqual([M])
    const branches = await again.branches.listBranches(M)
    expect(branches.map((b) => b.code).sort()).toEqual(['HUY4', 'KGM1', 'KMR3', 'RMR2'])
    const rice = await again.catalog.getItem(M, 'kd-cat-rice')
    expect(rice).toMatchObject({ name: 'Rice (my edit)', pricePerSaleUnitRwf: 1_350, priceVersion: 3 })
    // The examples were loaded once, the first time, and never again.
    expect(window.localStorage.getItem('oupay.demo.demoInitialisedAt')).toBe(firstOpened)
    expect((await again.catalog.listItems(M, {})).items).toHaveLength(12)
  })

  it('Reset removes everything the person did and brings back exactly the original examples, touching nothing outside the demo', async () => {
    await addBranchAndItem(openDemo())
    // Other things that live in the same browser must survive a reset of the demo.
    window.localStorage.setItem('oupay.mock.users', '["ordinary mock data"]')
    window.localStorage.setItem('some-other-app', 'keep me')
    window.sessionStorage.setItem('oupay.pos.attempt.x', 'stale-retry-id')

    const removed = m.demoData.clearDemoBrowserState({ local: window.localStorage, session: window.sessionStorage })
    expect(removed).toBeGreaterThan(20)
    expect(window.localStorage.getItem('oupay.mock.users')).toBe('["ordinary mock data"]')
    expect(window.localStorage.getItem('some-other-app')).toBe('keep me')
    expect(window.sessionStorage.getItem('oupay.pos.attempt.x')).toBeNull()
    expect(Object.keys(window.localStorage).filter((k) => k.startsWith('oupay.demo.'))).toEqual([])

    const fresh = openDemo()
    await signIn(fresh, 'owner')
    expect((await fresh.branches.listBranches(M)).map((b) => b.code).sort()).toEqual(['KGM1', 'KMR3', 'RMR2'])
    const rice = await fresh.catalog.getItem(M, 'kd-cat-rice')
    expect(rice).toMatchObject({ name: 'Rice', pricePerSaleUnitRwf: 1_200, priceVersion: 2 })
    expect((await fresh.pos.listPosDrafts(M)).items).toHaveLength(2)
  })
})

describe('isolation: the demo never reaches a real service or mixes with other data', () => {
  it('sends nothing to any server during a whole journey, and writes only into its own namespace', async () => {
    const fetchSpy = vi.fn(async () => new Response(null, { status: 500 }))
    vi.stubGlobal('fetch', fetchSpy)
    const beacon = vi.fn()
    Object.defineProperty(navigator, 'sendBeacon', { value: beacon, configurable: true })

    const demo = openDemo()
    await signIn(demo, 'owner')
    await demo.branches.createBranch(M, { name: 'Huye Market', code: 'HUY4', status: 'ACTIVE', location: { province: 'Southern', district: 'Huye', sector: 'Ngoma', physicalAddress: 'Market Rd' } })
    await demo.catalog.createItem(M, { itemType: 'SERVICE', name: 'Gift wrap', pricePerSaleUnitRwf: 300 })
    await demo.inventory.receiveStock(M, { clientOperationId: requestId(), branchId: MAIN, itemId: 'kd-cat-rice', amount: '5', unit: 'kg' })
    await demo.dashboard.getSummary({ merchantId: M })
    await demo.reports.getSummary(M, { from: '2000-01-01', to: '2099-12-31' })
    await demo.auth.logout()

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(beacon).not.toHaveBeenCalled()
    const keys = [...Object.keys(window.localStorage), ...Object.keys(window.sessionStorage)]
    expect(keys.length).toBeGreaterThan(20)
    expect(keys.every((k) => k.startsWith('oupay.demo.'))).toBe(true)
    expect(keys.some((k) => k.startsWith('oupay.mock.'))).toBe(false)
  })

  it('cannot see any other business: a different business id is "not found" for the demo owner', async () => {
    const demo = openDemo()
    await signIn(demo, 'owner')
    await expect(demo.branches.listBranches('mrc-sample-001')).rejects.toMatchObject({ code: 'not_found' })
    await expect(demo.reports.getSummary('mrc-sample-001', { from: '2026-01-01', to: '2026-12-31' })).rejects.toMatchObject({ code: 'not_found' })
    // And the ordinary sample accounts do not exist in the demo at all.
    await expect(demo.auth.login({ email: 'owner@oupay.demo', password: 'DemoPass123!' }, { rememberMe: false })).rejects.toBeTruthy()
  })
})

describe('the customer payment-entry journey runs on simulated money only', () => {
  const bill = async (demo: Demo, draftId: string, codeId: string, key: string) => {
    const review = await demo.pos.getBillingReview(M, draftId, codeId)
    if (!review.billable) throw new Error(JSON.stringify({ problems: review.problems, mode: review.mode, note: review.modeNote }))
    return demo.pos.billPosDraft(M, draftId, { expectedDraftVersion: review.draftVersion, reviewedTotalRwf: review.totalRwf, collectionCodeId: codeId, idempotencyKey: key })
  }

  it('NFC bracelet: the cashier bills the cart, binds it to the bracelet, and the customer opens and claims a DEMONSTRATION bill that cannot be paid', async () => {
    const cashier = openDemo()
    await signIn(cashier, 'cashier')
    const [draft] = (await cashier.pos.listPosDrafts(M)).items
    const billed = await bill(cashier, draft!.id, 'kd-cc-001', 'demo-journey-bracelet-1')
    // The code is simulated, so the bill is a demonstration: the application itself says so.
    expect(billed.mode).toBe('DEMONSTRATION')
    const device = await cashier.entry.entryDeviceService.getDevice(M, 'kd-dev-003')
    expect(device.deviceType).toBe('NFC_BRACELET')
    await cashier.entry.entryDeviceService.bindSale(M, device.id, { saleId: billed.sale.saleId, expectedVersion: device.version })

    // The customer, anonymous, taps the bracelet.
    const token = m.payments.KD_DEVICE_TOKENS.braceletCashier
    const opened = await cashier.entry.publicEntryService.resolve(token)
    // Opening only READS: it shows the shop and that a bill is waiting, never the bill, and takes nothing.
    expect(opened.state).toBe('READY')
    expect(opened.merchantDisplayName).toBe('Kigali Demo Supermarket')
    expect(opened.sale).toBeNull()
    // Claiming is the customer's explicit step; only then is the bill shown.
    const claimed = await cashier.entry.publicEntryService.claim(token)
    expect(claimed.state).toBe('CLAIMED')
    expect(claimed.sale!.saleReference).toBe(billed.sale.saleReference)
    expect(claimed.sale!.status).toBe('AWAITING_PAYMENT')
    expect(claimed.sale!.code.mode).toBe('DEMONSTRATION')
    expect(claimed.sale!.code.bankCode).toBeNull()

    // Even if the simulated bank reports a payment, a demonstration is never shown as paid, and what the simulator writes is marked simulated.
    await cashier.simulator.simulateRequestPayment(billed.sale.saleReference, 'success')
    const created = cashier.ledger.bankTransactions.load().filter((t) => t.paymentReference === billed.sale.saleReference)
    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({ isSimulated: true, provider: 'EQUITY_MOCK' })
    const sale = await cashier.codeCheckout.codeCheckoutService.getCodeSale(M, billed.sale.saleId)
    expect(sale.status).toBe('AWAITING_PAYMENT')
  })

  it('static QR: the manager bills the Remera cart on the counter code and the customer sees the bill behind the QR, with no money moved', async () => {
    const manager = openDemo()
    await signIn(manager, 'manager')
    const remeraDraft = (await manager.pos.listPosDrafts(M)).items.find((d) => d.branchId === REMERA)!
    const billed = await bill(manager, remeraDraft.id, 'kd-cc-002', 'demo-journey-qr-remera-1')
    const device = await manager.entry.entryDeviceService.getDevice(M, 'kd-dev-002')
    expect(device.deviceType).toBe('STATIC_QR')
    // Before anything is bound the QR leads nowhere: scanning never pays or invents a bill.
    expect((await manager.entry.publicEntryService.resolve(m.payments.KD_DEVICE_TOKENS.qrRemera)).state).toBe('IDLE')
    await manager.entry.entryDeviceService.bindSale(M, device.id, { saleId: billed.sale.saleId, expectedVersion: device.version })
    expect((await manager.entry.publicEntryService.resolve(m.payments.KD_DEVICE_TOKENS.qrRemera)).state).toBe('READY')
    const claimed = await manager.entry.publicEntryService.claim(m.payments.KD_DEVICE_TOKENS.qrRemera)
    expect(claimed.state).toBe('CLAIMED')
    expect(claimed.sale).toMatchObject({ amountRwf: billed.totalRwf, currency: 'RWF', status: 'AWAITING_PAYMENT' })
    // Merely opening the QR moved no money.
    expect(manager.ledger.bankTransactions.load().filter((t) => t.paymentReference === billed.sale.saleReference)).toHaveLength(0)
  })

  it('an unknown payment point gives one "unavailable" answer and reveals nothing', async () => {
    const demo = openDemo()
    const unknown = await demo.entry.publicEntryService.resolve('NotARealDemoToken0000')
    expect(unknown.state).toBe('UNAVAILABLE')
    expect(unknown.sale).toBeNull()
    expect(unknown.merchantDisplayName).toBeNull()
  })
})
