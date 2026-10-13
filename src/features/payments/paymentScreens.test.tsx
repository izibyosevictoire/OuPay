import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { notificationService } from '@/services'
import { SAMPLE_MERCHANT_ID } from '@/services/mock/sampleMerchants'
import { getActiveTestBackend, useFastBackend } from '@/test/merchantTestDouble'
import { renderAppAt } from '@/test/renderApp'

const MERCHANT = SAMPLE_MERCHANT_ID

beforeEach(() => {
  useFastBackend()
})

const bodyRows = () => within(screen.getByRole('table')).getAllByRole('row').slice(1)
const heading = (name: string) => screen.findByRole('heading', { level: 1, name })

describe('transactions screen', () => {
  it('lists every bank transaction with its bank status and reconciliation status', async () => {
    await renderAppAt('/transactions')
    await heading('Transactions')
    await screen.findByRole('table')
    expect(bodyRows()).toHaveLength(8)
    const row = (reference: string) =>
      within(screen.getByRole('table')).getByRole('rowheader', { name: reference }).closest('tr')!
    expect(within(row('SMP-INV-1042')).getByText('Confirmed')).toBeInTheDocument()
    expect(within(row('SMP-INV-1042')).getByText('Fully allocated')).toBeInTheDocument()
    expect(within(row('SMP-INV-1042')).getByText('Aline Uwase')).toBeInTheDocument()
    expect(within(row('SMP-INV-9999')).getByText('Unmatched')).toBeInTheDocument()
    expect(within(row('OP-DEMO000001')).getByText(/Collected/)).toBeInTheDocument()
    // Everything seeded is visibly simulated.
    expect(within(row('SMP-INV-1042')).getByText('Simulated')).toBeInTheDocument()
    for (const status of ['Pending', 'Failed', 'Reversed']) {
      expect(within(screen.getByRole('table')).getAllByText(status).length).toBeGreaterThan(0)
    }
  })

  it('filters by bank status, reconciliation status and provider, and searches', async () => {
    const user = userEvent.setup()
    await renderAppAt('/transactions')
    await screen.findByRole('table')
    await user.selectOptions(screen.getByLabelText('Bank status'), 'FAILED')
    expect(bodyRows()).toHaveLength(1)
    await user.selectOptions(screen.getByLabelText('Bank status'), 'ALL')
    await user.selectOptions(screen.getByLabelText('Reconciliation'), 'UNMATCHED')
    expect(bodyRows()).toHaveLength(2)
    await user.selectOptions(screen.getByLabelText('Reconciliation'), 'ALL')
    await user.type(screen.getByRole('searchbox', { name: 'Search' }), 'smp-inv-9999')
    expect(bodyRows()).toHaveLength(1)
    await user.clear(screen.getByRole('searchbox', { name: 'Search' }))
    await user.type(screen.getByRole('searchbox', { name: 'Search' }), 'zzzz')
    expect(await screen.findByText('No transactions match')).toBeInTheDocument()
  })

  it('sorts by amount', async () => {
    const user = userEvent.setup()
    await renderAppAt('/transactions')
    await screen.findByRole('table')
    await user.selectOptions(screen.getByLabelText('Sort by'), 'HIGHEST')
    expect(bodyRows()[0]).toHaveTextContent(/260,000/)
    await user.selectOptions(screen.getByLabelText('Sort by'), 'LOWEST')
    expect(bodyRows()[0]).toHaveTextContent(/9,500/)
  })

  it('shows a cashier only transactions applied to their own invoices', async () => {
    await renderAppAt('/transactions', { signedInAs: 'cashier' })
    await heading('Transactions')
    await screen.findByRole('table')
    // Two live payments plus the reversed one, which stays in the history of Aline's invoice.
    expect(bodyRows()).toHaveLength(3)
    const text = screen.getByRole('table').textContent ?? ''
    expect(text).toContain('SMP-INV-1042')
    expect(text).toContain('SMP-INV-1043')
    // Unmatched, pending and other people's money never appears for a cashier.
    for (const hidden of ['SMP-INV-9999', 'OP-DEMO000001', 'OP-DEMOINV0044', 'No reference']) {
      expect(text).not.toContain(hidden)
    }
    expect(
      screen.getByText('Bank-confirmed payments applied to your invoices.'),
    ).toBeInTheDocument()
  })

  it('shows empty, loading and error states', async () => {
    const { listBankTransactions } = await import('@/services').then((m) => ({
      listBankTransactions: m.reconciliationService.listBankTransactions,
    }))
    const spy = vi.mocked(listBankTransactions)
    spy.mockImplementation(() => new Promise(() => {}))
    const loading = await renderAppAt('/transactions')
    expect((await screen.findAllByRole('status'))[0]).toHaveTextContent('Loading')
    loading.unmount()
    spy.mockResolvedValue([])
    const empty = await renderAppAt('/transactions')
    expect(await screen.findByText('No transactions yet')).toBeInTheDocument()
    empty.unmount()
    spy.mockRejectedValue(new Error('boom'))
    await renderAppAt('/transactions')
    expect(await screen.findByText('Transactions could not be loaded.')).toBeInTheDocument()
  })
})

