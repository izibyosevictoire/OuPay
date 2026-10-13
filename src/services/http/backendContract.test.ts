import { createHmac } from 'node:crypto'
import { MerchantServiceError } from '@/services/merchantService'
import { createHttpClient } from './httpClient'
import {
  createHttpAuthService,
  createHttpBankingService,
  createHttpBranchService,
  createHttpDashboardService,
  createHttpInvoiceService,
  createHttpMerchantService,
  createHttpNotificationService,
  createHttpPaymentProfileService,
  createHttpPublicPaymentService,
  createHttpReconciliationService,
  createHttpStaffService,
} from './httpServices'

/**
 * LIVE CONTRACT TEST. It runs the frontend's real HTTP services against a running backend, so the
 * two sides are proven to agree (paths, JSON shapes, error codes, cookies, CSRF).
 *
 * Opt-in: it needs a backend started with the `dev` profile (see docs/backend.md).
 *   OUPAY_BACKEND_URL=http://localhost:8080 npx vitest run src/services/http/backendContract.test.ts
 */
const BACKEND = process.env.OUPAY_BACKEND_URL
const SIMULATOR_SECRET = process.env.OUPAY_SIMULATOR_SECRET ?? 'dev-only-simulator-secret-change-me'

/** A tiny "browser": it keeps cookies like a browser would and exposes the readable XSRF cookie. */
function createBrowser() {
  const jar = new Map<string, string>()
  const fetchImpl = (async (url: RequestInfo | URL, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    if (jar.size > 0) headers.set('Cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '))
    const response = await fetch(`${BACKEND}${String(url)}`, { ...init, headers })
    for (const cookie of response.headers.getSetCookie()) {
      const [pair = ''] = cookie.split(';')
      const index = pair.indexOf('=')
      const name = pair.slice(0, index)
      const value = pair.slice(index + 1)
      if (/max-age=0/i.test(cookie) || value === '') jar.delete(name)
      else jar.set(name, value)
    }
    return response
  }) as typeof fetch
  const http = createHttpClient({ baseUrl: '', fetchImpl, readCookie: (name) => jar.get(name) })
  return { http, jar, fetchImpl }
}

const unique = Date.now().toString(36)
const nineDigits = () => String(100_000_000 + Math.floor(Math.random() * 899_999_999))

