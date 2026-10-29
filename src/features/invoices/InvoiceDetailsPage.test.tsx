import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { invoiceService } from '@/services'
import { InvoiceServiceError } from '@/services/invoiceService'
import { SAMPLE_BRANCH_IDS } from '@/services/mock/sampleOrganization'
import { SAMPLE_MERCHANT_ID, SAMPLE_SECOND_MERCHANT_ID } from '@/services/mock/sampleMerchants'
import { getActiveTestBackend, useFastBackend } from '@/test/merchantTestDouble'
import { renderAppAt } from '@/test/renderApp'
import { pinSeedClock, restoreClock } from '@/test/seedClock'

const heading = (name: string) => screen.findByRole('heading', { level: 1, name })

/** Looks an invoice up by its number, straight from the backend (not through the UI). */
function invoiceByNumber(number: string, merchantId = SAMPLE_MERCHANT_ID) {
  return getActiveTestBackend()
    .store.loadInvoices()
    .find((i) => i.invoiceNumber === number && i.merchantId === merchantId)!
}

async function openInvoice(number: string, options: Parameters<typeof renderAppAt>[1] = {}) {
  const invoice = invoiceByNumber(number)
  const result = await renderAppAt(`/invoices/${invoice.id}`, options)
  await heading(number)
  return { ...result, invoice }
}

const actionNames = () =>
  ['Edit draft', 'Issue invoice', 'Cancel draft', 'Void invoice'].filter(
    (name) =>
      screen.queryByRole('link', { name: new RegExp(name) }) ||
      screen.queryByRole('button', { name: new RegExp(`^${name}`) }),
  )

beforeEach(() => {
  pinSeedClock()
  useFastBackend()
})

afterEach(() => {
  restoreClock()
})

describe('invoice details', () => {
  it('shows the customer, snapshots, people, dates, items, totals, status and notes', async () => {
    await openInvoice('SMP-INV-1044')
    expect(screen.getAllByText('Kivu Fresh Foods Ltd').length).toBeGreaterThan(0)
    // Merchant and branch as they were written on the invoice.
    const page = within(screen.getByRole('main'))
    expect(page.getByText('Sample Shop')).toBeInTheDocument()
    expect(page.getByText('Sample Business Ltd')).toBeInTheDocument()
    expect(page.getByText('100000001')).toBeInTheDocument()
    expect(page.getByText('Remera Main (RM01)')).toBeInTheDocument()
    expect(page.getByText('Sample Owner')).toBeInTheDocument() // created by
    expect(page.getByText('Grace Mukamana')).toBeInTheDocument() // assigned
    expect(screen.getAllByText('08 October 2026')).toHaveLength(2) // created and issued the same day
    expect(screen.getByText('20 October 2026')).toBeInTheDocument()
    expect(screen.getByText('Payment by bank transfer preferred.')).toBeInTheDocument()

    const items = within(screen.getByRole('table', { name: 'Invoice line items' }))
    expect(items.getByRole('row', { name: /Catering supplies/ })).toHaveTextContent(
      /20.*28,000.*VAT 18%.*100,800.*660,800/,
    )
    expect(items.getByRole('row', { name: /Delivery/ })).toHaveTextContent(
      /40,000.*VAT 18%.*7,200.*47,200/,
    )

    const totals = screen.getByText('Subtotal').closest('dl')!
    expect(totals).toHaveTextContent(/Subtotal\s*RWF\s*600,000/)
    expect(totals).toHaveTextContent(/VAT \/ tax added\s*RWF\s*108,000/)
    expect(totals).toHaveTextContent(/Total\s*RWF\s*708,000/)
  })

  it('keeps invoice status and payment verification apart, and explains payment is bank-confirmed only', async () => {
    await openInvoice('SMP-INV-1044')
    expect(screen.getByText('Invoice status').nextElementSibling).toHaveTextContent('Issued')
    expect(screen.getByText('Payment verification').nextElementSibling).toHaveTextContent('Unpaid')
    expect(screen.getByText(/only when a bank-confirmed payment is matched/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /paid/i })).not.toBeInTheDocument()
  })

  it('shows inclusive pricing as tax already inside the total', async () => {
    await openInvoice('SMP-INV-1042')
    expect(screen.getByText('Of which VAT / tax')).toBeInTheDocument()
    expect(screen.getByText('Prices include tax', { exact: false })).toBeInTheDocument()
    expect(screen.getByText('Payment verification').nextElementSibling).toHaveTextContent('Paid')
  })

  it('flags an overdue invoice', async () => {
    await openInvoice('SMP-INV-1041')
    expect(screen.getByText('Invoice status').nextElementSibling).toHaveTextContent('Overdue')
  })

  it('offers a printable view and copies the reference', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const { invoice } = await openInvoice('SMP-INV-1044')
    expect(screen.getByRole('link', { name: /Printable view/ })).toHaveAttribute(
      'href',
      `/invoices/${invoice.id}/print`,
    )
    await user.click(screen.getByRole('button', { name: /Copy reference/ }))
    expect(writeText).toHaveBeenCalledWith('SMP-INV-1044')
    expect(await screen.findByText('Invoice reference SMP-INV-1044 copied.')).toBeInTheDocument()
  })

  it('says so when the browser blocks copying', async () => {
    const user = userEvent.setup()
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('blocked')) },
      configurable: true,
    })
    await openInvoice('SMP-INV-1044')
    await user.click(screen.getByRole('button', { name: /Copy reference/ }))
    expect(await screen.findByText(/blocked copying/)).toBeInTheDocument()
  })

  it('shows loading and error states', async () => {
    vi.mocked(invoiceService.getInvoice).mockImplementation(() => new Promise(() => {}))
    const loading = await renderAppAt('/invoices/anything')
    expect((await screen.findAllByRole('status'))[0]).toHaveTextContent('Loading')
    loading.unmount()
    vi.mocked(invoiceService.getInvoice).mockRejectedValue(
      new InvoiceServiceError('service_unavailable', 'down'),
    )
    await renderAppAt('/invoices/anything')
    expect(await screen.findByRole('alert')).toHaveTextContent('This invoice could not be loaded.')
  })
})

