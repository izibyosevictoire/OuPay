import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { invoiceService } from '@/services'
import { SAMPLE_BRANCH_IDS } from '@/services/mock/sampleOrganization'
import { useFastBackend } from '@/test/merchantTestDouble'
import { renderAppAt } from '@/test/renderApp'

const heading = (name: string) => screen.findByRole('heading', { level: 1, name })
const table = () => within(screen.getByRole('table'))

async function openInvoices(options: Parameters<typeof renderAppAt>[1] = {}) {
  const result = await renderAppAt('/invoices', options)
  await screen.findByRole('table')
  return result
}

const numbersInTable = () =>
  table()
    .getAllByRole('rowheader')
    .map((cell) => cell.textContent)

beforeEach(() => {
  useFastBackend()
})

describe('invoice list', () => {
  it('shows number, customer, branch, cashier, dates, total and both statuses', async () => {
    await openInvoices()
    expect(await heading('Invoices')).toBeInTheDocument()
    const row = table().getByRole('row', { name: /SMP-INV-1044/ })
    expect(within(row).getByText('Kivu Fresh Foods Ltd')).toBeInTheDocument()
    expect(within(row).getByText('Remera Main')).toBeInTheDocument()
    expect(within(row).getByText('Grace Mukamana')).toBeInTheDocument()
    expect(within(row).getByText('08 Oct 2026')).toBeInTheDocument()
    expect(within(row).getByText('20 Oct 2026')).toBeInTheDocument()
    expect(within(row).getByText(/708,000/)).toBeInTheDocument()
    expect(within(row).getByText('Issued')).toBeInTheDocument()
    expect(within(row).getByText('Unpaid')).toBeInTheDocument()
  })

  it('labels every lifecycle and payment state with text, and flags overdue invoices', async () => {
    await openInvoices()
    const status = (number: RegExp) => table().getByRole('row', { name: number })
    expect(within(status(/SMP-INV-1040/)).getByText('Draft')).toBeInTheDocument()
    expect(within(status(/SMP-INV-1042/)).getByText('Paid')).toBeInTheDocument()
    expect(within(status(/SMP-INV-1043/)).getByText('Partially paid')).toBeInTheDocument()
    expect(within(status(/SMP-INV-1045/)).getByText('Cancelled')).toBeInTheDocument()
    expect(within(status(/SMP-INV-1046/)).getByText('Voided')).toBeInTheDocument()
    expect(within(status(/SMP-INV-1041/)).getByText('Overdue')).toBeInTheDocument()
    // Not overdue: paid, and a future due date.
    expect(within(status(/SMP-INV-1042/)).queryByText('Overdue')).not.toBeInTheDocument()
    expect(within(status(/SMP-INV-1044/)).queryByText('Overdue')).not.toBeInTheDocument()
  })

  it('offers no way to mark an invoice as paid', async () => {
    await openInvoices()
    expect(
      screen.queryByRole('button', { name: /mark as paid|mark paid|confirm payment/i }),
    ).not.toBeInTheDocument()
    expect(screen.queryByText(/mark as paid/i)).not.toBeInTheDocument()
  })

  it('searches by invoice number or customer', async () => {
    const user = userEvent.setup()
    await openInvoices()
    const search = screen.getByRole('searchbox', { name: 'Search invoices' })
    await user.type(search, '1043')
    expect(numbersInTable()).toEqual(['SMP-INV-1043'])
    await user.clear(search)
    await user.type(search, 'salon')
    expect(numbersInTable()).toEqual(['SMP-INV-1041'])
  })

  it('filters by lifecycle status, payment status and branch', async () => {
    const user = userEvent.setup()
    await openInvoices()
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Filter by invoice status' }),
      'DRAFT',
    )
    expect(numbersInTable()).toEqual(['SMP-INV-1040'])
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Filter by invoice status' }),
      'ALL',
    )

    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Filter by payment status' }),
      'PAID',
    )
    expect(numbersInTable()).toEqual(['SMP-INV-1042'])
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Filter by payment status' }),
      'ALL',
    )

    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Filter by branch' }),
      SAMPLE_BRANCH_IDS.cityCentre,
    )
    expect(numbersInTable().sort()).toEqual(['SMP-INV-1040', 'SMP-INV-1043'])
  })

  it('filters by created date range', async () => {
    const user = userEvent.setup()
    await openInvoices()
    await user.type(screen.getByLabelText('Created from'), '2026-10-08')
    await user.type(screen.getByLabelText('Created to'), '2026-10-10')
    expect(numbersInTable().sort()).toEqual(['SMP-INV-1043', 'SMP-INV-1044'])
  })

  it('sorts by date and by amount', async () => {
    const user = userEvent.setup()
    await openInvoices()
    expect(numbersInTable()[0]).toBe('SMP-INV-1040') // newest first by default
    await user.selectOptions(screen.getByRole('combobox', { name: 'Sort invoices' }), 'OLDEST')
    expect(numbersInTable()[0]).toBe('SMP-INV-1046')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Sort invoices' }), 'HIGHEST')
    expect(numbersInTable().slice(0, 2)).toEqual(['SMP-INV-1044', 'SMP-INV-1040']) // 708,000 then 295,000
    await user.selectOptions(screen.getByRole('combobox', { name: 'Sort invoices' }), 'LOWEST')
    expect(numbersInTable()[0]).toBe('SMP-INV-1045') // 3,000
  })

  it('totals only issued invoices, and says billed is not money received', async () => {
    const user = userEvent.setup()
    await openInvoices()
    const summary = screen.getByText(/invoices · Billed/)
    // 708,000 + 221,840 + 72,000 + 98,000 issued; still owed after confirmed money is
    // subtracted: 708,000 + 121,840 + 98,000.
    expect(summary).toHaveTextContent(/Billed RWF\s*1,099,840/)
    expect(summary).toHaveTextContent(/Not yet paid RWF\s*927,840/)
    expect(summary).toHaveTextContent(/not money received/)
    await user.type(screen.getByRole('searchbox', { name: 'Search invoices' }), 'imena')
    expect(screen.getByText(/invoices · Billed/)).toHaveTextContent(/Billed RWF\s*72,000/)
  })

  it('explains an empty result', async () => {
    const user = userEvent.setup()
    await openInvoices()
    await user.type(screen.getByRole('searchbox', { name: 'Search invoices' }), 'zzzz')
    expect(await screen.findByText('No invoices match')).toBeInTheDocument()
  })

  it('shows loading, empty and error states', async () => {
    vi.mocked(invoiceService.listInvoices).mockImplementation(() => new Promise(() => {}))
    const loading = await renderAppAt('/invoices')
    expect((await screen.findAllByRole('status'))[0]).toHaveTextContent('Loading')
    loading.unmount()

    vi.mocked(invoiceService.listInvoices).mockResolvedValue({
      items: [],
      totalCount: 0,
      nextCursor: null,
    })
    const empty = await renderAppAt('/invoices')
    expect(await screen.findByText('No invoices yet')).toBeInTheDocument()
    empty.unmount()

    vi.mocked(invoiceService.listInvoices).mockRejectedValue(new Error('down'))
    await renderAppAt('/invoices')
    expect(await screen.findByRole('alert', {}, { timeout: 4000 })).toHaveTextContent(
      'Invoices could not be loaded.',
    )
  })

  it('renders both a card list for small screens and a table for large ones', async () => {
    await openInvoices()
    const cards = document.querySelector('ul.divide-y')!
    expect(cards.className).toContain('lg:hidden')
    expect(screen.getByRole('table').className).toContain('hidden')
    expect(screen.getByRole('table').className).toContain('lg:table')
    expect(within(cards as HTMLElement).getAllByRole('listitem')).toHaveLength(7)
  })

  it('labels the sample data', async () => {
    await openInvoices()
    expect(screen.getByRole('note')).toHaveTextContent('Sample data')
  })
})

