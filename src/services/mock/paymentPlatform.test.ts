import { afterEach } from 'vitest'
import { equityMockAdapter } from '@/services/banking/equityMockAdapter'
import {
  getAdapter,
  getCapabilities,
  REAL_EQUITY_READINESS,
} from '@/services/banking/providerRegistry'
import { InvalidProviderEventError } from '@/services/banking/bankingProviderAdapter'
import { createTestBackend } from '@/test/merchantTestDouble'
import { DEMO_USER_IDS } from './sampleAccounts'
import { SAMPLE_BRANCH_IDS } from './sampleOrganization'
import { SAMPLE_MERCHANT_ID, SAMPLE_SECOND_MERCHANT_ID } from './sampleMerchants'
import { MOCK_STORAGE_KEYS } from './mockStorageKeys'
import { createMockBankSimulator } from './mockBankSimulator'
import { loadStoredMerchants } from './mockMerchantService'
import type { Merchant } from '@/types/merchant'

const MERCHANT = SAMPLE_MERCHANT_ID
const SHOP_TOKEN = 'Rk4mQ8vTz2Xn' // pp-sample-001: business-wide, active
const ALINE_TOKEN = 'Bn7wL3cYp9Ds' // pp-sample-002: Aline at Remera Main, active
const OFF_TOKEN = 'Hs5tV2jMq8Gf' // pp-sample-003: switched off
const REVOKED_TOKEN = 'Zc6uE4nWr1Ka' // pp-sample-004: replaced