describe('available actions follow status, role and payment', () => {
  it('lets an owner edit, issue or cancel a draft, but not void it', async () => {
    await openInvoice('SMP-INV-1040')
    expect(actionNames()).toEqual(['Edit draft', 'Issue invoice', 'Cancel draft'])
  })

  it('lets an owner void an unpaid issued invoice, and nothing else', async () => {
    await openInvoice('SMP-INV-1044')
    expect(actionNames()).toEqual(['Void invoice'])
  })

  it('offers no void once any payment activity exists', async () => {
    for (const number of ['SMP-INV-1042', 'SMP-INV-1043']) {
      const { unmount } = await openInvoice(number)
      expect(actionNames()).toEqual([])
      unmount()
    }
  })

  it('offers no lifecycle actions on cancelled or voided invoices', async () => {
    for (const number of ['SMP-INV-1045', 'SMP-INV-1046']) {
      const { unmount } = await openInvoice(number)
      expect(actionNames()).toEqual([])
      unmount()
    }
  })

  it('shows managers draft actions but never void', async () => {
    const draft = await openInvoice('SMP-INV-1040', { signedInAs: 'manager' })
    expect(actionNames()).toEqual(['Edit draft', 'Issue invoice', 'Cancel draft'])
    draft.unmount()
    await openInvoice('SMP-INV-1044', { signedInAs: 'manager' })
    expect(actionNames()).toEqual([])
  })

  it('lets a cashier act on their own drafts only, and never void', async () => {
    const draft = await openInvoice('SMP-INV-1040', { signedInAs: 'cashier' })
    expect(actionNames()).toEqual(['Edit draft', 'Issue invoice', 'Cancel draft'])
    draft.unmount()
    await openInvoice('SMP-INV-1041', { signedInAs: 'cashier' })
    expect(actionNames()).toEqual([])
  })
})

