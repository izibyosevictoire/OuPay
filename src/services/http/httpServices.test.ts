import { AuthServiceError } from '@/services/authService'
import { InvoiceServiceError } from '@/services/invoiceService'
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

  it('auth: recovery calls carry tokens in the BODY (never a URL) and keep the error codes', async () => {
    const { http, calls } = setup(
      {},
      {},
      {},
      { status: 400, body: { code: 'expired_token', message: 'expired' } },
      { status: 400, body: { code: 'invalid_token', message: 'bad' } },
      { status: 422, body: { code: 'validation', message: 'The password is too short.' } },
      {},
      {},
      {},
    )
    const auth = createHttpAuthService(http)
    await auth.requestPasswordReset('a@b.rw')
    await auth.verifyPasswordResetToken('tok-1')
    await auth.resetPassword({ token: 'tok-1', newPassword: 'New-pass-1' })
    await expect(auth.verifyPasswordResetToken('tok-2')).rejects.toMatchObject({
      name: 'AuthServiceError',
      code: 'expired_token',
    })
    await expect(auth.confirmEmailVerification('tok-3')).rejects.toMatchObject({
      code: 'invalid_token',
    })
    // The server's own message survives, so the UI can show why a password was refused.
    await expect(
      auth.changePassword({ currentPassword: 'old', newPassword: 'x' }),
    ).rejects.toMatchObject({ message: 'The password is too short.' })
    await auth.changePassword({ currentPassword: 'old-1', newPassword: 'New-pass-2' })
    await auth.requestEmailVerification()
    await auth.confirmEmailVerification('tok-4')
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'POST /api/v1/auth/password-reset/request',
      'POST /api/v1/auth/password-reset/verify',
      'POST /api/v1/auth/password-reset/confirm',
      'POST /api/v1/auth/password-reset/verify',
      'POST /api/v1/auth/email-verification/confirm',
      'POST /api/v1/auth/password/change',
      'POST /api/v1/auth/password/change',
      'POST /api/v1/auth/email-verification/request',
      'POST /api/v1/auth/email-verification/confirm',
    ])
    expect(calls[0]?.body).toEqual({ email: 'a@b.rw' })
    expect(calls[2]?.body).toEqual({ token: 'tok-1', newPassword: 'New-pass-1' })
    expect(calls.every((call) => !call.url.includes('tok-'))).toBe(true)
  })

  it('merchant settings use the business-scoped settings path and keep error codes', async () => {
    const settings = { merchantId: M, operatingMode: 'SIMPLIFIED', version: 1 }
    const { http, calls } = setup(
      { body: { merchantId: M, operatingMode: 'BUSINESS', version: 0 } },
      { body: settings },
      { status: 409, body: { code: 'version_conflict', message: 'Changed elsewhere.' } },
      { status: 403, body: { code: 'forbidden', message: 'No.' } },
    )
    const merchants = createHttpMerchantService(http)
    expect(await merchants.getMerchantSettings(M)).toMatchObject({ operatingMode: 'BUSINESS' })
    expect(
      await merchants.updateMerchantSettings(M, {
        operatingMode: 'SIMPLIFIED',
        expectedVersion: 0,
      }),
    ).toEqual(settings)
    await expect(
      merchants.updateMerchantSettings(M, { operatingMode: 'BUSINESS', expectedVersion: 0 }),
    ).rejects.toMatchObject({ name: 'MerchantServiceError', code: 'version_conflict' })
    await expect(
      merchants.updateMerchantSettings(M, { operatingMode: 'BUSINESS', expectedVersion: 1 }),
    ).rejects.toMatchObject({ code: 'forbidden' })
    expect(calls[0]).toMatchObject({ method: 'GET', url: `/api/v1/merchants/${M}/settings` })
    expect(calls[1]).toMatchObject({
      method: 'PUT',
      url: `/api/v1/merchants/${M}/settings`,
      body: { operatingMode: 'SIMPLIFIED', expectedVersion: 0 },
    })
  })

  it('registering a business sends the chosen operating mode', async () => {
    const { http, calls } = setup({ body: { id: M } })
    await createHttpMerchantService(http).createMerchant({
      operatingMode: 'SIMPLIFIED',
    } as never)
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: '/api/v1/merchants',
      body: { operatingMode: 'SIMPLIFIED' },
    })
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

  it('staff: role and status changes and invitations are real calls', async () => {
    const { http, calls } = setup(
      { body: {} },
      { body: {} },
      { body: { id: 'inv-1', status: 'PENDING' } },
      { body: [] },
      { body: { email: 'x@y.rw', status: 'PENDING' } },
      { body: { id: 'mem-9', status: 'ACTIVE' } },
      {
        status: 400,
        body: { code: 'invalid_invitation', message: 'This invitation is not valid.' },
      },
      { status: 403, body: { code: 'invitation_email_mismatch', message: 'wrong address' } },
      { status: 409, body: { code: 'duplicate_invitation', message: 'already invited' } },
    )
    const staff = createHttpStaffService(http)
    await staff.updateMembershipRole(M, 'mem-1', 'MANAGER')
    await staff.suspendMembership(M, 'mem-1')
    await staff.inviteStaff(M, {
      email: 'x@y.rw',
      role: 'CASHIER',
      branchIds: ['b1'],
      note: 'Welcome',
    })
    await staff.listInvitations(M)
    await staff.getInvitationPreview('tok/with space')
    await staff.acceptInvitation('tok-1')
    await expect(staff.acceptInvitation('bad')).rejects.toMatchObject({
      name: 'OrganizationServiceError',
      code: 'invalid_invitation',
    })
    await expect(staff.acceptInvitation('other')).rejects.toMatchObject({
      code: 'invitation_email_mismatch',
    })
    await expect(
      staff.inviteStaff(M, { email: 'x@y.rw', role: 'CASHIER', branchIds: [] }),
    ).rejects.toMatchObject({ code: 'duplicate_invitation' })
    expect(calls[0]).toMatchObject({
      method: 'PUT',
      url: `/api/v1/merchants/${M}/memberships/mem-1/role`,
      body: { role: 'MANAGER' },
    })
    expect(calls[1]).toMatchObject({
      method: 'POST',
      url: `/api/v1/merchants/${M}/memberships/mem-1/suspend`,
    })
    expect(calls[2]).toMatchObject({
      method: 'POST',
      url: `/api/v1/merchants/${M}/invitations`,
      body: { email: 'x@y.rw', role: 'CASHIER', branchIds: ['b1'], note: 'Welcome' },
    })
    expect(calls[3]).toMatchObject({ method: 'GET', url: `/api/v1/merchants/${M}/invitations` })
    // The link token is path-encoded: it can never break out of the path.
    expect(calls[4]).toMatchObject({
      method: 'GET',
      url: '/api/v1/public/invitations/tok%2Fwith%20space',
    })
    expect(calls[5]).toMatchObject({ method: 'POST', url: '/api/v1/invitations/tok-1/accept' })
  })

  it('paginated lists follow the cursor so the UI still receives every item, in server order', async () => {
    const { http, calls } = setup(
      { body: { items: [{ id: 't3' }, { id: 't2' }], nextCursor: 'c1' } },
      { body: { items: [{ id: 't1' }], nextCursor: null } },
      { body: { items: [{ id: 'a1' }] } },
      { body: { items: [{ id: 'n2' }], nextCursor: 'n-c' } },
      { body: { items: [{ id: 'n1' }] } },
    )
    const reconciliation = createHttpReconciliationService(http)
    const transactions = await reconciliation.listBankTransactions(M)
    expect(transactions.map((t) => t.id)).toEqual(['t3', 't2', 't1'])
    expect(calls[0]?.url).toBe(`/api/v1/merchants/${M}/bank-transactions?limit=200`)
    expect(calls[1]?.url).toBe(`/api/v1/merchants/${M}/bank-transactions?limit=200&cursor=c1`)
    expect((await reconciliation.listAllocations(M)).map((a) => a.id)).toEqual(['a1'])
    const notifications = await createHttpNotificationService(http).listNotifications(M)
    expect(notifications.map((n) => n.id)).toEqual(['n2', 'n1'])
    expect(calls[4]?.url).toBe(`/api/v1/merchants/${M}/notifications?limit=200&cursor=n-c`)
  })

  it('invoices: an explicit limit is one page, no limit means everything', async () => {
    const { http, calls } = setup(
      { body: { items: [{ id: 'i1' }], totalCount: 5, nextCursor: 'next' } },
      { body: { items: [{ id: 'i2' }], totalCount: 5, nextCursor: null } },
      { body: { items: [{ id: 'i5' }, { id: 'i4' }], nextCursor: 'x' } },
      { body: { items: [{ id: 'i3' }], nextCursor: null } },
    )
    const invoices = createHttpInvoiceService(http)
    const first = await invoices.listInvoices(M, { limit: 1 })
    expect(first).toMatchObject({ totalCount: 5, nextCursor: 'next' })
    await invoices.listInvoices(M, { limit: 1, cursor: 'next' })
    const all = await invoices.listInvoices(M)
    expect(all.items.map((i) => i.id)).toEqual(['i5', 'i4', 'i3'])
    expect(all).toMatchObject({ totalCount: 3, nextCursor: null })
    expect(calls[0]?.url).toBe(`/api/v1/merchants/${M}/invoices?limit=1`)
    expect(calls[1]?.url).toBe(`/api/v1/merchants/${M}/invoices?limit=1&cursor=next`)
    expect(calls[2]?.url).toBe(`/api/v1/merchants/${M}/invoices?limit=200`)
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