describe.skipIf(!BACKEND)('frontend HTTP services against the live backend', () => {
  it('runs the whole journey: register, business, branch, invoice, link, bank event, settlement', async () => {
    const owner = createBrowser()
    const base = '/api/v1'
    const http = createHttpClient({
      baseUrl: base,
      fetchImpl: owner.fetchImpl,
      readCookie: (n) => owner.jar.get(n),
    })
    const auth = createHttpAuthService(http)

    // 1. Sign up: the session is a server cookie; nothing sensitive reaches JavaScript.
    const session = await auth.register({
      fullName: 'Contract Owner',
      email: `owner-${unique}@example.rw`,
      phoneNumber: '+250788123456',
      password: 'Correct-horse-9',
    })
    expect(session.user.email).toContain(unique)
    expect(JSON.stringify(session)).not.toMatch(/password|hash/i)
    expect(owner.jar.has('oupay_session')).toBe(true)
    expect((await auth.getCurrentSession())?.user.id).toBe(session.user.id)

    // 2. A business: pending verification, with the caller as its owner.
    const merchant = await createHttpMerchantService(http).createMerchant({
      legalName: `Contract Shop ${unique}`,
      businessType: 'registered_company',
      registration: { tin: nineDigits(), registrationNumber: `RC-${unique}` },
      location: {
        country: 'RW',
        province: 'Kigali City',
        district: 'Gasabo',
        sector: 'Remera',
        physicalAddress: 'KG 11 Ave',
      },
      contact: {
        fullName: 'Contract Owner',
        email: 'contact@example.rw',
        phoneNumber: '+250788123456',
      },
    })
    expect(merchant.status).toBe('pending_verification')
    const merchantId = merchant.id

    // 3. A branch, and the owner works there.
    const branches = createHttpBranchService(http)
    const branch = await branches.createBranch(merchantId, {
      name: 'Remera Main',
      code: 'RM01',
      status: 'ACTIVE',
      location: {
        province: 'Kigali City',
        district: 'Gasabo',
        sector: 'Remera',
        physicalAddress: 'KG 11 Ave',
      },
    })
    const staff = await createHttpStaffService(http).listStaff(merchantId)
    const ownerMembership = staff.find((member) => member.userId === session.user.id)!
    expect(ownerMembership.role).toBe('OWNER')
    await branches.updateBranchAssignments(merchantId, ownerMembership.membershipId, [branch.id])

    // 4. An invoice: the server computes every amount.
    const invoices = createHttpInvoiceService(http)
    const options = await invoices.getInvoiceFormOptions(merchantId)
    expect(options.assignees.map((a) => a.userId)).toContain(session.user.id)
    const dueAt = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10)
    const draft = await invoices.createDraft(merchantId, {
      branchId: branch.id,
      assignedToUserId: session.user.id,
      customer: { name: 'Imena Stationery' },
      items: [
        {
          description: 'Cement bags',
          quantity: 10,
          unitPrice: 12_500,
          discount: 0,
          taxRate: { category: 'STANDARD', rateBp: 1800 },
        },
      ],
      taxMode: 'EXCLUSIVE',
      dueAt,
    })
    expect(draft.grandTotal).toBe(147_500)
    expect(draft.paymentStatus).toBe('UNPAID')
    const issued = await invoices.issueInvoice(merchantId, draft.id, draft.version)
    expect(issued.status).toBe('ISSUED')

    // 5. Banking and a payment link, then a customer-facing request for exactly the balance.
    const banking = createHttpBankingService(http)
    const providers = await banking.listProviders()
    expect(providers.find((p) => p.id === 'MTN_MOMO')?.capabilities.transactionWebhooks).toBe(
      'UNCONFIRMED',
    )
    const link = await banking.startAccountLink(merchantId, {
      providerId: 'EQUITY_MOCK',
      accountReference: 'SIM-4821',
      accountNickname: 'Main account',
    })
    expect(link.maskedAccount).toBe('••••4821')
    await banking.completeAccountLink(merchantId, link.id)
    const destinations = await banking.listPaymentDestinations(merchantId)
    const profiles = createHttpPaymentProfileService(http)
    const profile = await profiles.createProfile(merchantId, {
      label: 'Shop counter',
      paymentDestinationId: destinations[0]!.id,
    })
    const request = await profiles.createInvoicePaymentRequest(merchantId, issued.id)
    expect(request.requestedAmount).toBe(147_500)

    // 6. The CUSTOMER (no session, no cookies) sees only public information.
    const customer = createBrowser()
    const publicService = createHttpPublicPaymentService(
      createHttpClient({
        baseUrl: base,
        fetchImpl: customer.fetchImpl,
        readCookie: (n) => customer.jar.get(n),
      }),
    )
    const publicProfile = await publicService.getProfile(profile.paymentProfileId)
    expect(publicProfile.status).toBe('ACTIVE')
    expect(JSON.stringify(publicProfile)).not.toContain(merchantId)
    const before = await publicService.getRequest(profile.paymentProfileId, request.publicReference)
    expect(before.stage).toBe('AWAITING_PAYMENT')
    expect(before.amountDue).toBe(147_500)
    await publicService.claimPaymentInitiated(profile.paymentProfileId, request.publicReference)
    expect(
      (await publicService.getRequest(profile.paymentProfileId, request.publicReference)).stage,
    ).toBe('AWAITING_PAYMENT')
    expect(customer.jar.size).toBe(0)

    // 7. Only the (simulated) BANK can confirm: a signed event at the provider boundary.
    const event = JSON.stringify({
      simulated: true,
      eventId: `evt-${unique}`,
      transactionId: `tx-${unique}`,
      state: 'POSTED',
      amount: 147_500,
      currency: 'RWF',
      reference: request.publicReference,
      payerName: 'Contract Payer',
      occurredAt: new Date().toISOString(),
      accountRef: link.bankAccountId,
    })
    const unsigned = await customer.fetchImpl(`${base}/integrations/equity-mock/events`, {
      method: 'POST',
      body: event,
    })
    expect(unsigned.status).toBe(401)
    const signature = createHmac('sha256', SIMULATOR_SECRET).update(event).digest('hex')
    const delivered = await customer.fetchImpl(`${base}/integrations/equity-mock/events`, {
      method: 'POST',
      body: event,
      headers: { 'X-OuPay-Simulator-Signature': signature, 'Content-Type': 'application/json' },
    })
    expect(delivered.status).toBe(200)
    expect(((await delivered.json()) as { outcome: string }).outcome).toBe('APPLIED')

    // 8. Everything follows from the one ledger.
    expect((await invoices.getInvoice(merchantId, issued.id)).paymentStatus).toBe('PAID')
    expect(
      (await publicService.getRequest(profile.paymentProfileId, request.publicReference)).stage,
    ).toBe('CONFIRMED_AND_RECONCILED')
    const transactions =
      await createHttpReconciliationService(http).listBankTransactions(merchantId)
    expect(transactions).toHaveLength(1)
    expect(transactions[0]).toMatchObject({
      status: 'CONFIRMED',
      reconciliationStatus: 'FULLY_ALLOCATED',
      isSimulated: true,
    })
    const summary = await createHttpDashboardService(http).getSummary({ merchantId })
    expect(summary).toMatchObject({
      verifiedIncomingTotal: 147_500,
      allocatedTotal: 147_500,
      unappliedConfirmedTotal: 0,
    })
    const notifications = await createHttpNotificationService(http).listNotifications(merchantId)
    expect(notifications.map((n) => n.kind)).toContain('INVOICE_SETTLED')

    // 9. Another business's user gets "not found", with the contract's own error type.
    const outsider = createBrowser()
    const outsiderHttp = createHttpClient({
      baseUrl: base,
      fetchImpl: outsider.fetchImpl,
      readCookie: (n) => outsider.jar.get(n),
    })
    await createHttpAuthService(outsiderHttp).register({
      fullName: 'Outsider',
      email: `outsider-${unique}@example.rw`,
      phoneNumber: '',
      password: 'Correct-horse-9',
    })
    await expect(
      createHttpMerchantService(outsiderHttp).getMerchantById(merchantId),
    ).rejects.toBeInstanceOf(MerchantServiceError)
    await expect(
      createHttpMerchantService(outsiderHttp).getMerchantById(merchantId),
    ).rejects.toMatchObject({ code: 'not_found' })
    await expect(
      createHttpInvoiceService(outsiderHttp).getInvoice(merchantId, issued.id),
    ).rejects.toMatchObject({ code: 'not_found' })

    // 10. Logging out ends the session on the server.
    const stolen = new Map(owner.jar)
    await auth.logout()
    expect(await auth.getCurrentSession()).toBeNull()
    const replay = createBrowser()
    for (const [k, v] of stolen) replay.jar.set(k, v)
    const replayAuth = createHttpAuthService(
      createHttpClient({
        baseUrl: base,
        fetchImpl: replay.fetchImpl,
        readCookie: (n) => replay.jar.get(n),
      }),
    )
    expect(await replayAuth.getCurrentSession()).toBeNull()
  }, 120_000)
})
