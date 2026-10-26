import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PRIMARY_NAVIGATION } from '@/constants/navigation'
import { checkoutService, invoiceService, paymentProfileService } from '@/services'
import { CheckoutServiceError } from '@/services/checkoutService'
import { SAMPLE_MERCHANT_ID } from '@/services/mock/sampleMerchants'
import { SAMPLE_BRANCH_IDS } from '@/services/mock/sampleOrganization'
import { findAccessibilityViolations } from '@/test/axe'
import { getActiveTestBackend, useFastBackend, type DemoUserKey } from '@/test/merchantTestDouble'
import { renderAppAt } from '@/test/renderApp'
import { buildRequestUrl } from '@/lib/paymentLinks'
import type { OperatingMode } from '@/types/merchant'

type User = ReturnType<typeof userEvent.setup>

async function openCollect(
  signedInAs: DemoUserKey = 'manager',
  mode: OperatingMode = 'SIMPLIFIED',
) {
  const backend = getActiveTestBackend()
  if (mode === 'SIMPLIFIED') {
    backend.signInAs('owner')
    await backend.fastMerchants.updateMerchantSettings(SAMPLE_MERCHANT_ID, {
      operatingMode: 'SIMPLIFIED',
      expectedVersion: 0,
    })
  }
  return renderAppAt('/collect', { signedInAs })
}

const amountField = () => screen.findByLabelText(/Amount \(RWF\)/)
const bill = (user: User) => user.click(screen.getByRole('button', { name: /^(Bill|Try again)$/ }))

async function billAmount(user: User, amount: string, description?: string) {
  await user.type(await amountField(), amount)
  if (description) await user.type(screen.getByLabelText(/Description/), description)
  await bill(user)
}

beforeEach(() => {
  useFastBackend()
})