describe('issuing, cancelling and voiding from the details page', () => {
  it('issues a draft after confirmation; it stays unpaid and can no longer be edited', async () => {
    const user = userEvent.setup()
    await openInvoice('SMP-INV-1040')
    await user.click(screen.getByRole('button', { name: /Issue invoice/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Issue SMP-INV-1040?' })
    expect(within(dialog).getByText(/can no longer be edited/)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Issue invoice' }))

    expect(await screen.findByText('Invoice SMP-INV-1040 issued.')).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByText('Invoice status').nextElementSibling).toHaveTextContent('Issued'),
    )
    expect(screen.getByText('Payment verification').nextElementSibling).toHaveTextContent('Unpaid')
    expect(screen.queryByRole('link', { name: /Edit draft/ })).not.toBeInTheDocument()
  })

  it('cancels a draft after confirmation and keeps it on file', async () => {
    const user = userEvent.setup()
    await openInvoice('SMP-INV-1040')
    await user.click(screen.getByRole('button', { name: /Cancel draft/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Cancel draft SMP-INV-1040?' })
    expect(within(dialog).getByText(/kept on file as cancelled/)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Cancel draft' }))
    expect(await screen.findByText('Draft SMP-INV-1040 was cancelled.')).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByText('Invoice status').nextElementSibling).toHaveTextContent('Cancelled'),
    )
    expect(actionNames()).toEqual([])
    expect(screen.getAllByText('Nyabugogo Logistics').length).toBeGreaterThan(0)
  })

  it('voids with a mandatory reason, and shows the reason afterwards', async () => {
    const user = userEvent.setup()
    await openInvoice('SMP-INV-1044')
    await user.click(screen.getByRole('button', { name: /Void invoice/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Void SMP-INV-1044?' })
    expect(within(dialog).getByText(/cannot be undone/)).toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: 'Void invoice' }))
    expect(
      await within(dialog).findByText('Give a reason for voiding this invoice.'),
    ).toBeInTheDocument()
    expect(invoiceService.voidInvoice).not.toHaveBeenCalled()

    await user.type(within(dialog).getByLabelText(/Reason/), 'Duplicate of INV-1043')
    await user.click(within(dialog).getByRole('button', { name: 'Void invoice' }))
    expect(await screen.findByText('Invoice SMP-INV-1044 was voided.')).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByText('Invoice status').nextElementSibling).toHaveTextContent('Voided'),
    )
    expect(screen.getByText('Duplicate of INV-1043')).toBeInTheDocument()
    // Amounts and payment status are untouched.
    expect(screen.getByText('Payment verification').nextElementSibling).toHaveTextContent('Unpaid')
    expect(screen.getByText('Subtotal').closest('dl')).toHaveTextContent(
      /RWF\s*708,000|Total\s*RWF\s*708,000/,
    )
  })

  it('shows the reason when an action is refused and keeps the dialog open', async () => {
    const user = userEvent.setup()
    vi.mocked(invoiceService.issueInvoice).mockRejectedValueOnce(
      new InvoiceServiceError('validation', 'The due date cannot be in the past.'),
    )
    await openInvoice('SMP-INV-1040')
    await user.click(screen.getByRole('button', { name: /Issue invoice/ }))
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Issue invoice' }),
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The due date cannot be in the past.',
    )
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('refuses to act on a stale version', async () => {
    const user = userEvent.setup()
    const { invoice } = await openInvoice('SMP-INV-1040')
    // Someone else edits the draft after this page loaded it.
    const { fastInvoices } = getActiveTestBackend()
    const input = {
      branchId: invoice.branchId,
      assignedToUserId: invoice.assignedToUserId,
      customer: { name: 'Changed elsewhere' },
      items: invoice.items.map(({ description, quantity, unitPrice, discount, taxRate }) => ({
        description,
        quantity,
        unitPrice,
        discount,
        taxRate,
      })),
      taxMode: invoice.taxMode,
      dueAt: invoice.dueAt,
    }
    await fastInvoices.updateDraft(SAMPLE_MERCHANT_ID, invoice.id, input, invoice.version)
    await user.click(screen.getByRole('button', { name: /Issue invoice/ }))
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Issue invoice' }),
    )
    expect(await screen.findByRole('alert')).toHaveTextContent('changed by someone else')
  })
})

describe('editing a draft', () => {
  it('opens the draft in the form, saves changes, and returns to the details', async () => {
    const user = userEvent.setup()
    await openInvoice('SMP-INV-1040')
    await user.click(screen.getByRole('link', { name: /Edit draft/ }))
    await heading('Edit SMP-INV-1040')
    const name = await screen.findByLabelText(/Customer name/)
    expect(name).toHaveValue('Nyabugogo Logistics')
    await user.clear(name)
    await user.type(name, 'Nyabugogo Logistics Ltd')
    await user.click(screen.getByRole('button', { name: 'Save draft' }))

    expect(await heading('SMP-INV-1040')).toBeInTheDocument()
    expect(await screen.findByText('Draft SMP-INV-1040 saved.')).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getAllByText('Nyabugogo Logistics Ltd').length).toBeGreaterThan(0),
    )
    expect(invoiceByNumber('SMP-INV-1040').version).toBe(2)
    expect(invoiceService.updateDraft).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.anything(),
      1,
    )
  })

  it('refuses to edit an issued invoice', async () => {
    const invoice = invoiceByNumber('SMP-INV-1044')
    await renderAppAt(`/invoices/${invoice.id}/edit`)
    expect(await screen.findByText('This invoice can no longer be edited')).toBeInTheDocument()
    expect(screen.queryByLabelText(/Customer name/)).not.toBeInTheDocument()
  })

  it('requires choosing an active branch again when the draft’s branch was deactivated', async () => {
    const user = userEvent.setup()
    const { branches } = (() => {
      const { fastBranches } = getActiveTestBackend()
      return { branches: fastBranches }
    })()
    getActiveTestBackend().signInAs('owner')
    await branches.changeBranchStatus(SAMPLE_MERCHANT_ID, SAMPLE_BRANCH_IDS.cityCentre, 'INACTIVE')
    const invoice = invoiceByNumber('SMP-INV-1040') // drafted at City Centre
    await renderAppAt(`/invoices/${invoice.id}/edit`)
    const branch = await screen.findByRole('combobox', { name: /^Branch/ })
    expect(branch).toHaveValue('')
    expect(within(branch).queryByRole('option', { name: /City Centre/ })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save draft' }))
    expect(await screen.findByText('Choose an active branch.')).toBeInTheDocument()
  })
})

