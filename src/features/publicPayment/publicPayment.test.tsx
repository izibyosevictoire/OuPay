import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { getActiveTestBackend, useFastBackend } from '@/test/merchantTestDouble'
import { renderAppAt } from '@/test/renderApp'

const SHOP = 'Rk4mQ8vTz2Xn'
const ALINE = 'Bn7wL3cYp9Ds'

beforeEach(() => {
  useFastBackend()
})

const publicPage = (path: string) => renderAppAt(path, { signedInAs: null })

/** Opens the page for a fresh open payment of `amount` and returns its reference. */
async function startOpenPayment(amount = '12000') {
  const user = userEvent.setup()
  await publicPage(`/p/${SHOP}`)
  await user.type(await screen.findByLabelText(/Amount to pay/), amount)
  await user.click(screen.getByRole('button', { name: 'Continue' }))
  const reference = await screen.findByTestId('payment-reference')
  return { user, reference: reference.textContent! }
}

const status = () =>
  screen.getByRole('heading', { name: /Payment status/ }).closest('div')!.parentElement!

describe('public payment page (profile)', () => {
  it('is mobile first, needs no sign-in and shows only public information', async () => {
    await publicPage(`/p/${ALINE}`)
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Sample Shop' }),
    ).toBeInTheDocument()
    expect(screen.getByText(/Remera Main/)).toHaveTextContent('Served by Aline U.')
    // No app chrome: no navigation, no account menu, no sign-in prompt.
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Account menu/ })).not.toBeInTheDocument()
    expect(screen.queryByText(/Dashboard/)).not.toBeInTheDocument()
    // Nothing private leaks into the page.
    const text = document.body.textContent ?? ''
    for (const secret of [
      'Uwase',
      '@oupay',
      '+250',
      'bacc-',
      '••••4821',
      'mrc-sample',
      'usr-demo',
    ]) {
      expect(text).not.toContain(secret)
    }
    expect(screen.getByText(/never share a pin/i)).toBeInTheDocument()
  })

  it('does not show a verified mark for a business that is still pending verification', async () => {
    await publicPage(`/p/${SHOP}`)
    await screen.findByRole('heading', { level: 1, name: 'Sample Shop' })
    expect(screen.queryByText('Verified business')).not.toBeInTheDocument()
  })

  it('explains an unknown link and an unavailable link without revealing the business', async () => {
    const unknown = await publicPage('/p/NoSuchToken1')
    expect(await screen.findByText('Payment page not found')).toBeInTheDocument()
    unknown.unmount()

    for (const token of ['Hs5tV2jMq8Gf', 'Zc6uE4nWr1Ka']) {
      const dead = await publicPage(`/p/${token}`)
      expect(await screen.findByText('This payment link is not available')).toBeInTheDocument()
      expect(document.body.textContent).not.toContain('Sample Shop')
      dead.unmount()
    }
  })

  it('validates the amount before creating a request', async () => {
    const user = userEvent.setup()
    await publicPage(`/p/${SHOP}`)
    await user.type(await screen.findByLabelText(/Amount to pay/), '50')
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/between/)
    expect(getActiveTestBackend().ledger.paymentRequests.load().length).toBe(3)
  })

  it('shows a loading state, then an error state with a retry', async () => {
    const getProfile = vi.spyOn((await import('@/services')).publicPaymentService, 'getProfile')
    getProfile.mockRejectedValue(new Error('network'))
    await publicPage(`/p/${SHOP}`)
    expect(await screen.findByText('This payment page could not be loaded.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })
})

describe('public payment page (open payment journey)', () => {
  it('creates a request with the chosen amount in RWF and a high-entropy reference', async () => {
    const { reference } = await startOpenPayment('12000')
    expect(reference).toMatch(/^OP-[2-9A-HJKMNP-Z]{12}$/)
    expect(screen.getByText(/RWF\s*12,000/)).toBeInTheDocument()
    expect(screen.getByText(/Fixed amount in Rwandan francs/)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'How to pay' })).toBeInTheDocument()
    expect(screen.getByText(/Equity Bank merchant payment/)).toBeInTheDocument()
    // Unavailable methods are not offered.
    expect(screen.queryByText(/MTN MoMo/)).not.toBeInTheDocument()
    expect(screen.getByRole('note')).toHaveTextContent(/this page uses a simulated bank connection/)
  })

  it('records that instructions were opened without claiming anything is paid', async () => {
    await startOpenPayment()
    await waitFor(() =>
      expect(within(status()).getByText(/You opened the instructions/)).toBeInTheDocument(),
    )
    expect(within(status()).getByText('Waiting for payment')).toBeInTheDocument()
    expect(screen.queryByText(/paid and confirmed/i)).not.toBeInTheDocument()
  })

  it('"I have started my payment" is a claim and never a confirmation', async () => {
    const { user } = await startOpenPayment()
    await user.click(await screen.findByRole('button', { name: 'I have started my payment' }))
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'I have started my payment' }),
      ).not.toBeInTheDocument(),
    )
    const panel = status()
    expect(within(panel).getByText('Waiting for payment')).toBeInTheDocument()
    expect(within(panel).getByText(/We are waiting for your payment/)).toBeInTheDocument()
    expect(within(panel).queryByText(/Paid and confirmed/)).not.toBeInTheDocument()
    expect(within(panel).queryByText(/The bank confirmed/)).not.toBeInTheDocument()
    expect(getActiveTestBackend().ledger.bankTransactions.load().length).toBe(10)
  })

  it('walks pending, then confirmed: confirmed money is "confirmed", not yet matched to an invoice', async () => {
    const { user } = await startOpenPayment()
    await user.click(await screen.findByRole('button', { name: 'Bank pending' }))
    expect(await screen.findByText('Waiting for the bank to confirm')).toBeInTheDocument()
    expect(screen.getByText(/has not confirmed it yet/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Bank confirms' }))
    expect(await screen.findByText('Confirmed by the bank')).toBeInTheDocument()
    expect(screen.getByText(/has not been applied to an invoice yet/)).toBeInTheDocument()
    // The payment instructions disappear once nothing more is owed.
    expect(screen.queryByRole('heading', { name: 'How to pay' })).not.toBeInTheDocument()
  })

  it('shows a failed payment clearly and lets the customer try again', async () => {
    const { user } = await startOpenPayment()
    await user.click(await screen.findByRole('button', { name: 'Bank fails' }))
    expect(await screen.findByText('Payment failed')).toBeInTheDocument()
    expect(screen.getByText(/No money was taken/)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'How to pay' })).toBeInTheDocument()
  })

  it('shows a reversed payment as reversed, never as paid', async () => {
    const { user } = await startOpenPayment()
    await user.click(await screen.findByRole('button', { name: 'Confirm then reverse' }))
    expect(await screen.findByText('Payment reversed')).toBeInTheDocument()
    expect(screen.queryByText(/Paid and confirmed/)).not.toBeInTheDocument()
    expect(screen.getByText(/bank reversed this payment/)).toBeInTheDocument()
  })

  it('refreshes by itself while waiting', async () => {
    const { reference } = await startOpenPayment()
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /Payment status/ })).toBeInTheDocument(),
    )
    // The bank confirms out of band (not through this page).
    await getActiveTestBackend().fastSimulator.simulateRequestPayment(reference, 'success')
    expect(
      await screen.findByText('Confirmed by the bank', {}, { timeout: 6000 }),
    ).toBeInTheDocument()
  }, 15_000)
})

