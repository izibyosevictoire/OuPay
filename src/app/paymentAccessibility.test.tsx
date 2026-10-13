import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { findAccessibilityViolations } from '@/test/axe'
import { getActiveTestBackend, useFastBackend } from '@/test/merchantTestDouble'
import { renderAppAt } from '@/test/renderApp'

beforeEach(() => {
  useFastBackend()
})

const noViolations = async (container: Element) =>
  expect(await findAccessibilityViolations(container)).toEqual([])

describe('accessibility: transactions and payments', () => {
  it('transactions list for an owner and for a cashier, and an empty result', async () => {
    const user = userEvent.setup()
    const owner = await renderAppAt('/transactions')
    await screen.findByRole('table', { name: 'Bank transactions' })
    await noViolations(owner.container)
    await user.type(screen.getByRole('searchbox', { name: 'Search' }), 'zzzz')
    await screen.findByText('No transactions match')
    await noViolations(owner.container)
    owner.unmount()

    const cashier = await renderAppAt('/transactions', { signedInAs: 'cashier' })
    await screen.findByRole('table', { name: 'Bank transactions' })
    await noViolations(cashier.container)
  })

  it.each(['btx-001', 'btx-004', 'btx-006', 'btx-007', 'btx-008'])(
    'transaction details %s',
    async (id) => {
      const { container } = await renderAppAt(`/transactions/${id}`)
      await screen.findByRole('heading', { name: 'History' })
      await noViolations(container)
    },
  )

  it('transaction not found', async () => {
    const { container } = await renderAppAt('/transactions/btx-101')
    await screen.findByRole('heading', { level: 1, name: 'Transaction not found' })
    await noViolations(container)
  })

  it('payments tabs, history, and the cashier view', async () => {
    const user = userEvent.setup()
    const owner = await renderAppAt('/payments')
    await screen.findByText('SMP-INV-9999')
    await noViolations(owner.container)
    await user.click(screen.getByRole('tab', { name: /Allocation history/ }))
    await screen.findAllByText(/SMP-INV-1043/)
    await noViolations(owner.container)
    owner.unmount()
    const cashier = await renderAppAt('/payments', { signedInAs: 'cashier' })
    await screen.findAllByText(/SMP-INV-1042/)
    await noViolations(cashier.container)
  })

  it('the allocation, review and reversal dialogs', async () => {
    const user = userEvent.setup()
    const { container } = await renderAppAt('/payments')
    const card = (await screen.findByText('No reference')).closest('li')!
    await user.click(within(card).getByRole('button', { name: /Apply to invoices/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Apply money to invoices' })
    await within(dialog).findByLabelText(/SMP-INV-1041/)
    await user.click(within(dialog).getByRole('button', { name: 'Apply to invoices' }))
    await within(dialog).findByRole('alert')
    await noViolations(container.ownerDocument.body)
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    await user.click(
      within((await screen.findByText('SMP-INV-9999')).closest('li')!).getByRole('button', {
        name: /Mark as reviewed/,
      }),
    )
    await screen.findByRole('dialog', { name: 'Mark as reviewed' })
    await noViolations(container.ownerDocument.body)
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    await user.click(await screen.findByRole('tab', { name: /Allocation history/ }))
    await user.click((await screen.findAllByRole('button', { name: /Reverse/ }))[0]!)
    await screen.findByRole('dialog', { name: /Reverse the allocation/ })
    await noViolations(container.ownerDocument.body)
  })

  it('the notification menu, empty and with items', async () => {
    const user = userEvent.setup()
    const empty = await renderAppAt('/')
    await user.click(await screen.findByRole('button', { name: /^Notifications/ }))
    await screen.findByText(/You are all caught up/)
    await noViolations(empty.container.ownerDocument.body)
    empty.unmount()

    const backend = getActiveTestBackend()
    backend.signInAs('owner')
    await backend.fastSimulator.run('mrc-sample-001', {
      scenarioId: 'partial',
      reference: 'SMP-INV-1041',
    })
    const full = await renderAppAt('/')
    await user.click(await screen.findByRole('button', { name: /^Notifications, \d+ unread/ }))
    await screen.findAllByText('Invoice SMP-INV-1041 partly paid')
    await noViolations(full.container.ownerDocument.body)
  })
})

describe('accessibility: banking and payment links', () => {
  it('banking page, with a link error showing', async () => {
    const user = userEvent.setup()
    const { container } = await renderAppAt('/banking')
    await screen.findByText('Connected (demo)')
    await noViolations(container)
    await user.click(screen.getByRole('button', { name: /Disable.*Main collections account/ }))
    await screen.findByRole('dialog', { name: /Disable Main collections account/ })
    await noViolations(container.ownerDocument.body)
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await user.type(screen.getByLabelText(/Account name/), 'Second')
    await user.type(screen.getByLabelText(/Demo account reference/), 'nope')
    await user.click(screen.getByRole('button', { name: 'Start demo link' }))
    await screen.findByRole('alert')
    await noViolations(container)
  })

  it('payment links list, the create dialog, the cashier view and an empty list', async () => {
    const user = userEvent.setup()
    const owner = await renderAppAt('/payment-links')
    await screen.findByRole('link', { name: 'Shop counter' })
    await noViolations(owner.container)
    await user.click(screen.getByRole('button', { name: /New link/ }))
    await screen.findByRole('dialog', { name: 'New payment link' })
    await screen.findByLabelText(/^Name/)
    await noViolations(owner.container.ownerDocument.body)
    owner.unmount()
    const cashier = await renderAppAt('/payment-links', { signedInAs: 'cashier' })
    await screen.findByRole('link', { name: 'Aline at Remera Main' })
    await noViolations(cashier.container)
  })

  it.each(['pp-sample-001', 'pp-sample-003', 'pp-sample-004'])(
    'payment link details %s (QR, NFC, status)',
    async (id) => {
      const { container } = await renderAppAt(`/payment-links/${id}`)
      await screen.findByRole('heading', { level: 1 })
      await screen.findByRole('heading', { name: 'Details' })
      await noViolations(container)
    },
  )

  it('the switch-off and replace confirmations', async () => {
    const user = userEvent.setup()
    const { container } = await renderAppAt('/payment-links/pp-sample-001')
    await user.click(await screen.findByRole('button', { name: 'Switch off' }))
    await screen.findByRole('dialog', { name: 'Switch this link off?' })
    await noViolations(container.ownerDocument.body)
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: 'Replace link' }))
    await screen.findByRole('dialog', { name: 'Replace this link?' })
    await noViolations(container.ownerDocument.body)
  })

  it('the printable QR sign', async () => {
    const { container } = await renderAppAt('/payment-links/pp-sample-001/print')
    await screen.findByRole('article', { name: /Payment sign/ })
    await noViolations(container)
  })

  it('an invoice with a payment panel and an open request', async () => {
    const { container } = await renderAppAt('/invoices/inv-smp-inv-1044')
    await screen.findByRole('heading', { name: 'Payment' })
    await screen.findByRole('link', { name: /Open customer page/ })
    await noViolations(container)
  })

  it('the dashboard with the new payment figures, for an owner and a cashier', async () => {
    const owner = await renderAppAt('/')
    await screen.findByText('Verified incoming')
    await screen.findAllByText('SMP-INV-1042')
    await noViolations(owner.container)
    owner.unmount()
    const cashier = await renderAppAt('/', { signedInAs: 'cashier' })
    await screen.findByText('My verified payments')
    await noViolations(cashier.container)
  })

  it('the bank simulator page and its result', async () => {
    const user = userEvent.setup()
    const { container } = await renderAppAt('/demo/bank-simulator')
    await screen.findByRole('heading', { level: 1, name: 'Bank simulator' })
    await noViolations(container)
    await user.type(screen.getByLabelText('Reference'), 'SMP-INV-1041')
    await user.click(screen.getByRole('button', { name: 'Run simulation' }))
    await screen.findByRole('heading', { name: 'Result' })
    await noViolations(container)
  })
})

