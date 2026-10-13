import { AuthServiceError } from '@/services/authService'
import { InvoiceServiceError } from '@/services/invoiceService'
import { OrganizationServiceError } from '@/services/organizationService'
import { PaymentServiceError } from '@/services/paymentServiceError'
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

interface Call {
  method: string
  url: string
  body: unknown
}

/** A fake server: records calls and answers with the next queued response. */
function setup(...responses: { status?: number; body?: unknown }[]) {
  const calls: Call[] = []
  const queue = [...responses]
  const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      method: init?.method ?? 'GET',
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    })
    const next = queue.shift() ?? { status: 204 }
    if (next.status === 204 || (next.body === undefined && !next.status)) {
      return new Response(null, { status: 204 })
    }
    return new Response(JSON.stringify(next.body ?? {}), { status: next.status ?? 200 })
  }) as unknown as typeof fetch
  const http = createHttpClient({ baseUrl: '/api/v1', fetchImpl, readCookie: () => 'csrf' })
  return { http, calls, fetchImpl }
}

const M = 'mrc-1'

describe('HTTP-backed services keep the frontend contracts', () => {
  it('auth: login posts credentials plus rememberMe and returns the session', async () => {
    const { http, calls } = setup({ body: { user: { id: 'u1' }, memberships: [], expiresAt: 'x' } })
    const session = await createHttpAuthService(http).login(
      { email: 'a@b.rw', password: 'pw' },
      { rememberMe: true },
    )
    expect(session.user.id).toBe('u1')
    expect(calls[0]).toEqual({
      method: 'POST',
      url: '/api/v1/auth/login',
      body: { email: 'a@b.rw', password: 'pw', rememberMe: true },
    })
  })

  it('auth: "no session" (204) resolves null and logout posts', async () => {
    const { http, calls } = setup({ status: 204 }, { status: 204 })
    const auth = createHttpAuthService(http)
    expect(await auth.getCurrentSession()).toBeNull()
    await auth.logout()
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /api/v1/auth/session',
      'POST /api/v1/auth/logout',
    ])
  })

  it('auth: server codes become the contract error, unknown ones become service_unavailable', async () => {
    const wrong = setup({ status: 401, body: { code: 'invalid_credentials', message: 'No.' } })
    await expect(
      createHttpAuthService(wrong.http).login({ email: 'a', password: 'b' }, { rememberMe: false }),
    ).rejects.toMatchObject({ name: 'AuthServiceError', code: 'invalid_credentials' })

    const odd = setup({ status: 418, body: { code: 'teapot', message: 'Short and stout.' } })
    await expect(
      createHttpAuthService(odd.http).login({ email: 'a', password: 'b' }, {
        rejectMe: false,
      } as never),
    ).rejects.toBeInstanceOf(AuthServiceError)
    await expect(
      createHttpAuthService(setup({ status: 418, body: { code: 'teapot' } }).http).register({
        fullName: 'x',
        email: 'x',
        phoneNumber: '',
        password: 'x',
      }),
    ).rejects.toMatchObject({ code: 'service_unavailable' })
  })

  it('auth: password reset is honestly unavailable (the server has no email channel yet)', async () => {
    const { http, fetchImpl } = setup()
    const auth = createHttpAuthService(http)
    await expect(auth.requestPasswordReset('a@b.rw')).rejects.toMatchObject({
      code: 'service_unavailable',
    })
    await expect(auth.verifyPasswordResetToken('t')).rejects.toBeInstanceOf(AuthServiceError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('merchants and branches use business-scoped paths and keep error codes', async () => {
    const { http, calls } = setup(
      { body: [] },
      { status: 409, body: { code: 'duplicate_tin', message: 'dup' } },
      { body: [] },
      { status: 409, body: { code: 'duplicate_branch_code', message: 'dup' } },
      { body: {} },
    )
    await createHttpMerchantService(http).listMerchantsForCurrentUser()
    await expect(createHttpMerchantService(http).createMerchant({} as never)).rejects.toMatchObject(
      { name: 'MerchantServiceError', code: 'duplicate_tin' },
    )
    const branches = createHttpBranchService(http)
    await branches.listBranches(M)
    await expect(branches.createBranch(M, {} as never)).rejects.toMatchObject({
      name: 'OrganizationServiceError',
      code: 'duplicate_branch_code',
    })
    await branches.updateBranchAssignments(M, 'mem-1', ['b1', 'b2'])
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /api/v1/merchants',
      'POST /api/v1/merchants',
      `GET /api/v1/merchants/${M}/branches`,
      `POST /api/v1/merchants/${M}/branches`,
      `PUT /api/v1/merchants/${M}/memberships/mem-1/branch-assignments`,
    ])
    expect(calls[4]!.body).toEqual({ branchIds: ['b1', 'b2'] })
  })

  it('staff: role and status changes are real calls, invitations are honestly unavailable', async () => {
    const { http, calls, fetchImpl } = setup({ body: {} }, { body: {} })
    const staff = createHttpStaffService(http)
    await staff.updateMembershipRole(M, 'mem-1', 'MANAGER')
    await staff.suspendMembership(M, 'mem-1')
    expect(calls[0]).toMatchObject({
      method: 'PUT',
      url: `/api/v1/merchants/${M}/memberships/mem-1/role`,
      body: { role: 'MANAGER' },
    })
    expect(calls[1]).toMatchObject({
      method: 'POST',
      url: `/api/v1/merchants/${M}/memberships/mem-1/suspend`,
    })
    const before = fetchImpl as unknown as { mock: { calls: unknown[] } }
    const count = before.mock.calls.length
    await expect(
      staff.inviteStaff(M, { email: 'x@y.rw', role: 'CASHIER', branchIds: [] }),
    ).rejects.toBeInstanceOf(OrganizationServiceError)
    await expect(staff.acceptInvitation('token')).rejects.toMatchObject({
      code: 'service_unavailable',
    })
    expect(before.mock.calls.length).toBe(count)
  })

  it('invoices: optimistic-locking versions travel as query parameters, totals are never sent as authority', async () => {
    const { http, calls } = setup(
      { body: { items: [] } },
      { body: {} },
      { body: {} },
      { status: 409, body: { code: 'version_conflict', message: 'v' } },
    )
    const invoices = createHttpInvoiceService(http)
    await invoices.listInvoices(M, { limit: 4 })
    await invoices.issueInvoice(M, 'inv-1', 7)
    await invoices.voidInvoice(M, 'inv-1', { reason: 'Wrong customer' }, 8)
    await expect(invoices.cancelDraft(M, 'inv-1', 1)).rejects.toMatchObject({
      name: 'InvoiceServiceError',
      code: 'version_conflict',
    })
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET /api/v1/merchants/${M}/invoices?limit=4`,
      `POST /api/v1/merchants/${M}/invoices/inv-1/issue?expectedVersion=7`,
      `POST /api/v1/merchants/${M}/invoices/inv-1/void?expectedVersion=8`,
      `POST /api/v1/merchants/${M}/invoices/inv-1/cancel?expectedVersion=1`,
    ])
    expect(calls[2]!.body).toEqual({ reason: 'Wrong customer' })
    expect(InvoiceServiceError).toBeDefined()
  })

  it('reconciliation: manual allocation carries the versions it was based on', async () => {
    const { http, calls } = setup(
      { body: {} },
      { status: 409, body: { code: 'allocation_conflict', message: 'c' } },
    )
    const reconciliation = createHttpReconciliationService(http)
    const input = {
      bankTransactionId: 'btx-1',
      expectedTransactionVersion: 3,
      allocations: [{ invoiceId: 'inv-1', amount: 1000, expectedRemainingBalance: 1000 }],
    }
    await reconciliation.allocateManually(M, input)
    await expect(
      reconciliation.markReviewed(M, 'btx-1', { note: 'ok', expectedTransactionVersion: 3 }),
    ).rejects.toMatchObject({
      name: 'PaymentServiceError',
      code: 'allocation_conflict',
    })
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: `/api/v1/merchants/${M}/reconciliation/allocations`,
      body: input,
    })
    expect(calls[1]!.url).toBe(`/api/v1/merchants/${M}/bank-transactions/btx-1/review`)
    expect(PaymentServiceError).toBeDefined()
  })

  it('has no way to create or confirm a payment: the contract simply does not contain one', () => {
    const { http } = setup()
    const methods = [
      ...Object.keys(createHttpReconciliationService(http)),
      ...Object.keys(createHttpPublicPaymentService(http)),
      ...Object.keys(createHttpPaymentProfileService(http)),
      ...Object.keys(createHttpInvoiceService(http)),
    ]
    expect(
      methods.filter((name) => /confirm|markPaid|createTransaction|simulate/i.test(name)),
    ).toEqual([])
  })

  it('dashboard, notifications, banking and payment links map onto the documented paths', async () => {
    const { http, calls } = setup()
    await createHttpDashboardService(http).getSummary({ merchantId: M })
    await createHttpDashboardService(http).getRecentTransactions({ merchantId: M }, 8)
    await createHttpNotificationService(http).markAllAsRead(M)
    await createHttpBankingService(http).startAccountLink(M, {
      providerId: 'EQUITY_MOCK',
      accountReference: 'SIM-1234',
      accountNickname: 'Main',
    })
    const profiles = createHttpPaymentProfileService(http)
    await profiles.setProfileActive(M, 'pp-1', false)
    await profiles.createInvoicePaymentRequest(M, 'inv-1')
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET /api/v1/merchants/${M}/dashboard/summary`,
      `GET /api/v1/merchants/${M}/dashboard/recent-transactions?limit=8`,
      `POST /api/v1/merchants/${M}/notifications/read-all`,
      `POST /api/v1/merchants/${M}/bank-connections`,
      `PUT /api/v1/merchants/${M}/payment-profiles/pp-1/active`,
      `POST /api/v1/merchants/${M}/invoices/inv-1/payment-requests`,
    ])
    expect(calls[4]!.body).toEqual({ isActive: false })
  })

  it('public payment pages call only the public API with public tokens', async () => {
    const { http, calls } = setup(
      { body: {} },
      { status: 201, body: {} },
      { body: {} },
      { status: 204 },
      { status: 204 },
    )
    const publicService = createHttpPublicPaymentService(http)
    await publicService.getProfile('Rk4mQ8vTz2Xn')
    await publicService.createOpenRequest('Rk4mQ8vTz2Xn', 12000)
    await publicService.getRequest('Rk4mQ8vTz2Xn', 'OP-ABC')
    await publicService.markInstructionsOpened('Rk4mQ8vTz2Xn', 'OP-ABC')
    await publicService.claimPaymentInitiated('Rk4mQ8vTz2Xn', 'OP-ABC')
    for (const call of calls)
      expect(call.url).toMatch(/^\/api\/v1\/public\/payment-profiles\/Rk4mQ8vTz2Xn/)
    expect(calls[1]!.body).toEqual({ amount: 12000 })
    expect(calls.some((c) => c.url.includes('/merchants/'))).toBe(false)
  })

  it('a server outage is reported as service_unavailable on every contract', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('down')
    }) as unknown as typeof fetch
    const http = createHttpClient({ baseUrl: '/api/v1', fetchImpl, readCookie: () => 'c' })
    await expect(createHttpInvoiceService(http).listInvoices(M)).rejects.toMatchObject({
      code: 'service_unavailable',
    })
    await expect(createHttpBankingService(http).listProviders()).rejects.toMatchObject({
      code: 'service_unavailable',
    })
    await expect(createHttpBranchService(http).listBranches(M)).rejects.toMatchObject({
      code: 'service_unavailable',
    })
  })
})