describe('Collect Payment: the form', () => {
  it('has one page heading, a labelled amount and an optional description, and passes axe', async () => {
    const { container } = await openCollect()
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Collect Payment' }),
    ).toBeInTheDocument()
    const amount = await amountField()
    expect(amount).toHaveAttribute('inputmode', 'numeric')
    expect(amount).toBeRequired()
    expect(screen.getByLabelText(/Description/)).not.toBeRequired()
    // A single branch is chosen automatically: no selector.
    expect(screen.queryByLabelText(/^Branch/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Bill' })).toBeEnabled()
    expect(await findAccessibilityViolations(container)).toEqual([])
  })

  it('validates the amount in the browser without calling the service', async () => {
    const user = userEvent.setup()
    await openCollect()
    await amountField()
    await bill(user)
    expect(await screen.findByText('Enter the amount to collect.')).toBeInTheDocument()

    for (const [typed, expected] of [
      ['12.5', /whole francs only/i],
      ['50', /between RWF 100 and RWF 10,000,000/],
      ['10000001', /between RWF 100 and RWF 10,000,000/],
    ] as const) {
      await user.clear(await amountField())
      await user.type(await amountField(), typed)
      await bill(user)
      expect(await screen.findByText(expected)).toBeInTheDocument()
    }
    expect(await amountField()).toHaveAttribute('aria-invalid', 'true')
    expect(checkoutService.billSimpleCheckout).not.toHaveBeenCalled()
  })

  it('shows the branch selector only when there is a choice, and requires it', async () => {
    const user = userEvent.setup()
    await openCollect('cashier')
    const branch = await screen.findByLabelText(/^Branch/)
    expect(branch).toBeRequired()
    await user.type(await amountField(), '3000')
    await bill(user)
    expect(await screen.findByText('Choose the branch you are billing for.')).toBeInTheDocument()
    expect(checkoutService.billSimpleCheckout).not.toHaveBeenCalled()

    await user.selectOptions(branch, SAMPLE_BRANCH_IDS.cityCentre)
    await bill(user)
    // The sale is on screen: its receipt names the branch it was billed at.
    expect(await screen.findByText(/· City Centre/)).toBeInTheDocument()
    await screen.findByRole('img', { name: /QR code/ })
    expect(checkoutService.billSimpleCheckout).toHaveBeenCalledWith(
      SAMPLE_MERCHANT_ID,
      expect.objectContaining({ amountRwf: 3000, branchId: SAMPLE_BRANCH_IDS.cityCentre }),
    )
  })
})

describe('Collect Payment: after Bill', () => {
  it('shows the locked amount, the QR code of the right link, and the status as the server reports it', async () => {
    const user = userEvent.setup()
    const { container } = await openCollect()
    await billAmount(user, '25,000', 'Moto ride')

    expect(await screen.findByText('RWF 25,000', { selector: 'p' })).toBeInTheDocument()
    expect(screen.getByText(/Moto ride · INV-/)).toBeInTheDocument()
    expect(screen.getByText('Awaiting payment')).toBeInTheDocument()
    expect(screen.queryByText('Payment confirmed')).not.toBeInTheDocument()

    // The QR code encodes exactly the customer's payment URL, which is also what Copy puts on the clipboard.
    const backend = getActiveTestBackend()
    const created = backend.ledger.paymentRequests.load().at(-1)!
    const token = backend.ledger.paymentProfiles
      .load()
      .find((p) => p.id === created.paymentProfileId)!.paymentProfileId
    const url = buildRequestUrl(token, created.publicReference)
    const qr = screen.getByRole('img', { name: /QR code for the payment of RWF\s25,000/ })
    expect(qr).toHaveAttribute('data-qr-value', url)
    expect(screen.getByText(url)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Open customer page/ })).toHaveAttribute(
      'href',
      `/p/${token}/r/${created.publicReference}`,
    )
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Collect Payment')
    expect(await findAccessibilityViolations(container)).toEqual([])

    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await user.click(screen.getByRole('button', { name: /Copy payment link/ }))
    expect(writeText).toHaveBeenCalledWith(url)
  })

  it('offers sharing only where the browser supports it', async () => {
    const user = userEvent.setup()
    await openCollect()
    await billAmount(user, '1000')
    await screen.findByRole('button', { name: /Copy payment link/ })
    expect(screen.queryByRole('button', { name: /Share link/ })).not.toBeInTheDocument()
  })

  it('shares the link when the browser can', async () => {
    const share = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'share', { value: share, configurable: true })
    try {
      const user = userEvent.setup()
      await openCollect()
      await billAmount(user, '1000')
      await user.click(await screen.findByRole('button', { name: /Share link/ }))
      expect(share).toHaveBeenCalledWith(
        expect.objectContaining({ url: expect.stringContaining('/p/') }),
      )
    } finally {
      Reflect.deleteProperty(navigator, 'share')
    }
  })

  it('shows "Payment confirmed" only after the bank-verified payment is read back from the server', async () => {
    const user = userEvent.setup()
    await openCollect()
    await billAmount(user, '20000')
    await screen.findByRole('img', { name: /QR code/ })

    const backend = getActiveTestBackend()
    const created = backend.ledger.paymentRequests.load().at(-1)!
    // A customer saying they paid does not count: the page still waits for the bank.
    await backend.fastPublic.claimPaymentInitiated(
      backend.ledger.paymentProfiles.load().find((p) => p.id === created.paymentProfileId)!
        .paymentProfileId,
      created.publicReference,
    )
    await user.click(screen.getByRole('button', { name: 'Check now' }))
    expect(screen.queryByText('Payment confirmed')).not.toBeInTheDocument()

    await backend.fastSimulator.simulateRequestPayment(created.publicReference, 'success')
    // Until the page reads the server again it still says what it last knew.
    expect(screen.queryByText('Payment confirmed')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Check now' }))
    expect(await screen.findByText('Payment confirmed')).toBeInTheDocument()
    // A finished sale no longer offers its QR code, and starting another needs no confirmation.
    expect(screen.queryByRole('img', { name: /QR code/ })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'New payment' }))
    expect(await amountField()).toHaveValue('')
  })

  it('shows an expired request as expired, not as paid', async () => {
    const user = userEvent.setup()
    await openCollect()
    await billAmount(user, '4000')
    await screen.findByRole('img', { name: /QR code/ })
    const backend = getActiveTestBackend()
    backend.ledger.paymentRequests.save(
      backend.ledger.paymentRequests
        .load()
        .map((r, index, all) =>
          index === all.length - 1
            ? { ...r, expiresAt: new Date(Date.now() - 60_000).toISOString() }
            : r,
        ),
    )
    await user.click(screen.getByRole('button', { name: 'Check now' }))
    expect(await screen.findByText('Expired')).toBeInTheDocument()
    expect(screen.queryByText('Payment confirmed')).not.toBeInTheDocument()
    expect(screen.queryByRole('img', { name: /QR code/ })).not.toBeInTheDocument()
  })

  it('asks before leaving a payment that is still open, and starts a fresh sale after', async () => {
    const user = userEvent.setup()
    await openCollect()
    await billAmount(user, '6000')
    await screen.findByRole('img', { name: /QR code/ })

    await user.click(screen.getByRole('button', { name: 'New payment' }))
    expect(screen.getByRole('alert')).toHaveTextContent(/still open/)
    await user.click(screen.getByRole('button', { name: 'Keep this payment' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('img', { name: /QR code/ })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'New payment' }))
    await user.click(screen.getByRole('button', { name: 'Yes, start a new payment' }))
    // Same amount again is a NEW sale (new identifiers), not the first one repeated.
    await billAmount(user, '6000')
    await screen.findByRole('img', { name: /QR code/ })
    const calls = vi.mocked(checkoutService.billSimpleCheckout).mock.calls
    expect(calls).toHaveLength(2)
    expect(calls[0]?.[1].clientRequestId).not.toBe(calls[1]?.[1].clientRequestId)
    expect(
      getActiveTestBackend()
        .store.loadInvoices()
        .filter((i) => i.saleChannel === 'SIMPLIFIED'),
    ).toHaveLength(2)
  })

  it('brings the sale back after a refresh', async () => {
    const user = userEvent.setup()
    const first = await openCollect()
    await billAmount(user, '8000')
    await screen.findByRole('img', { name: /QR code/ })
    first.unmount()
    await renderAppAt('/collect', { signedInAs: 'manager' })
    expect(
      await screen.findByRole('img', { name: /QR code for the payment of RWF\s8,000/ }),
    ).toBeInTheDocument()
  })
})