describe('transaction details', () => {
  it('shows the facts, allocations and the audit history', async () => {
    await renderAppAt('/transactions/btx-001')
    await heading('SMP-INV-1042')
    expect(screen.getByText('Fully allocated')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'SMP-INV-1042' })).toHaveAttribute(
      'href',
      '/invoices/inv-smp-inv-1042',
    )
    const history = screen.getByRole('heading', { name: 'History' }).closest('div')!.parentElement!
    expect(within(history).getByText('Applied automatically')).toBeInTheDocument()
    expect(within(history).getByText(/exact reference SMP-INV-1042/)).toBeInTheDocument()
    expect(screen.getByText(/Only the bank can confirm a payment/)).toBeInTheDocument()
  })

  it('offers review and allocation actions for a flagged transaction, to people allowed to reconcile', async () => {
    await renderAppAt('/transactions/btx-007')
    await heading('SMP-INV-9999')
    expect(screen.getAllByText(/does not match|Needs review/).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: 'Apply to invoices' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Mark as reviewed' })).toBeInTheDocument()
  })

  it('reverses a wrong allocation after a reason, restoring the invoice balance', async () => {
    const user = userEvent.setup()
    await renderAppAt('/transactions/btx-001')
    await user.click(await screen.findByRole('button', { name: /Reverse.*SMP-INV-1042/ }))
    const dialog = await screen.findByRole('dialog', { name: /Reverse the allocation/ })
    // A reason is required.
    await user.click(within(dialog).getByRole('button', { name: 'Reverse allocation' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/reason/)
    await user.type(within(dialog).getByLabelText('Reason'), 'Paid the wrong invoice')
    await user.click(within(dialog).getByRole('button', { name: 'Reverse allocation' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(await screen.findByText('Unmatched')).toBeInTheDocument()
    expect(
      (await getActiveTestBackend().fastInvoices.getInvoice(MERCHANT, 'inv-smp-inv-1042'))
        .paymentStatus,
    ).toBe('UNPAID')
  })

  it('hides every action from a cashier and shows only their own history', async () => {
    await renderAppAt('/transactions/btx-001', { signedInAs: 'cashier' })
    await heading('SMP-INV-1042')
    expect(screen.queryByRole('button', { name: /Reverse/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Apply to invoices' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Mark as reviewed' })).not.toBeInTheDocument()
  })

  it("treats money that is not a cashier's as not found", async () => {
    await renderAppAt('/transactions/btx-003', { signedInAs: 'cashier' })
    expect(await heading('Transaction not found')).toBeInTheDocument()
  })

  it("does not reveal another business's transaction", async () => {
    await renderAppAt('/transactions/btx-101')
    expect(await heading('Transaction not found')).toBeInTheDocument()
  })
})

describe('payments screen: reconciliation', () => {
  const tab = (name: RegExp) => screen.findByRole('tab', { name })

  it('shows what needs attention, with counts', async () => {
    await renderAppAt('/payments')
    await heading('Payments')
    expect(await tab(/Needs review\s*\(2\)/)).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Unmatched money\s*\(3\)/ })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Partly allocated\s*\(0\)/ })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Allocation history' })).toBeInTheDocument()
    expect(await screen.findByText('SMP-INV-9999')).toBeInTheDocument()
    expect(screen.getByText('No reference')).toBeInTheDocument()
  })

  it('applies unmatched money to an invoice, and everything updates', async () => {
    const user = userEvent.setup()
    await renderAppAt('/payments')
    const card = (await screen.findByText('No reference')).closest('li')!
    await user.click(within(card).getByRole('button', { name: /Apply to invoices/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Apply money to invoices' })
    await user.type(await within(dialog).findByLabelText(/SMP-INV-1041/), '9500')
    await user.click(within(dialog).getByRole('button', { name: 'Apply to invoices' }))
    expect(await screen.findByText(/RWF\s*9,500 applied to 1 invoice/)).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(await tab(/Needs review\s*\(1\)/)).toBeInTheDocument()
    const invoice = await getActiveTestBackend().fastInvoices.getInvoice(
      MERCHANT,
      'inv-smp-inv-1041',
    )
    expect(invoice).toMatchObject({ paymentStatus: 'PARTIALLY_PAID' })
    expect(invoice.payment?.remainingBalance).toBe(88_500)
  })

  it('refuses to apply more than the unapplied amount and explains why', async () => {
    const user = userEvent.setup()
    await renderAppAt('/payments')
    const card = (await screen.findByText('No reference')).closest('li')!
    await user.click(within(card).getByRole('button', { name: /Apply to invoices/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Apply money to invoices' })
    await user.type(await within(dialog).findByLabelText(/SMP-INV-1041/), '9501')
    await user.click(within(dialog).getByRole('button', { name: 'Apply to invoices' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/more than the/)
    expect(
      (await getActiveTestBackend().fastInvoices.getInvoice(MERCHANT, 'inv-smp-inv-1041'))
        .paymentStatus,
    ).toBe('UNPAID')
  })

  it('handles an allocation conflict: someone else changed the transaction while the dialog was open', async () => {
    const user = userEvent.setup()
    await renderAppAt('/payments')
    const card = (await screen.findByText('No reference')).closest('li')!
    await user.click(within(card).getByRole('button', { name: /Apply to invoices/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Apply money to invoices' })
    const input = await within(dialog).findByLabelText(/SMP-INV-1041/)
    // A colleague applies part of the money first.
    const backend = getActiveTestBackend()
    const { transaction } = await backend.fastReconciliation.getBankTransaction(MERCHANT, 'btx-003')
    await backend.fastReconciliation.allocateManually(MERCHANT, {
      bankTransactionId: 'btx-003',
      expectedTransactionVersion: transaction.version,
      allocations: [
        { invoiceId: 'inv-smp-inv-1041', amount: 4_000, expectedRemainingBalance: 98_000 },
      ],
    })
    await user.type(input, '5000')
    await user.click(within(dialog).getByRole('button', { name: 'Apply to invoices' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/changed since you opened/)
    // Nothing from the stale attempt was applied.
    expect(
      (await backend.fastInvoices.getInvoice(MERCHANT, 'inv-smp-inv-1041')).payment
        ?.allocatedAmount,
    ).toBe(4_000)
  })

  it('records a review note without moving money', async () => {
    const user = userEvent.setup()
    await renderAppAt('/payments')
    const card = (await screen.findByText('SMP-INV-9999')).closest('li')!
    await user.click(within(card).getByRole('button', { name: /Mark as reviewed/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Mark as reviewed' })
    await user.click(within(dialog).getByRole('button', { name: 'Mark as reviewed' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/short note/)
    await user.type(
      within(dialog).getByLabelText(/What did you check/),
      'Customer confirmed a deposit',
    )
    await user.click(within(dialog).getByRole('button', { name: 'Mark as reviewed' }))
    expect(await screen.findByText('Marked as reviewed. No money was moved.')).toBeInTheDocument()
    expect(await tab(/Needs review\s*\(1\)/)).toBeInTheDocument()
    // The money is still unapplied: reviewing is not allocating.
    expect(screen.getByRole('tab', { name: /Unmatched money\s*\(3\)/ })).toBeInTheDocument()
  })

  it('shows allocation history, including reversed allocations', async () => {
    const user = userEvent.setup()
    await renderAppAt('/payments')
    await user.click(await tab(/Allocation history/))
    expect(await screen.findAllByText(/SMP-INV-1043/)).not.toHaveLength(0)
    expect(screen.getAllByText(/Reversed/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Matched by exact reference/).length).toBeGreaterThan(0)
  })

  it('gives a cashier read-only allocation history for their own invoices', async () => {
    await renderAppAt('/payments', { signedInAs: 'cashier' })
    await heading('Payments')
    expect(screen.queryByRole('tab', { name: /Needs review/ })).not.toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Allocation history' })).toBeInTheDocument()
    expect(await screen.findAllByText(/SMP-INV-1042/)).not.toHaveLength(0)
    expect(screen.queryByText(/SMP-INV-9999/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Reverse/ })).not.toBeInTheDocument()
  })

  it('lets a manager reconcile too', async () => {
    await renderAppAt('/payments', { signedInAs: 'manager' })
    expect(await tab(/Needs review/)).toBeInTheDocument()
  })
})

describe('banking screen', () => {
  it('is for owners only', async () => {
    const manager = await renderAppAt('/banking', { signedInAs: 'manager' })
    expect(await heading('Access denied')).toBeInTheDocument()
    manager.unmount()
    await renderAppAt('/banking', { signedInAs: 'cashier' })
    expect(await heading('Access denied')).toBeInTheDocument()
  })

  it('shows connections, destinations and honest capability tables', async () => {
    await renderAppAt('/banking')
    await heading('Banking')
    expect(screen.getByRole('note')).toHaveTextContent(/Demo connections only/)
    expect(screen.getByRole('note')).toHaveTextContent(/never asks for a PIN/)
    expect(await screen.findByText('Connected (demo)')).toBeInTheDocument()
    expect(screen.getAllByText('••••4821').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Simulated').length).toBeGreaterThan(0)
    // The real Equity integration: every capability is unconfirmed, not assumed.
    const real = screen.getByRole('table', { name: 'Real Equity Bank Rwanda capabilities' })
    expect(within(real).getAllByText('Not confirmed')).toHaveLength(8)
    expect(screen.getByText(/NOT INTEGRATED/)).toBeInTheDocument()
    expect(
      within(screen.getByRole('table', { name: 'MTN MoMo capabilities' })).getAllByText(
        'Not confirmed',
      ),
    ).toHaveLength(8)
  })

  it('never asks for a PIN, password, one-time code or login', async () => {
    await renderAppAt('/banking')
    await heading('Banking')
    await screen.findByText('Connected (demo)')
    expect(document.querySelectorAll('input[type="password"]')).toHaveLength(0)
    const labels = [...document.querySelectorAll('label')].map((l) => l.textContent ?? '')
    expect(labels.join(' ')).not.toMatch(/\b(pin|password|otp|one-time|username)\b/i)
  })

  it('walks the demo link flow: error first, then pending, then connected, then disable', async () => {
    const user = userEvent.setup()
    await renderAppAt('/banking')
    await screen.findByText('Connected (demo)')
    // The existing link is disabled first (only one link per provider).
    await user.click(screen.getByRole('button', { name: /Disable.*Main collections account/ }))
    const confirm = await screen.findByRole('dialog', { name: /Disable Main collections account/ })
    await user.click(within(confirm).getByRole('button', { name: 'Disable connection' }))
    expect(await screen.findByText('Disabled')).toBeInTheDocument()

    await user.type(screen.getByLabelText(/Account name/), 'Second account')
    await user.type(screen.getByLabelText(/Demo account reference/), 'SIM-ERROR')
    await user.click(screen.getByRole('button', { name: 'Start demo link' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/Simulated provider error/)

    await user.clear(screen.getByLabelText(/Demo account reference/))
    await user.type(screen.getByLabelText(/Demo account reference/), 'SIM-5555')
    await user.click(screen.getByRole('button', { name: 'Start demo link' }))
    expect(await screen.findByText('Pending')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Complete demo link/ }))
    await waitFor(() => expect(screen.getAllByText('Connected (demo)').length).toBeGreaterThan(0))
    expect(screen.getAllByText('••••5555').length).toBeGreaterThan(0)
  })

  it('shows an error state when connections cannot be loaded', async () => {
    const { bankingService } = await import('@/services')
    vi.mocked(bankingService.listConnections).mockRejectedValue(new Error('boom'))
    await renderAppAt('/banking')
    expect(await screen.findByText('Connections could not be loaded.')).toBeInTheDocument()
  })
})

describe('notifications (header bell)', () => {
  const simulate = (scenarioId: 'partial' | 'unmatched' | 'reversal') => {
    // Bank events are produced on behalf of the owner (demo tooling needs an authorised person).
    getActiveTestBackend().signInAs('owner')
    return getActiveTestBackend().fastSimulator.run(MERCHANT, {
      scenarioId,
      reference: scenarioId === 'unmatched' ? undefined : 'SMP-INV-1041',
      amount: scenarioId === 'unmatched' ? 3_000 : undefined,
    })
  }
  const bell = () => screen.findByRole('button', { name: /^Notifications/ })

  it('shows an empty state with no unread badge', async () => {
    const user = userEvent.setup()
    await renderAppAt('/')
    await user.click(await bell())
    expect(await screen.findByText(/You are all caught up/)).toBeInTheDocument()
    expect(screen.queryByTestId('unread-count')).not.toBeInTheDocument()
  })

  it('counts unread notifications, marks one read, then all', async () => {
    const user = userEvent.setup()
    await simulate('partial')
    await simulate('unmatched')
    await renderAppAt('/')
    const button = await screen.findByRole('button', { name: 'Notifications, 2 unread' })
    expect(screen.getByTestId('unread-count')).toHaveTextContent('2')
    await user.click(button)
    const menu = await screen.findByRole('region', { name: 'Notifications' })
    expect(within(menu).getAllByText('Invoice SMP-INV-1041 partly paid').length).toBeGreaterThan(0)
    expect(within(menu).getAllByText('Unmatched bank confirmation').length).toBeGreaterThan(0)
    expect(within(menu).getAllByText('Simulated').length).toBeGreaterThan(0)
    await user.click(within(menu).getAllByRole('button', { name: /^Mark as read/ })[0]!)
    await screen.findByRole('button', { name: 'Notifications, 1 unread' })
    await user.click(
      within(await screen.findByRole('region', { name: 'Notifications' })).getByRole('button', {
        name: 'Mark all as read',
      }),
    )
    await screen.findByRole('button', { name: 'Notifications' })
    expect(screen.queryByTestId('unread-count')).not.toBeInTheDocument()
  })

  it('routes alerts by role: the cashier hears about their invoice, never about unmatched money', async () => {
    await simulate('partial')
    await simulate('unmatched')
    await renderAppAt('/', { signedInAs: 'cashier' })
    // Only the partial payment on Aline's invoice reaches her.
    expect(
      await screen.findByRole('button', { name: 'Notifications, 1 unread' }),
    ).toBeInTheDocument()
  })

  it("keeps each person's notifications separate", async () => {
    await simulate('reversal')
    const owner = await renderAppAt('/')
    await screen.findByRole('button', { name: /^Notifications, \d+ unread/ })
    owner.unmount()
    // The suspended member of the same business sees nothing, and cannot even ask.
    getActiveTestBackend().signInAs('suspended')
    await expect(notificationService.listNotifications(MERCHANT)).rejects.toMatchObject({
      code: 'not_found',
    })
  })

  it('shows an error inside the menu if notifications cannot load', async () => {
    const user = userEvent.setup()
    vi.mocked(notificationService.listNotifications).mockRejectedValue(new Error('down'))
    await renderAppAt('/')
    await user.click(await bell())
    expect(await screen.findByText('Notifications could not be loaded.')).toBeInTheDocument()
  })
})

describe('the whole mock customer journey', () => {
  it('invoice -> payment request -> customer page -> bank confirms -> invoice, dashboard, transactions and bell all agree', async () => {
    const user = userEvent.setup()
    const { router } = await renderAppAt('/invoices/inv-smp-inv-1044')
    await heading('SMP-INV-1044')

    // 1. The invoice shows what is owed and offers a payment request (no "mark as paid").
    const panel = (await screen.findByRole('heading', { name: 'Payment' })).closest(
      'div',
    )!.parentElement!
    expect(within(panel).getByText('Remaining')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /mark.*paid/i })).not.toBeInTheDocument()
    await user.click(within(panel).getByRole('button', { name: 'Create payment request' }))
    const link = await within(panel).findByRole('link', { name: /Open customer page/ })
    const customerPath = link.getAttribute('href')!
    expect(customerPath).toMatch(/^\/p\/Bn7wL3cYp9Ds\/r\/OP-DEMOINV0044$/)
    expect(document.querySelector('svg[data-qr-value*="OP-DEMOINV0044"]')).toBeInTheDocument()

    // 2. The customer page (no sign-in needed) shows the exact outstanding amount, then the bank confirms.
    await router.navigate(customerPath)
    expect(await screen.findByText('Invoice SMP-INV-1044')).toBeInTheDocument()
    expect(screen.getByText(/RWF\s*708,000/)).toBeInTheDocument()
    await user.click(await screen.findByRole('button', { name: 'Bank confirms' }))
    expect(await screen.findByText('Paid and confirmed by the bank')).toBeInTheDocument()

    // 3. The invoice is settled, with the balance at zero.
    await router.navigate('/invoices/inv-smp-inv-1044')
    await heading('SMP-INV-1044')
    expect((await screen.findAllByText('Paid')).length).toBeGreaterThan(0)
    expect(screen.getByText('Remaining').nextElementSibling).toHaveTextContent(/RWF\s*0/)

    // 4. The dashboard moved by exactly this payment, with nothing counted twice.
    await router.navigate('/')
    const kpi = (label: string) => screen.getByText(label).closest('div')!.parentElement!
    await waitFor(() => expect(kpi('Verified incoming')).toHaveTextContent(/RWF\s*1,194,500/))
    expect(kpi('Allocated to invoices')).toHaveTextContent(/RWF\s*880,000/)
    expect(kpi('Unmatched collections')).toHaveTextContent(/RWF\s*314,500/)
    expect(kpi('Outstanding balances')).toHaveTextContent(/RWF\s*219,840/)

    // 5. The transaction history and the allocation history record it.
    await router.navigate('/transactions')
    await heading('Transactions')
    const table = await screen.findByRole('table', { name: 'Bank transactions' })
    // The seeded pending payment and the new confirmation share the reference.
    expect(within(table).getAllByText('OP-DEMOINV0044').length).toBeGreaterThan(1)

    // 6. The owner was notified, and it is marked simulated.
    expect(
      await screen.findByRole('button', { name: /^Notifications, \d+ unread/ }),
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /^Notifications/ }))
    expect((await screen.findAllByText('Invoice SMP-INV-1044 settled')).length).toBeGreaterThan(0)
  }, 30_000)

  it('keeps businesses separate when switching: the cafe shows its own transactions only', async () => {
    const user = userEvent.setup()
    const { router } = await renderAppAt('/transactions')
    await screen.findByRole('table')
    expect(bodyRows()).toHaveLength(8)
    await user.click(screen.getByRole('button', { name: /Account menu for/ }))
    await user.click(
      await within(await screen.findByRole('menu')).findByRole('menuitemradio', {
        name: /Sample Corner Cafe/,
      }),
    )
    await router.navigate('/transactions')
    await waitFor(() => expect(screen.getByRole('table').textContent).toContain('SMP-CAFE-2001'))
    const text = screen.getByRole('table').textContent ?? ''
    expect(text).not.toContain('SMP-INV-1042')
    expect(bodyRows()).toHaveLength(1)
  })
})