describe('public payment page (invoice payment request)', () => {
  const openInvoiceRequest = async () => {
    const { fastProfiles, signInAs } = getActiveTestBackend()
    signInAs('owner')
    const request = await fastProfiles.createInvoicePaymentRequest(
      'mrc-sample-001',
      'inv-smp-inv-1043',
    )
    const view = await publicPage(`/p/${request.profileToken}/r/${request.publicReference}`)
    return { request, view }
  }

  it('shows the invoice and the actual remaining balance as a fixed amount', async () => {
    await openInvoiceRequest()
    expect(await screen.findByText('Invoice SMP-INV-1043')).toBeInTheDocument()
    // 221,840 total, 100,000 already bank-confirmed.
    expect(screen.getByText(/RWF\s*121,840/)).toBeInTheDocument()
    expect(screen.getByText(/Fixed amount/)).toBeInTheDocument()
    expect(screen.queryByLabelText(/Amount to pay/)).not.toBeInTheDocument()
  })

  it('shows a partly paid invoice request as partly paid with the rest still to pay', async () => {
    const { request } = await openInvoiceRequest()
    await getActiveTestBackend().fastSimulator.run('mrc-sample-001', {
      scenarioId: 'partial',
      reference: request.publicReference,
    })
    expect(await screen.findByText('Partly paid', {}, { timeout: 6000 })).toBeInTheDocument()
    // Shown under the amount and again in the progress list.
    expect(screen.getAllByText(/The bank confirmed RWF\s*60,920/).length).toBeGreaterThan(0)
  }, 15_000)

  it('shows the settled invoice as paid and confirmed by the bank, and the business sees it too', async () => {
    const { request } = await openInvoiceRequest()
    await getActiveTestBackend().fastSimulator.simulateRequestPayment(
      request.publicReference,
      'success',
    )
    expect(
      await screen.findByText('Paid and confirmed by the bank', {}, { timeout: 6000 }),
    ).toBeInTheDocument()
    expect(
      (await getActiveTestBackend().fastInvoices.getInvoice('mrc-sample-001', 'inv-smp-inv-1043'))
        .paymentStatus,
    ).toBe('PAID')
  }, 15_000)

  it('shows a voided invoice request as cancelled and offers no payment instructions', async () => {
    const { request } = await openInvoiceRequest()
    const backend = getActiveTestBackend()
    const stored = backend.store.loadInvoices().find((i) => i.id === 'inv-smp-inv-1043')!
    backend.store.saveInvoices(
      backend.store
        .loadInvoices()
        .map((i) => (i.id === stored.id ? { ...i, status: 'VOIDED' as const } : i)),
    )
    expect(request.publicReference).toBeTruthy()
    expect(await screen.findByText('Cancelled', {}, { timeout: 6000 })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'How to pay' })).not.toBeInTheDocument()
  }, 15_000)

  it('shows an expired request as expired, with no way to claim payment', async () => {
    await publicPage(`/p/${SHOP}/r/OP-DEMOEXP0003`)
    expect(await screen.findByText('Expired', { selector: 'span' })).toBeInTheDocument()
    expect(screen.getByText(/has expired/)).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'I have started my payment' }),
    ).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'How to pay' })).not.toBeInTheDocument()
  })

  it('treats a request opened through the wrong link as not found', async () => {
    await publicPage(`/p/${ALINE}/r/OP-DEMO000001`)
    expect(await screen.findByText('Payment request not found')).toBeInTheDocument()
  })

  it('shows the seeded pending bank payment as waiting for confirmation', async () => {
    await publicPage(`/p/${ALINE}/r/OP-DEMOINV0044`)
    expect(await screen.findByText('Waiting for the bank to confirm')).toBeInTheDocument()
    expect(screen.getByText(/Invoice SMP-INV-1044/)).toBeInTheDocument()
  })
})