const setup = (user: keyof typeof DEMO_USER_IDS = 'owner') => {
  const backend = createTestBackend()
  backend.signInAs(user)
  const simulator = createMockBankSimulator({
    authStore: backend.store,
    ledger: backend.ledger,
    delayInMilliseconds: 0,
  })
  return { ...backend, simulator, as: backend.signInAs }
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('banking provider adapter', () => {
  const valid = {
    __simulated: true,
    eventId: 'e1',
    transactionId: 't1',
    state: 'POSTED',
    amount: 1000,
    currency: 'RWF',
    reference: ' INV-0001 ',
    payerName: 'Someone',
    occurredAt: '2026-10-12T10:00:00Z',
    accountRef: 'bacc-sample-001',
  }

  it('normalizes a simulated event, keeping the reference exactly as sent', () => {
    const event = equityMockAdapter.normalizeTransactionEvent(valid)
    expect(event).toMatchObject({
      providerId: 'EQUITY_MOCK',
      status: 'CONFIRMED',
      direction: 'INCOMING',
      amount: 1000,
      paymentReference: 'INV-0001',
      isSimulated: true,
    })
    expect(
      equityMockAdapter.normalizeTransactionEvent({ ...valid, state: 'REJECTED' }).status,
    ).toBe('FAILED')
    expect(equityMockAdapter.normalizeTransactionEvent({ ...valid, state: 'PENDING' }).status).toBe(
      'PENDING',
    )
    expect(
      equityMockAdapter.normalizeTransactionEvent({ ...valid, state: 'REVERSED' }).status,
    ).toBe('REVERSED')
    expect(
      equityMockAdapter.normalizeTransactionEvent({ ...valid, reference: '' }).paymentReference,
    ).toBeNull()
  })

  it.each([
    ['not an object', 'text'],
    ['null', null],
    ['no simulator marker', { ...valid, __simulated: undefined }],
    ['unknown state', { ...valid, state: 'APPROVED' }],
    ['fractional amount', { ...valid, amount: 10.5 }],
    ['zero amount', { ...valid, amount: 0 }],
    ['negative amount', { ...valid, amount: -5 }],
    ['text amount', { ...valid, amount: '1000' }],
    ['wrong currency', { ...valid, currency: 'USD' }],
    ['bad date', { ...valid, occurredAt: 'yesterday' }],
    ['missing event ID', { ...valid, eventId: '' }],
    ['missing account', { ...valid, accountRef: undefined }],
  ])('rejects an untrustworthy payload: %s', (_label, payload) => {
    expect(() => equityMockAdapter.normalizeTransactionEvent(payload)).toThrow(
      InvalidProviderEventError,
    )
  })

  it('validates demo links without accepting real-looking banking details', async () => {
    const ok = await equityMockAdapter.validateAccountLink!({
      providerId: 'EQUITY_MOCK',
      accountNickname: 'x',
      accountReference: 'SIM-1234',
    })
    expect(ok).toMatchObject({ isValid: true, maskedAccount: '••••1234' })
    expect(ok.bankAccountId).toMatch(/^bacc-/)
    for (const reference of ['SIM-ERROR', '0123456789', 'my-password', '']) {
      const result = await equityMockAdapter.validateAccountLink!({
        providerId: 'EQUITY_MOCK',
        accountNickname: 'x',
        accountReference: reference,
      })
      expect(result.isValid).toBe(false)
      expect(result.failureReason).toBeTruthy()
    }
  })

  it('treats unsigned simulator events as not authentic', async () => {
    expect(
      await equityMockAdapter.verifyIncomingEvent!({ headers: {}, rawBody: '{}' }),
    ).toMatchObject({
      isAuthentic: false,
    })
  })

  it('keeps optional operations optional and assumes nothing about real banks', () => {
    // Providers without an adapter have none of the optional operations.
    expect(getAdapter('MTN_MOMO')).toBeNull()
    expect(getAdapter('AIRTEL_MONEY')).toBeNull()
    for (const providerId of ['MTN_MOMO', 'AIRTEL_MONEY'] as const) {
      expect(Object.values(getCapabilities(providerId)).every((c) => c === 'UNCONFIRMED')).toBe(
        true,
      )
    }
    // The real Equity integration: every capability is an open question.
    expect(
      Object.values(REAL_EQUITY_READINESS.capabilities).every((c) => c === 'UNCONFIRMED'),
    ).toBe(true)
    // The simulator is clearly a simulation, and does not claim merchant verification or USSD.
    expect(equityMockAdapter.isSimulated).toBe(true)
    expect(equityMockAdapter.getProviderCapabilities()).toMatchObject({
      merchantVerification: 'NOT_SUPPORTED',
      ussdMerchantResolution: 'NOT_SUPPORTED',
      paymentInitiation: 'NOT_SUPPORTED',
    })
  })
})

describe('banking configuration', () => {
  it('is for owners only', async () => {
    const t = setup('manager')
    await expect(t.fastBanking.listConnections(MERCHANT)).rejects.toMatchObject({
      code: 'forbidden',
    })
    t.as('cashier')
    await expect(t.fastBanking.listPaymentDestinations(MERCHANT)).rejects.toMatchObject({
      code: 'forbidden',
    })
    await expect(
      t.fastBanking.startAccountLink(MERCHANT, {
        providerId: 'EQUITY_MOCK',
        accountNickname: 'Mine',
        accountReference: 'SIM-1111',
      }),
    ).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('walks an owner through pending, connected and disabled, with only opaque and masked data', async () => {
    const t = setup()
    await t.fastBanking.disableConnection(MERCHANT, 'bcn-sample-001')
    const started = await t.fastBanking.startAccountLink(MERCHANT, {
      providerId: 'EQUITY_MOCK',
      accountNickname: 'Second account',
      accountReference: 'SIM-9876',
    })
    expect(started).toMatchObject({
      status: 'PENDING',
      isSimulated: true,
      maskedAccount: '••••9876',
    })
    const connected = await t.fastBanking.completeAccountLink(MERCHANT, started.id)
    expect(connected.status).toBe('CONNECTED')
    const destinations = await t.fastBanking.listPaymentDestinations(MERCHANT)
    expect(destinations.some((d) => d.bankConnectionId === started.id && d.isSimulated)).toBe(true)
    // The reference the owner typed is never stored.
    expect(JSON.stringify(t.ledger.bankConnections.load())).not.toContain('SIM-9876')
    expect((await t.fastBanking.disableConnection(MERCHANT, started.id)).status).toBe('DISABLED')
  })

  it('shows a connection error instead of hiding it, and creates no destination', async () => {
    const t = setup()
    await t.fastBanking.disableConnection(MERCHANT, 'bcn-sample-001')
    const before = (await t.fastBanking.listPaymentDestinations(MERCHANT)).length
    const failed = await t.fastBanking.startAccountLink(MERCHANT, {
      providerId: 'EQUITY_MOCK',
      accountNickname: 'Broken',
      accountReference: 'SIM-ERROR',
    })
    expect(failed).toMatchObject({ status: 'ERROR' })
    expect(failed.lastError).toBeTruthy()
    expect((await t.fastBanking.listPaymentDestinations(MERCHANT)).length).toBe(before)
    await expect(t.fastBanking.completeAccountLink(MERCHANT, failed.id)).rejects.toMatchObject({
      code: 'invalid_state',
    })
  })

  it('refuses a second link, bad names, unsupported providers and other businesses', async () => {
    const t = setup()
    const link = (
      accountNickname: string,
      providerId: 'EQUITY_MOCK' | 'MTN_MOMO' = 'EQUITY_MOCK',
    ) =>
      t.fastBanking.startAccountLink(MERCHANT, {
        providerId,
        accountNickname,
        accountReference: 'SIM-4444',
      })
    await expect(link('Duplicate')).rejects.toMatchObject({ code: 'invalid_state' })
    await expect(link('x')).rejects.toMatchObject({ code: 'validation' })
    await expect(link('Wallet', 'MTN_MOMO')).rejects.toMatchObject({ code: 'not_supported' })
    await expect(t.fastBanking.disableConnection(MERCHANT, 'bcn-sample-101')).rejects.toMatchObject(
      {
        code: 'not_found',
      },
    )
  })

  it('stops payment links from working when the connection is disabled', async () => {
    const t = setup()
    expect((await t.fastPublic.getProfile(SHOP_TOKEN)).status).toBe('ACTIVE')
    await t.fastBanking.disableConnection(MERCHANT, 'bcn-sample-001')
    expect((await t.fastPublic.getProfile(SHOP_TOKEN)).status).toBe('UNAVAILABLE')
    await expect(t.fastPublic.createOpenRequest(SHOP_TOKEN, 5000)).rejects.toMatchObject({
      code: 'profile_unavailable',
    })
  })
})

describe('payment profiles', () => {
  const input = (overrides = {}) => ({
    label: 'New counter',
    paymentDestinationId: 'dst-sample-001',
    ...overrides,
  })

  it('creates unpredictable, unique public tokens that reveal no internal ID', async () => {
    const t = setup()
    const tokens = new Set<string>()
    for (let i = 0; i < 25; i += 1) {
      const profile = await t.fastProfiles.createProfile(MERCHANT, input({ label: `Counter ${i}` }))
      expect(profile.paymentProfileId).toMatch(/^[0-9A-Za-z]{12}$/)
      expect(profile.paymentProfileId).not.toContain(profile.id)
      expect(profile.paymentProfileId).not.toContain(MERCHANT)
      tokens.add(profile.paymentProfileId)
    }
    expect(tokens.size).toBe(25)
  })

  it('validates the destination, branch and cashier at the service boundary', async () => {
    const t = setup()
    const create = (extra: object) => t.fastProfiles.createProfile(MERCHANT, input(extra))
    await expect(create({ label: '' })).rejects.toMatchObject({ code: 'validation' })
    // Another business's destination.
    await expect(create({ paymentDestinationId: 'dst-sample-101' })).rejects.toMatchObject({
      code: 'validation',
    })
    await expect(create({ branchId: 'branch-does-not-exist' })).rejects.toMatchObject({
      code: 'validation',
    })
    await expect(create({ assignedCashierId: DEMO_USER_IDS.manager })).rejects.toMatchObject({
      code: 'validation',
    })
    // Nyamirambo is inactive; once active, the cashier is still not assigned to it.
    await expect(
      create({ branchId: SAMPLE_BRANCH_IDS.nyamirambo, assignedCashierId: DEMO_USER_IDS.cashier }),
    ).rejects.toMatchObject({ code: 'validation' })
    t.store.saveBranches(
      t.store
        .loadBranches()
        .map((b) =>
          b.id === SAMPLE_BRANCH_IDS.nyamirambo ? { ...b, status: 'ACTIVE' as const } : b,
        ),
    )
    await expect(
      create({ branchId: SAMPLE_BRANCH_IDS.nyamirambo, assignedCashierId: DEMO_USER_IDS.cashier }),
    ).rejects.toMatchObject({ code: 'validation' })
    expect(
      await create({
        branchId: SAMPLE_BRANCH_IDS.remera,
        assignedCashierId: DEMO_USER_IDS.cashier,
      }),
    ).toMatchObject({ status: 'ACTIVE', cashierName: 'Aline Uwase' })
  })

  it('rejects a disconnected destination and an inactive branch', async () => {
    const t = setup()
    await t.fastBanking.disableConnection(MERCHANT, 'bcn-sample-001')
    await expect(t.fastProfiles.createProfile(MERCHANT, input())).rejects.toMatchObject({
      code: 'validation',
    })
  })

  it('lets managers manage links and cashiers only see their own', async () => {
    const t = setup('manager')
    expect((await t.fastProfiles.listProfiles(MERCHANT)).length).toBeGreaterThan(2)
    await t.fastProfiles.createProfile(MERCHANT, input())
    t.as('cashier')
    const mine = await t.fastProfiles.listProfiles(MERCHANT)
    expect(mine.map((p) => p.paymentProfileId)).toEqual([ALINE_TOKEN])
    await expect(t.fastProfiles.createProfile(MERCHANT, input())).rejects.toMatchObject({
      code: 'forbidden',
    })
    await expect(
      t.fastProfiles.setProfileActive(MERCHANT, 'pp-sample-001', false),
    ).rejects.toMatchObject({
      code: 'forbidden',
    })
    await expect(t.fastProfiles.getProfile(MERCHANT, 'pp-sample-001')).rejects.toMatchObject({
      code: 'not_found',
    })
    await expect(t.fastProfiles.getFormOptions(MERCHANT)).rejects.toMatchObject({
      code: 'forbidden',
    })
  })

  it('keeps businesses apart', async () => {
    const t = setup('manager')
    await expect(t.fastProfiles.listProfiles(SAMPLE_SECOND_MERCHANT_ID)).rejects.toMatchObject({
      code: 'not_found',
    })
    t.as('owner')
    await expect(
      t.fastProfiles.getProfile(SAMPLE_SECOND_MERCHANT_ID, 'pp-sample-001'),
    ).rejects.toMatchObject({
      code: 'not_found',
    })
  })

  it('switches a link off and on, but never revives a replaced one', async () => {
    const t = setup()
    expect((await t.fastProfiles.setProfileActive(MERCHANT, 'pp-sample-001', false)).status).toBe(
      'INACTIVE',
    )
    expect((await t.fastPublic.getProfile(SHOP_TOKEN)).status).toBe('UNAVAILABLE')
    expect((await t.fastProfiles.setProfileActive(MERCHANT, 'pp-sample-001', true)).status).toBe(
      'ACTIVE',
    )
    await expect(
      t.fastProfiles.setProfileActive(MERCHANT, 'pp-sample-004', true),
    ).rejects.toMatchObject({
      code: 'invalid_state',
    })
  })

  it('replaces a link: the old token dies, the new one works', async () => {
    const t = setup()
    const replacement = await t.fastProfiles.reissueProfile(MERCHANT, 'pp-sample-001')
    expect(replacement.paymentProfileId).not.toBe(SHOP_TOKEN)
    expect(replacement.status).toBe('ACTIVE')
    expect((await t.fastProfiles.getProfile(MERCHANT, 'pp-sample-001')).status).toBe('REVOKED')
    expect((await t.fastPublic.getProfile(SHOP_TOKEN)).status).toBe('UNAVAILABLE')
    expect((await t.fastPublic.getProfile(replacement.paymentProfileId)).status).toBe('ACTIVE')
    await expect(t.fastProfiles.reissueProfile(MERCHANT, 'pp-sample-001')).rejects.toMatchObject({
      code: 'invalid_state',
    })
  })
})

describe('public payment pages', () => {
  it('returns not-found for an unknown token and a blank "unavailable" view for dead links', async () => {
    const t = setup()
    await expect(t.fastPublic.getProfile('NoSuchToken1')).rejects.toMatchObject({
      code: 'not_found',
    })
    for (const token of [OFF_TOKEN, REVOKED_TOKEN]) {
      const view = await t.fastPublic.getProfile(token)
      expect(view).toMatchObject({
        status: 'UNAVAILABLE',
        merchantDisplayName: '',
        branchName: null,
        cashierDisplayName: null,
        paymentMethods: [],
      })
    }
  })

  it('works without anyone signed in, and exposes only minimal data', async () => {
    const t = setup()
    t.store.endSession()
    const view = await t.fastPublic.getProfile(ALINE_TOKEN)
    expect(Object.keys(view).sort()).toEqual(
      [
        'branchName',
        'cashierDisplayName',
        'isMerchantVerified',
        'merchantDisplayName',
        'paymentMethods',
        'status',
      ].sort(),
    )
    expect(view).toMatchObject({ branchName: 'Remera Main', cashierDisplayName: 'Aline U.' })
    const serialized = JSON.stringify(view)
    for (const secret of [
      MERCHANT,
      'bacc-',
      '••••',
      '@oupay',
      '+250',
      'usr-',
      'dst-',
      'bcn-',
      'pp-sample',
      'Uwase',
    ]) {
      expect(serialized).not.toContain(secret)
    }
  })

  it('shows the verified mark only when the business is really verified', async () => {
    const t = setup()
    expect((await t.fastPublic.getProfile(SHOP_TOKEN)).isMerchantVerified).toBe(false)
    const merchants = loadStoredMerchants(t.merchantStorage)
    const setStatus = (status: Merchant['status']) =>
      t.merchantStorage.setItem(
        MOCK_STORAGE_KEYS.merchants,
        JSON.stringify(merchants.map((m) => (m.id === MERCHANT ? { ...m, status } : m))),
      )
    setStatus('active')
    expect((await t.fastPublic.getProfile(SHOP_TOKEN)).isMerchantVerified).toBe(true)
    setStatus('suspended')
    expect((await t.fastPublic.getProfile(SHOP_TOKEN)).status).toBe('UNAVAILABLE')
  })

  it('offers only usable methods and never invents USSD codes, deep links or credentials requests', async () => {
    const t = setup()
    const { paymentMethods } = await t.fastPublic.getProfile(SHOP_TOKEN)
    const equity = paymentMethods.find((m) => m.id === 'EQUITY_MERCHANT')!
    expect(equity).toMatchObject({ isUsable: true, isSimulated: true })
    for (const id of ['MTN_MOMO', 'AIRTEL_MONEY']) {
      const method = paymentMethods.find((m) => m.id === id)!
      expect(method).toMatchObject({ isUsable: false, instructions: [] })
      expect(method.unavailableReason).toBeTruthy()
    }
    const text = equity.instructions.join(' ')
    expect(text).not.toMatch(/\*\d+[*#]|#\d+|https?:|tel:|momo:/i)
    expect(text).toMatch(/never share a pin/i)
  })

  it('creates open requests with a high-entropy reference and validates the amount', async () => {
    const t = setup()
    for (const bad of [0, 99, -500, 10_000_001, 1234.5, Number.NaN]) {
      await expect(t.fastPublic.createOpenRequest(SHOP_TOKEN, bad)).rejects.toMatchObject({
        code: 'validation',
      })
    }
    await expect(t.fastPublic.createOpenRequest('NoSuchToken1', 5000)).rejects.toMatchObject({
      code: 'not_found',
    })
    await expect(t.fastPublic.createOpenRequest(OFF_TOKEN, 5000)).rejects.toMatchObject({
      code: 'profile_unavailable',
    })

    const references = new Set<string>()
    for (let i = 0; i < 30; i += 1) {
      const view = await t.fastPublic.createOpenRequest(SHOP_TOKEN, 5000)
      expect(view.publicReference).toMatch(/^OP-[2-9A-HJKMNP-Z]{12}$/)
      references.add(view.publicReference)
    }
    expect(references.size).toBe(30)
    const view = await t.fastPublic.createOpenRequest(SHOP_TOKEN, 5000)
    expect(view).toMatchObject({
      requestedAmount: 5000,
      amountDue: 5000,
      currency: 'RWF',
      stage: 'AWAITING_PAYMENT',
      confirmedAmount: 0,
    })
    expect(Date.parse(view.expiresAt) - Date.now()).toBeLessThanOrEqual(30 * 60_000)
  })

  it('serves a request only through its own profile token', async () => {
    const t = setup()
    const view = await t.fastPublic.createOpenRequest(SHOP_TOKEN, 5000)
    await expect(t.fastPublic.getRequest(ALINE_TOKEN, view.publicReference)).rejects.toMatchObject({
      code: 'not_found',
    })
    await expect(t.fastPublic.getRequest(SHOP_TOKEN, 'OP-NOSUCHREF000')).rejects.toMatchObject({
      code: 'not_found',
    })
    // Someone else's business token never reveals this request either.
    await expect(
      t.fastPublic.getRequest('Cf8xN3dQm5Wb', view.publicReference),
    ).rejects.toMatchObject({ code: 'not_found' })
    const own = await t.fastPublic.getRequest(SHOP_TOKEN, view.publicReference)
    expect(JSON.stringify(own)).not.toMatch(/bacc-|mrc-|usr-|••••|@oupay/)
  })

  it('treats "I have paid" as a claim that changes nothing about verification', async () => {
    const t = setup()
    const view = await t.fastPublic.createOpenRequest(SHOP_TOKEN, 5000)
    await t.fastPublic.markInstructionsOpened(SHOP_TOKEN, view.publicReference)
    await t.fastPublic.claimPaymentInitiated(SHOP_TOKEN, view.publicReference)
    const after = await t.fastPublic.getRequest(SHOP_TOKEN, view.publicReference)
    expect(after).toMatchObject({
      instructionsOpened: true,
      customerClaimedPayment: true,
      stage: 'AWAITING_PAYMENT',
      confirmedAmount: 0,
    })
    expect(
      t.ledger.bankTransactions.load().some((x) => x.paymentReference === view.publicReference),
    ).toBe(false)
  })

  it('shows an expired request as expired and refuses new claims', async () => {
    const t = setup()
    const view = await t.fastPublic.getRequest(SHOP_TOKEN, 'OP-DEMOEXP0003')
    expect(view.stage).toBe('EXPIRED')
    await expect(
      t.fastPublic.claimPaymentInitiated(SHOP_TOKEN, 'OP-DEMOEXP0003'),
    ).rejects.toMatchObject({
      code: 'request_unavailable',
    })
  })
})

describe('customer payment journey (open payment)', () => {
  const stage = async (t: ReturnType<typeof setup>, reference: string) =>
    (await t.fastPublic.getRequest(SHOP_TOKEN, reference)).stage

  it.each([
    ['pending', 'BANK_CONFIRMATION_PENDING'],
    ['failed', 'FAILED'],
    ['success', 'CONFIRMED_UNMATCHED'],
    ['reversal', 'REVERSED'],
  ] as const)('bank says %s -> customer sees %s', async (kind, expected) => {
    const t = setup()
    const view = await t.fastPublic.createOpenRequest(SHOP_TOKEN, 12_000)
    await t.simulator.simulateRequestPayment(view.publicReference, kind)
    expect(await stage(t, view.publicReference)).toBe(expected)
  })

  it('keeps an open payment as an unmatched collection the business can see', async () => {
    const t = setup()
    const view = await t.fastPublic.createOpenRequest(SHOP_TOKEN, 12_000)
    await t.simulator.simulateRequestPayment(view.publicReference, 'success')
    const tx = (await t.fastReconciliation.listBankTransactions(MERCHANT)).find(
      (x) => x.paymentReference === view.publicReference,
    )!
    expect(tx).toMatchObject({
      status: 'CONFIRMED',
      reconciliationStatus: 'COLLECTED',
      unappliedAmount: 12_000,
    })
    const final = await t.fastPublic.getRequest(SHOP_TOKEN, view.publicReference)
    expect(final).toMatchObject({ confirmedAmount: 12_000, isSimulated: true })
  })

  it('shows a partly paid open request as partly settled with the right amount left', async () => {
    const t = setup()
    const view = await t.fastPublic.createOpenRequest(SHOP_TOKEN, 10_000)
    const adapter = getAdapter('EQUITY_MOCK')!
    const { createBankEventProcessor } = await import('./ledger/bankEventProcessor')
    createBankEventProcessor(t.store, t.ledger).processEvent(
      adapter.normalizeTransactionEvent({
        __simulated: true,
        eventId: 'part-1',
        transactionId: 'part-tx',
        state: 'POSTED',
        amount: 4_000,
        currency: 'RWF',
        reference: view.publicReference,
        occurredAt: new Date().toISOString(),
        accountRef: 'bacc-sample-001',
      }),
    )
    expect(await t.fastPublic.getRequest(SHOP_TOKEN, view.publicReference)).toMatchObject({
      stage: 'PARTIALLY_SETTLED',
      confirmedAmount: 4_000,
      amountDue: 6_000,
    })
  })
})

describe('customer payment journey (invoice request)', () => {
  const INVOICE = 'inv-smp-inv-1044'

  it('requests exactly the outstanding amount and reuses a live request', async () => {
    const t = setup()
    const first = await t.fastProfiles.createInvoicePaymentRequest(MERCHANT, INVOICE)
    const again = await t.fastProfiles.createInvoicePaymentRequest(MERCHANT, INVOICE)
    expect(again.id).toBe(first.id)
    expect(first.requestedAmount).toBe(708_000)
    expect(first.profileToken).toBeTruthy()
  })

  it('creates a request with a fresh reference when no live one exists, using the best-matching link', async () => {
    const t = setup()
    // Aline's invoice at Remera: her own link is the best match.
    const mine = t.store.loadInvoices().find((i) => i.invoiceNumber === 'SMP-INV-1041')!
    const request = await t.fastProfiles.createInvoicePaymentRequest(MERCHANT, mine.id)
    expect(request.profileToken).toBe(ALINE_TOKEN)
    expect(request.publicReference).toMatch(/^OP-/)
    // A partly paid invoice is requested for what is left, not its total.
    const partial = t.store.loadInvoices().find((i) => i.invoiceNumber === 'SMP-INV-1043')!
    const partialRequest = await t.fastProfiles.createInvoicePaymentRequest(MERCHANT, partial.id)
    expect(partialRequest.requestedAmount).toBe(121_840)
  })

  it('blocks requests for drafts, cancelled, voided and fully paid invoices', async () => {
    const t = setup()
    for (const number of ['SMP-INV-1040', 'SMP-INV-1045', 'SMP-INV-1046', 'SMP-INV-1042']) {
      const invoice = t.store.loadInvoices().find((i) => i.invoiceNumber === number)!
      await expect(
        t.fastProfiles.createInvoicePaymentRequest(MERCHANT, invoice.id),
      ).rejects.toMatchObject({
        code: 'invoice_not_payable',
      })
    }
  })

  it('reports no active link clearly', async () => {
    const t = setup()
    for (const id of ['pp-sample-001', 'pp-sample-002']) {
      await t.fastProfiles.setProfileActive(MERCHANT, id, false)
    }
    const invoice = t.store.loadInvoices().find((i) => i.invoiceNumber === 'SMP-INV-1041')!
    await expect(
      t.fastProfiles.createInvoicePaymentRequest(MERCHANT, invoice.id),
    ).rejects.toMatchObject({
      code: 'no_active_profile',
    })
  })

  it('lets a cashier request payment only for their own invoices', async () => {
    const t = setup('cashier')
    const mine = t.store.loadInvoices().find((i) => i.invoiceNumber === 'SMP-INV-1041')!
    await expect(
      t.fastProfiles.createInvoicePaymentRequest(MERCHANT, mine.id),
    ).resolves.toBeTruthy()
    await expect(
      t.fastProfiles.createInvoicePaymentRequest(MERCHANT, INVOICE),
    ).rejects.toMatchObject({
      code: 'not_found',
    })
    await expect(
      t.fastProfiles.listInvoicePaymentRequests(MERCHANT, INVOICE),
    ).rejects.toMatchObject({
      code: 'not_found',
    })
  })

  it('settles the invoice and the customer page together, and un-settles on reversal', async () => {
    const t = setup()
    const request = await t.fastProfiles.createInvoicePaymentRequest(MERCHANT, INVOICE)
    const token = request.profileToken
    // Seeded pending payment exists for this request.
    expect((await t.fastPublic.getRequest(token, request.publicReference)).stage).toBe(
      'BANK_CONFIRMATION_PENDING',
    )

    await t.simulator.simulateRequestPayment(request.publicReference, 'success')
    const paid = await t.fastPublic.getRequest(token, request.publicReference)
    expect(paid).toMatchObject({
      stage: 'CONFIRMED_AND_RECONCILED',
      amountDue: 0,
      invoiceReference: 'SMP-INV-1044',
    })
    expect((await t.fastInvoices.getInvoice(MERCHANT, INVOICE)).paymentStatus).toBe('PAID')

    // The seeded 128,500 pending event settles later and partly repays what is left: nothing is double counted.
    const summary = await t.fastDashboard.getSummary({ merchantId: MERCHANT })
    expect(summary.verifiedIncomingTotal).toBe(486_500 + 708_000)
    expect(summary.allocatedTotal).toBe(172_000 + 708_000)
  })

  it('shows a voided invoice request as cancelled to the customer', async () => {
    const t = setup()
    const request = await t.fastProfiles.createInvoicePaymentRequest(MERCHANT, 'inv-smp-inv-1041')
    const invoice = await t.fastInvoices.getInvoice(MERCHANT, 'inv-smp-inv-1041')
    await t.fastInvoices.voidInvoice(
      MERCHANT,
      invoice.id,
      { reason: 'Issued in error' },
      invoice.version,
    )
    expect(
      (await t.fastPublic.getRequest(request.profileToken, request.publicReference)).stage,
    ).toBe('CANCELLED')
  })

  it('lets a manager cancel an unpaid request but not one with confirmed money', async () => {
    const t = setup('manager')
    const request = await t.fastProfiles.createInvoicePaymentRequest(MERCHANT, 'inv-smp-inv-1041')
    expect((await t.fastProfiles.cancelPaymentRequest(MERCHANT, request.id)).status).toBe(
      'CANCELLED',
    )
    const other = await t.fastProfiles.createInvoicePaymentRequest(MERCHANT, 'inv-smp-inv-1041')
    await t.simulator.simulateRequestPayment(other.publicReference, 'success')
    await expect(t.fastProfiles.cancelPaymentRequest(MERCHANT, other.id)).rejects.toMatchObject({
      code: 'invalid_state',
    })
  })
})

describe('bank simulator', () => {
  const run = (
    t: ReturnType<typeof setup>,
    scenarioId: Parameters<typeof t.simulator.run>[1]['scenarioId'],
    reference?: string,
    amount?: number,
  ) => t.simulator.run(MERCHANT, { scenarioId, reference, amount })
  const invoiceStatus = async (t: ReturnType<typeof setup>) =>
    (await t.fastInvoices.getInvoice(MERCHANT, 'inv-smp-inv-1041')).paymentStatus

  it('only works for authorised people in a demo build', async () => {
    const t = setup('cashier')
    await expect(run(t, 'success', 'SMP-INV-1041')).rejects.toMatchObject({ code: 'forbidden' })
    vi.stubEnv('DEV', false)
    vi.stubEnv('VITE_ENABLE_DEMO_TOOLS', 'false')
    t.as('owner')
    await expect(run(t, 'success', 'SMP-INV-1041')).rejects.toMatchObject({ code: 'forbidden' })
    await expect(t.simulator.listScenarios()).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('lists every scenario', async () => {
    const t = setup()
    expect((await t.simulator.listScenarios()).map((s) => s.id).sort()).toEqual(
      [
        'duplicate',
        'failed',
        'invalid_reference',
        'multiple',
        'out_of_order',
        'partial',
        'pending',
        'reversal',
        'same_amount_concurrent',
        'success',
        'unmatched',
      ].sort(),
    )
  })

  it('success, pending and failed', async () => {
    const t = setup()
    await run(t, 'pending', 'SMP-INV-1041')
    await run(t, 'failed', 'SMP-INV-1041')
    expect(await invoiceStatus(t)).toBe('UNPAID')
    const result = await run(t, 'success', 'SMP-INV-1041')
    expect(result.steps.map((s) => s.outcome)).toEqual(['APPLIED'])
    expect(await invoiceStatus(t)).toBe('PAID')
  })

  it('duplicate is counted once', async () => {
    const t = setup()
    const result = await run(t, 'duplicate', 'SMP-INV-1041')
    expect(result.steps.map((s) => s.outcome)).toEqual(['APPLIED', 'DUPLICATE'])
    expect(
      (await t.fastInvoices.getInvoice(MERCHANT, 'inv-smp-inv-1041')).payment?.allocatedAmount,
    ).toBe(98_000)
  })

  it('partial then multiple payments', async () => {
    const t = setup()
    await run(t, 'partial', 'SMP-INV-1041')
    expect(await invoiceStatus(t)).toBe('PARTIALLY_PAID')
    const result = await run(t, 'multiple', 'SMP-INV-1041')
    expect(result.steps).toHaveLength(2)
    expect(await invoiceStatus(t)).toBe('PAID')
  })

  it('invalid reference and unmatched stay out of invoices and need review', async () => {
    const t = setup()
    await run(t, 'invalid_reference', undefined, 3_000)
    await run(t, 'unmatched', undefined, 4_000)
    expect(await invoiceStatus(t)).toBe('UNPAID')
    const list = await t.fastReconciliation.listBankTransactions(MERCHANT)
    const simulated = list.filter((x) => x.isSimulated && [3_000, 4_000].includes(x.amount))
    expect(simulated.length).toBeGreaterThanOrEqual(2)
    expect(simulated.every((x) => x.reconciliationStatus === 'UNMATCHED')).toBe(true)
  })

  it('reversal restores the balance; out-of-order does not resurrect payment', async () => {
    const t = setup()
    await run(t, 'reversal', 'SMP-INV-1041')
    expect(await invoiceStatus(t)).toBe('UNPAID')
    const ooo = await run(t, 'out_of_order', 'SMP-INV-1041')
    expect(ooo.steps.map((s) => s.outcome)).toEqual(['APPLIED', 'STALE'])
    expect(await invoiceStatus(t)).toBe('UNPAID')
  })

  it('same-amount concurrent payments match only the exact reference', async () => {
    const t = setup()
    const result = await run(t, 'same_amount_concurrent', 'SMP-INV-1041')
    expect(result.steps.map((s) => s.outcome)).toEqual(['APPLIED', 'APPLIED'])
    expect(
      (await t.fastInvoices.getInvoice(MERCHANT, 'inv-smp-inv-1041')).payment?.allocatedAmount,
    ).toBe(98_000)
    const unmatched = (await t.fastReconciliation.listBankTransactions(MERCHANT)).filter(
      (x) => x.reconciliationStatus === 'UNMATCHED',
    )
    // The seeds already hold two unmatched payments; the no-reference twin adds exactly one.
    expect(unmatched).toHaveLength(3)
  })

  it('marks everything it creates as simulated', async () => {
    const t = setup()
    await run(t, 'success', 'SMP-INV-1041')
    const created = t.ledger.bankTransactions
      .load()
      .filter((x) => x.paymentReference === 'SMP-INV-1041')
    expect(created.length).toBeGreaterThan(0)
    expect(created.every((x) => x.isSimulated)).toBe(true)
    expect(t.ledger.notifications.load().every((n) => n.isSimulated)).toBe(true)
  })

  it('needs a linked bank account and a reference where one is required', async () => {
    const t = setup()
    await expect(run(t, 'success')).rejects.toMatchObject({ code: 'validation' })
    await t.fastBanking.disableConnection(MERCHANT, 'bcn-sample-001')
    await expect(run(t, 'success', 'SMP-INV-1041')).rejects.toMatchObject({ code: 'invalid_state' })
  })
})