describe('Collect Payment: failures and retries', () => {
  it('shows a busy state while billing and never double-submits', async () => {
    const user = userEvent.setup()
    await openCollect()
    let release: () => void = () => undefined
    const real = getActiveTestBackend().fastCheckout.billSimpleCheckout
    vi.mocked(checkoutService.billSimpleCheckout).mockImplementationOnce(
      (merchantId, input) =>
        new Promise((resolve, reject) => {
          release = () => void real(merchantId, input).then(resolve, reject)
        }),
    )
    await user.type(await amountField(), '2000')
    await bill(user)
    const busy = await screen.findByRole('button', { name: 'Billing…' })
    expect(busy).toBeDisabled()
    await user.click(busy)
    release()
    await screen.findByRole('img', { name: /QR code/ })
    expect(checkoutService.billSimpleCheckout).toHaveBeenCalledTimes(1)
  })

  it('keeps what was typed after a lost answer and a retry sends the SAME sale identifiers', async () => {
    const user = userEvent.setup()
    await openCollect()
    vi.mocked(checkoutService.billSimpleCheckout).mockRejectedValueOnce(
      new CheckoutServiceError('service_unavailable', 'The service is not reachable.'),
    )
    await user.type(await amountField(), '9000')
    await bill(user)
    expect(await screen.findByRole('alert')).toHaveTextContent(/never billed twice/)
    expect(await amountField()).toHaveValue('9000')

    await user.click(screen.getByRole('button', { name: 'Try again' }))
    await screen.findByRole('img', { name: /QR code/ })
    const calls = vi.mocked(checkoutService.billSimpleCheckout).mock.calls
    expect(calls).toHaveLength(2)
    expect(calls[1]?.[1].clientRequestId).toBe(calls[0]?.[1].clientRequestId)
    expect(calls[1]?.[1].idempotencyKey).toBe(calls[0]?.[1].idempotencyKey)
  })

  it('changing the sale after a failure uses new identifiers', async () => {
    const user = userEvent.setup()
    await openCollect()
    vi.mocked(checkoutService.billSimpleCheckout).mockRejectedValueOnce(
      new CheckoutServiceError('service_unavailable', 'The service is not reachable.'),
    )
    await user.type(await amountField(), '9000')
    await bill(user)
    await screen.findByRole('alert')
    await user.clear(await amountField())
    await user.type(await amountField(), '9500')
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    await screen.findByRole('img', { name: /QR code/ })
    const calls = vi.mocked(checkoutService.billSimpleCheckout).mock.calls
    expect(calls[1]?.[1].clientRequestId).not.toBe(calls[0]?.[1].clientRequestId)
  })

  it("shows the server's refusal in plain words", async () => {
    const user = userEvent.setup()
    await openCollect()
    vi.mocked(checkoutService.billSimpleCheckout).mockRejectedValueOnce(
      new CheckoutServiceError(
        'no_active_profile',
        'There is no active payment link for this invoice.',
      ),
    )
    await user.type(await amountField(), '9000')
    await bill(user)
    expect(await screen.findByRole('alert')).toHaveTextContent('There is no active payment link')
    expect(screen.queryByRole('img', { name: /QR code/ })).not.toBeInTheDocument()
  })

  it('offers a retry when the page itself cannot load', async () => {
    const user = userEvent.setup()
    vi.mocked(checkoutService.getSimpleCheckoutOptions).mockRejectedValueOnce(
      new CheckoutServiceError('service_unavailable', 'down'),
    )
    await openCollect()
    expect(await screen.findByText('Collect Payment could not be loaded.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await amountField()).toBeInTheDocument()
  })
})

describe('Collect Payment: setup and mode', () => {
  it('tells an owner with no branch assignment what to do, without creating anything', async () => {
    await openCollect('owner')
    expect(
      await screen.findByRole('heading', {
        level: 2,
        name: 'You need a branch to collect payments',
      }),
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Create or review branches' })).toHaveAttribute(
      'href',
      '/branches',
    )
    expect(screen.getByRole('link', { name: 'assign yourself to one' })).toHaveAttribute(
      'href',
      '/cashiers',
    )
    expect(screen.queryByLabelText(/Amount/)).not.toBeInTheDocument()
  })

  it('tells a business in business mode that payments are collected through invoices', async () => {
    await openCollect('manager', 'BUSINESS')
    expect(
      await screen.findByRole('heading', {
        level: 2,
        name: 'Collect Payment is for simplified businesses',
      }),
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Create an invoice' })).toHaveAttribute(
      'href',
      '/invoices/new',
    )
    expect(screen.queryByLabelText(/Amount/)).not.toBeInTheDocument()
  })

  it('asks for a payment link first when none can collect', async () => {
    const backend = getActiveTestBackend()
    backend.ledger.paymentProfiles.save(
      backend.ledger.paymentProfiles.load().map((p) => ({ ...p, status: 'INACTIVE' as const })),
    )
    await openCollect('manager')
    expect(
      await screen.findByRole('heading', { level: 2, name: 'A payment link is needed first' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Set up a payment link' })).toHaveAttribute(
      'href',
      '/payment-links',
    )
  })

  it('labels demo mode and never claims real bank confirmation', async () => {
    await openCollect()
    const notice = await screen.findByRole('note')
    expect(notice).toHaveTextContent('Demo mode.')
    expect(notice).toHaveTextContent(/Nothing here moves real money/)
    expect(within(notice).queryByText(/confirmed by your bank/i)).not.toBeInTheDocument()
  })
})

describe('Collect Payment: navigation', () => {
  it('is declared for SIMPLIFIED businesses with the permission to create invoices, and nowhere else', () => {
    const entry = PRIMARY_NAVIGATION.find((item) => item.path === '/collect')
    expect(entry).toMatchObject({
      label: 'Collect Payment',
      permission: 'invoices:create',
      requiresMode: 'SIMPLIFIED',
    })
    // Only Collect Payment (simplified), Catalog and Inventory (business) are mode-specific; nothing existing was hidden or replaced.
    expect(
      PRIMARY_NAVIGATION.filter((item) => item.requiresMode).map((item) => item.path),
    ).toEqual(['/collect', '/catalog', '/inventory'])
    for (const path of [
      '/',
      '/invoices',
      '/payments',
      '/payment-links',
      '/banking',
      '/reports',
      '/settings',
    ]) {
      expect(PRIMARY_NAVIGATION.some((item) => item.path === path)).toBe(true)
    }
  })

  it('appears in a simplified business next to every existing entry, and not in a business-mode one', async () => {
    const backend = getActiveTestBackend()
    backend.signInAs('owner')
    await backend.fastMerchants.updateMerchantSettings(SAMPLE_MERCHANT_ID, {
      operatingMode: 'SIMPLIFIED',
      expectedVersion: 0,
    })
    const simplified = await renderAppAt('/invoices', { signedInAs: 'manager' })
    const nav = await screen.findByRole('navigation', { name: 'Primary' })
    await within(nav).findByRole('link', { name: 'Collect Payment' })
    for (const name of [
      'Dashboard',
      'Invoices',
      'Payments',
      'Payment links',
      'Reports',
      'Settings',
    ]) {
      expect(within(nav).getByRole('link', { name })).toBeInTheDocument()
    }
    simplified.unmount()

    backend.signInAs('owner')
    await backend.fastMerchants.updateMerchantSettings(SAMPLE_MERCHANT_ID, {
      operatingMode: 'BUSINESS',
      expectedVersion: 1,
    })
    await renderAppAt('/invoices', { signedInAs: 'manager' })
    const businessNav = await screen.findByRole('navigation', { name: 'Primary' })
    await within(businessNav).findByRole('link', { name: 'Invoices' })
    await waitFor(() =>
      expect(
        within(businessNav).queryByRole('link', { name: 'Collect Payment' }),
      ).not.toBeInTheDocument(),
    )
  })

  it('cashiers get it in a simplified business too, because they may create invoices', async () => {
    const backend = getActiveTestBackend()
    backend.signInAs('owner')
    await backend.fastMerchants.updateMerchantSettings(SAMPLE_MERCHANT_ID, {
      operatingMode: 'SIMPLIFIED',
      expectedVersion: 0,
    })
    await renderAppAt('/invoices', { signedInAs: 'cashier' })
    const nav = await screen.findByRole('navigation', { name: 'Primary' })
    expect(await within(nav).findByRole('link', { name: 'Collect Payment' })).toHaveAttribute(
      'href',
      '/collect',
    )
  })
})

describe('Collect Payment: safety review', () => {
  it('a double-click on Bill starts one operation', async () => {
    const user = userEvent.setup()
    await openCollect()
    await user.type(await amountField(), '3000')
    await user.dblClick(screen.getByRole('button', { name: 'Bill' }))
    await screen.findByRole('img', { name: /QR code/ })
    expect(checkoutService.billSimpleCheckout).toHaveBeenCalledTimes(1)
    expect(
      getActiveTestBackend()
        .store.loadInvoices()
        .filter((i) => i.saleChannel === 'SIMPLIFIED'),
    ).toHaveLength(1)
  })

  it('moves focus to the first field that needs fixing', async () => {
    const user = userEvent.setup()
    await openCollect()
    await amountField()
    await bill(user)
    expect(await screen.findByText('Enter the amount to collect.')).toBeInTheDocument()
    expect(await amountField()).toHaveFocus()
  })

  it('never shows one person the sale another person left on the same tab', async () => {
    const user = userEvent.setup()
    const first = await openCollect('manager')
    await billAmount(user, '4000')
    await screen.findByRole('img', { name: /QR code/ })
    first.unmount()
    // Same business, same tab, a different signed-in person: an empty form, not the manager's sale.
    await renderAppAt('/collect', { signedInAs: 'cashier' })
    expect(await screen.findByLabelText(/^Branch/)).toBeInTheDocument()
    expect(screen.queryByRole('img', { name: /QR code/ })).not.toBeInTheDocument()
  })

  it('drops a remembered sale the server no longer shows to this person', async () => {
    const backend = getActiveTestBackend()
    backend.signInAs('owner')
    await backend.fastMerchants.updateMerchantSettings(SAMPLE_MERCHANT_ID, {
      operatingMode: 'SIMPLIFIED',
      expectedVersion: 0,
    })
    window.sessionStorage.setItem(
      `oupay.checkout.sale.${SAMPLE_MERCHANT_ID}.${'usr-demo-manager'}`,
      JSON.stringify({
        invoiceId: 'inv-does-not-exist',
        invoiceNumber: 'INV-0001',
        paymentRequestId: 'pr-gone',
        publicReference: 'OP-ABCDEFGH',
        amountRwf: 5000,
        currency: 'RWF',
        description: 'Payment',
        status: 'AWAITING_PAYMENT',
        expiresAt: '2030-01-01T00:30:00Z',
        createdAt: '2030-01-01T00:00:00Z',
        merchantDisplayName: 'Sample Shop',
        branchId: SAMPLE_BRANCH_IDS.remera,
        branchName: 'Remera Main',
        profileToken: 'Rk4mQ8vTz2Xn',
        paymentPath: '/p/Rk4mQ8vTz2Xn/r/OP-ABCDEFGH',
      }),
    )
    await renderAppAt('/collect', { signedInAs: 'manager' })
    expect(await amountField()).toBeInTheDocument()
    expect(screen.queryByRole('img', { name: /QR code/ })).not.toBeInTheDocument()
    expect(
      window.sessionStorage.getItem(`oupay.checkout.sale.${SAMPLE_MERCHANT_ID}.usr-demo-manager`),
    ).toBeNull()
  })

  it('reports the exact remaining balance of a partly paid sale', async () => {
    const user = userEvent.setup()
    await openCollect()
    await billAmount(user, '20000')
    await screen.findByRole('img', { name: /QR code/ })
    const real = await invoiceService.getInvoice(
      SAMPLE_MERCHANT_ID,
      getActiveTestBackend().store.loadInvoices().at(-1)!.id,
    )
    vi.mocked(invoiceService.getInvoice).mockResolvedValue({
      ...real,
      paymentStatus: 'PARTIALLY_PAID',
      payment: {
        invoiceTotal: 20_000,
        allocatedAmount: 8_000,
        remainingBalance: 12_000,
        unappliedAmount: 0,
        paymentStatus: 'PARTIALLY_PAID',
      },
    })
    const requests = await paymentProfileService.listInvoicePaymentRequests(
      SAMPLE_MERCHANT_ID,
      real.id,
    )
    vi.mocked(paymentProfileService.listInvoicePaymentRequests).mockResolvedValue(
      requests.map((r) => ({ ...r, status: 'PARTIALLY_SETTLED' as const })),
    )
    await user.click(screen.getByRole('button', { name: 'Check now' }))
    expect(await screen.findByText('Partly paid')).toBeInTheDocument()
    expect(
      screen.getByText('RWF 8,000 confirmed by the bank. RWF 12,000 is still due.'),
    ).toBeInTheDocument()
    expect(screen.queryByText('Payment confirmed')).not.toBeInTheDocument()
  })

  it('stops saying Paid when the bank reverses the payment', async () => {
    const user = userEvent.setup()
    await openCollect()
    await billAmount(user, '20000')
    await screen.findByRole('img', { name: /QR code/ })
    const backend = getActiveTestBackend()
    const reference = backend.ledger.paymentRequests.load().at(-1)!.publicReference
    await backend.fastSimulator.simulateRequestPayment(reference, 'success')
    await user.click(screen.getByRole('button', { name: 'Check now' }))
    expect(await screen.findByText('Payment confirmed')).toBeInTheDocument()

    // The server now reports the reversal (the demo simulator cannot reverse a settled request, so the reading is stubbed;
    // the backend's own reversal handling is proven in the integration tests).
    const paid = await invoiceService.getInvoice(
      SAMPLE_MERCHANT_ID,
      backend.store.loadInvoices().at(-1)!.id,
    )
    vi.mocked(invoiceService.getInvoice).mockResolvedValue({ ...paid, paymentStatus: 'UNPAID' })
    const requests = await paymentProfileService.listInvoicePaymentRequests(
      SAMPLE_MERCHANT_ID,
      paid.id,
    )
    vi.mocked(paymentProfileService.listInvoicePaymentRequests).mockResolvedValue(
      requests.map((r) => ({ ...r, status: 'AWAITING_PAYMENT' as const })),
    )
    await user.click(screen.getByRole('button', { name: 'Check now' }))
    await waitFor(() => expect(screen.queryByText('Payment confirmed')).not.toBeInTheDocument())
    expect(await screen.findByText('Awaiting payment')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: /QR code/ })).toBeInTheDocument()
  })

  it('has exactly one page heading and no heading made of the amount', async () => {
    const user = userEvent.setup()
    await openCollect()
    await billAmount(user, '1500')
    await screen.findByRole('img', { name: /QR code/ })
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    for (const heading of screen.getAllByRole('heading', { level: 2 })) {
      expect(heading.textContent).not.toMatch(/\d/)
    }
  })
})