describe('accessibility: public customer pages', () => {
  const page = (path: string) => renderAppAt(path, { signedInAs: null })

  it('profile page, unavailable page and unknown page', async () => {
    const live = await page('/p/Bn7wL3cYp9Ds')
    await screen.findByRole('heading', { level: 1, name: 'Sample Shop' })
    await noViolations(live.container)
    live.unmount()
    const dead = await page('/p/Hs5tV2jMq8Gf')
    await screen.findByText('This payment link is not available')
    await noViolations(dead.container)
    dead.unmount()
    const unknown = await page('/p/NoSuchToken1')
    await screen.findByText('Payment page not found')
    await noViolations(unknown.container)
  })

  it('request page: awaiting, pending, confirmed, failed, reversed, expired', async () => {
    const user = userEvent.setup()
    const { fastPublic } = getActiveTestBackend()
    const live = await page('/p/Rk4mQ8vTz2Xn')
    await user.type(await screen.findByLabelText(/Amount to pay/), '5000')
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByTestId('payment-reference')
    await noViolations(live.container)
    // Each bank outcome is a separate payment, so each gets its own request.
    for (const [button, text] of [
      ['Bank pending', 'Waiting for the bank to confirm'],
      ['Bank fails', 'Payment failed'],
      ['Confirm then reverse', 'Payment reversed'],
      ['Bank confirms', 'Confirmed by the bank'],
    ] as const) {
      const request = await fastPublic.createOpenRequest('Rk4mQ8vTz2Xn', 5000)
      await live.router.navigate('/p/Rk4mQ8vTz2Xn/r/' + request.publicReference)
      await waitFor(() =>
        expect(screen.getByTestId('payment-reference')).toHaveTextContent(request.publicReference),
      )
      await user.click(await screen.findByRole('button', { name: button }))
      await screen.findByText(text)
      await noViolations(live.container)
    }
    live.unmount()

    const expired = await page('/p/Rk4mQ8vTz2Xn/r/OP-DEMOEXP0003')
    await screen.findByText(/has expired/)
    await noViolations(expired.container)
  })
})