describe('history and isolation', () => {
  it('keeps issued invoices readable, with their original branch, after the branch becomes inactive', async () => {
    const { fastBranches } = getActiveTestBackend()
    getActiveTestBackend().signInAs('owner')
    await fastBranches.changeBranchStatus(SAMPLE_MERCHANT_ID, SAMPLE_BRANCH_IDS.remera, 'INACTIVE')
    await openInvoice('SMP-INV-1044')
    expect(screen.getByText('Remera Main (RM01)')).toBeInTheDocument()
    expect(screen.getByText('Invoice status').nextElementSibling).toHaveTextContent('Issued')
  })

  it('keeps the original cashier on an invoice after their access is revoked', async () => {
    const { fastStaff } = getActiveTestBackend()
    getActiveTestBackend().signInAs('owner')
    await fastStaff.revokeMembership(SAMPLE_MERCHANT_ID, 'mem-004')
    await openInvoice('SMP-INV-1043')
    // Shown as both creator and assigned cashier, from the saved invoice, not from live staff data.
    expect(within(screen.getByRole('main')).getAllByText('Aline Uwase')).toHaveLength(2)
  })

  it('does not reveal another business’s invoice', async () => {
    const cafeInvoice = invoiceByNumber('SMP-CAFE-2001', SAMPLE_SECOND_MERCHANT_ID)
    await renderAppAt(`/invoices/${cafeInvoice.id}`) // owner of the FIRST business is selected
    expect(await heading('Invoice not found')).toBeInTheDocument()
    expect(screen.queryByText('Sample Catering Client')).not.toBeInTheDocument()
  })

  it('does not reveal another cashier’s invoice, and not-found is the same as for unknown ids', async () => {
    const others = invoiceByNumber('SMP-INV-1044')
    const { unmount } = await renderAppAt(`/invoices/${others.id}`, { signedInAs: 'cashier' })
    expect(await heading('Invoice not found')).toBeInTheDocument()
    unmount()
    await renderAppAt('/invoices/inv-does-not-exist', { signedInAs: 'cashier' })
    expect(await heading('Invoice not found')).toBeInTheDocument()
  })
})