describe('who sees which invoices', () => {
  it('shows a cashier only invoices assigned to them, with no way to see others', async () => {
    await openInvoices({ signedInAs: 'cashier' })
    expect(screen.getByText('Invoices assigned to you.')).toBeInTheDocument()
    expect(numbersInTable().sort()).toEqual([
      'SMP-INV-1040',
      'SMP-INV-1041',
      'SMP-INV-1042',
      'SMP-INV-1043',
      'SMP-INV-1045',
      'SMP-INV-1046',
    ])
    expect(table().queryByText('SMP-INV-1044')).not.toBeInTheDocument()
  })

  it('shows managers every invoice of the business', async () => {
    await openInvoices({ signedInAs: 'manager' })
    expect(numbersInTable()).toHaveLength(7)
  })

  it('offers "New invoice" to everyone who can create one, including cashiers', async () => {
    for (const user of ['owner', 'manager', 'cashier'] as const) {
      const { unmount } = await openInvoices({ signedInAs: user })
      expect(screen.getByRole('link', { name: 'New invoice' })).toHaveAttribute(
        'href',
        '/invoices/new',
      )
      unmount()
    }
  })

  it('never shows another business’s invoices, and switching business replaces the list', async () => {
    const user = userEvent.setup()
    const { router } = await openInvoices()
    expect(table().queryByText('SMP-CAFE-2001')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Account menu for/ }))
    const menu = await screen.findByRole('menu')
    await user.click(await within(menu).findByRole('menuitemradio', { name: /Sample Corner Cafe/ }))
    await heading('Dashboard')
    await router.navigate('/invoices')
    await heading('Invoices')
    await waitFor(() => expect(table().getByText('SMP-CAFE-2001')).toBeInTheDocument())
    // The first business's invoices must not linger from cache.
    expect(table().queryByText('SMP-INV-1044')).not.toBeInTheDocument()
    expect(numbersInTable()).toEqual(['SMP-CAFE-2001'])
  })

  it('refuses suspended members entirely', async () => {
    await renderAppAt('/invoices', { signedInAs: 'suspended' })
    expect(await heading('No business access right now')).toBeInTheDocument()
  })
})
