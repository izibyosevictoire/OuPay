import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { invoiceService } from '@/services'
import { InvoiceServiceError } from '@/services/invoiceService'
import { DEMO_USER_IDS } from '@/services/mock/sampleAccounts'
import { SAMPLE_BRANCH_IDS } from '@/services/mock/sampleOrganization'
import type { Invoice } from '@/types/invoice'
import { getActiveTestBackend, useFastBackend } from '@/test/merchantTestDouble'
import { renderAppAt } from '@/test/renderApp'

type User = ReturnType<typeof userEvent.setup>

const heading = (name: string) => screen.findByRole('heading', { level: 1, name })
const field = (label: RegExp) => screen.getByLabelText(label)
const item = (index: number) => within(screen.getByRole('group', { name: `Item ${index}` }))

async function openForm(options: Parameters<typeof renderAppAt>[1] = {}) {
  const result = await renderAppAt('/invoices/new', options)
  await heading('New invoice')
  await screen.findByLabelText(/Customer name/)
  return result
}

async function fillItem(
  user: User,
  index: number,
  values: { description?: string; quantity?: string; unitPrice?: string; discount?: string } = {},
) {
  const line = item(index)
  await user.type(line.getByLabelText(/Description/), values.description ?? 'Tea')
  if (values.quantity) {
    await user.clear(line.getByLabelText(/Quantity/))
    await user.type(line.getByLabelText(/Quantity/), values.quantity)
  }
  if (values.unitPrice) await user.type(line.getByLabelText(/Unit price/), values.unitPrice)
  if (values.discount) await user.type(line.getByLabelText(/Discount/), values.discount)
}

async function fillValidForm(
  user: User,
  branchId = SAMPLE_BRANCH_IDS.remera,
  assignee = DEMO_USER_IDS.cashier,
) {
  await user.type(field(/Customer name/), 'Mama Jane Shop')
  await user.selectOptions(field(/^Branch/), branchId)
  await user.selectOptions(field(/Assigned cashier/), assignee)
  await fillItem(user, 1, { quantity: '2', unitPrice: '2500' })
}

const summary = () => within(screen.getByRole('complementary', { name: 'Invoice summary' }))
const save = (user: User) => user.click(screen.getByRole('button', { name: 'Save draft' }))
const issue = (user: User) => user.click(screen.getByRole('button', { name: 'Issue invoice' }))

beforeEach(() => {
  useFastBackend()
})

describe('validation differs for drafts and issuing', () => {
  it('asks for the essentials when saving a draft, without calling the service', async () => {
    const user = userEvent.setup()
    await openForm()
    await save(user)
    expect(await screen.findByText('Customer name is required.')).toBeInTheDocument()
    expect(screen.getByText('Choose an active branch.')).toBeInTheDocument()
    expect(screen.getByText('Choose who this invoice is assigned to.')).toBeInTheDocument()
    expect(screen.getByText('Describe the item.')).toBeInTheDocument()
    expect(field(/Customer name/)).toHaveAttribute('aria-invalid', 'true')
    expect(invoiceService.createDraft).not.toHaveBeenCalled()
  })

  it('lets a draft keep an unfinished price but refuses to issue it', async () => {
    const user = userEvent.setup()
    await openForm()
    await user.type(field(/Customer name/), 'Mama Jane Shop')
    await user.selectOptions(field(/^Branch/), SAMPLE_BRANCH_IDS.remera)
    await user.selectOptions(field(/Assigned cashier/), DEMO_USER_IDS.cashier)
    await fillItem(user, 1) // description only; no price yet

    await issue(user)
    expect(await screen.findByText('Enter a price above 0 to issue.')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(invoiceService.createDraft).not.toHaveBeenCalled()

    await save(user)
    expect(await heading('INV-1047')).toBeInTheDocument()
    expect(invoiceService.createDraft).toHaveBeenCalledTimes(1)
  })

  it('refuses a past due date when issuing', async () => {
    const user = userEvent.setup()
    await openForm()
    await fillValidForm(user)
    const due = field(/Due date/)
    await user.clear(due)
    await user.type(due, '2020-01-01')
    await issue(user)
    expect(await screen.findByText('The due date cannot be in the past.')).toBeInTheDocument()
  })

  it('validates optional customer fields and line item numbers', async () => {
    const user = userEvent.setup()
    await openForm()
    await user.type(field(/^Email/), 'nope')
    await user.type(field(/Customer TIN/), '12')
    await fillItem(user, 1, { quantity: '0', unitPrice: '10.5', discount: 'abc' })
    await save(user)
    expect(await screen.findByText(/valid email address/)).toBeInTheDocument()
    expect(screen.getByText(/exactly 9 digits/)).toBeInTheDocument()
    expect(screen.getByText(/Enter a quantity above 0/)).toBeInTheDocument()
    expect(screen.getAllByText(/Enter a whole amount in RWF/).length).toBeGreaterThan(0)
  })
})

describe('line items and live totals', () => {
  it('adds up exclusive VAT as you type, and nothing is taxed by default', async () => {
    const user = userEvent.setup()
    await openForm()
    expect(item(1).getByLabelText(/^Tax/)).toHaveValue('NOT_APPLICABLE')
    await fillItem(user, 1, { quantity: '3', unitPrice: '1000' })
    expect(summary().getByText('Total').nextSibling).toHaveTextContent(/RWF\s*3,000/)

    await user.selectOptions(item(1).getByLabelText(/^Tax/), 'STANDARD')
    expect(summary().getByText('VAT / tax added').nextSibling).toHaveTextContent(/RWF\s*540/)
    expect(summary().getByText('Total').nextSibling).toHaveTextContent(/RWF\s*3,540/)
    expect(item(1).getByText(/RWF\s*3,540/)).toBeInTheDocument() // line total
  })

  it('switches to inclusive pricing: the total stays, and the tax inside is shown', async () => {
    const user = userEvent.setup()
    await openForm()
    await fillItem(user, 1, { quantity: '3', unitPrice: '1000' })
    await user.selectOptions(item(1).getByLabelText(/^Tax/), 'STANDARD')
    await user.selectOptions(field(/^Prices/), 'INCLUSIVE')
    expect(summary().getByText('Total').nextSibling).toHaveTextContent(/RWF\s*3,000/)
    expect(summary().getByText('Of which VAT / tax').nextSibling).toHaveTextContent(/RWF\s*458/)
    expect(screen.getByText(/already contains its tax/)).toBeInTheDocument()
  })

  it('applies discounts, exempt and custom-rate lines', async () => {
    const user = userEvent.setup()
    await openForm()
    await fillItem(user, 1, { quantity: '2', unitPrice: '5000', discount: '1000' })
    await user.click(screen.getByRole('button', { name: 'Add item' }))
    await fillItem(user, 2, { description: 'Service', unitPrice: '2000' })
    await user.selectOptions(item(2).getByLabelText(/^Tax/), 'CUSTOM')
    await user.type(item(2).getByLabelText(/Custom rate/), '5')
    // Line 1: 10,000 - 1,000 = 9,000. Line 2: 2,000 + 5% = 2,100. Total 11,100.
    expect(summary().getByText('Discounts').nextSibling).toHaveTextContent(/RWF\s*1,000/)
    expect(summary().getByText('Total').nextSibling).toHaveTextContent(/RWF\s*11,100/)
    await user.selectOptions(item(2).getByLabelText(/^Tax/), 'EXEMPT')
    expect(item(2).queryByLabelText(/Custom rate/)).not.toBeInTheDocument()
    expect(summary().getByText('Total').nextSibling).toHaveTextContent(/RWF\s*11,000/)
  })

  it('validates a custom rate', async () => {
    const user = userEvent.setup()
    await openForm()
    await user.selectOptions(item(1).getByLabelText(/^Tax/), 'CUSTOM')
    await user.type(item(1).getByLabelText(/Custom rate/), '150')
    await save(user)
    expect(await screen.findByText(/Enter a rate from 0 to 100/)).toBeInTheDocument()
  })

  it('adds and removes items, always keeping at least one', async () => {
    const user = userEvent.setup()
    await openForm()
    expect(item(1).getByRole('button', { name: /Remove/ })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Add item' }))
    expect(screen.getByRole('group', { name: 'Item 2' })).toBeInTheDocument()
    await user.click(item(2).getByRole('button', { name: /Remove/ }))
    expect(screen.queryByRole('group', { name: 'Item 2' })).not.toBeInTheDocument()
  })
})

describe('branch and cashier choices', () => {
  it('offers only active branches, and only people actively assigned to the chosen branch', async () => {
    const user = userEvent.setup()
    await openForm()
    const branch = field(/^Branch/)
    expect(
      within(branch)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Select a branch', 'City Centre (KCC)', 'Remera Main (RM01)'])
    expect(field(/Assigned cashier/)).toHaveDisplayValue('Choose a branch first')

    await user.selectOptions(branch, SAMPLE_BRANCH_IDS.remera)
    expect(
      within(field(/Assigned cashier/))
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Select a cashier', 'Aline Uwase', 'Grace Mukamana'])
    await user.selectOptions(branch, SAMPLE_BRANCH_IDS.cityCentre)
    // Grace works at Remera only, so City Centre leaves just Aline.
    expect(
      within(field(/Assigned cashier/))
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Select a cashier', 'Aline Uwase'])
  })

  it('clears a cashier who is not valid for a newly chosen branch', async () => {
    const user = userEvent.setup()
    await openForm()
    await user.selectOptions(field(/^Branch/), SAMPLE_BRANCH_IDS.remera)
    await user.selectOptions(field(/Assigned cashier/), DEMO_USER_IDS.manager)
    await user.selectOptions(field(/^Branch/), SAMPLE_BRANCH_IDS.cityCentre)
    await waitFor(() => expect(field(/Assigned cashier/)).toHaveValue(''))
  })

  it('fixes a cashier as the assignee and limits branches to their own', async () => {
    const user = userEvent.setup()
    await openForm({ signedInAs: 'cashier' })
    await user.selectOptions(field(/^Branch/), SAMPLE_BRANCH_IDS.remera)
    // The assignee is read-only text for a cashier: always themselves.
    expect(field(/Assigned cashier/)).toHaveValue('Aline Uwase')
    expect(field(/Assigned cashier/)).toHaveAttribute('readonly')
    expect(screen.getByText('Invoices you create are assigned to you.')).toBeInTheDocument()
    expect(
      within(field(/^Branch/))
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Select a branch', 'City Centre (KCC)', 'Remera Main (RM01)'])
  })

  it('tells someone with nothing eligible why they cannot invoice yet', async () => {
    const { store } = getActiveTestBackend()
    store.saveBranches(store.loadBranches().map((b) => ({ ...b, status: 'INACTIVE' as const })))
    await renderAppAt('/invoices/new')
    expect(await screen.findByText('No branch available for invoicing')).toBeInTheDocument()
    expect(
      within(screen.getByRole('main')).getByRole('link', { name: 'Branches' }),
    ).toHaveAttribute('href', '/branches')
    expect(screen.queryByRole('button', { name: 'Issue invoice' })).not.toBeInTheDocument()
  })
})

describe('saving and issuing', () => {
  it('saves a draft and opens it, sending whole-franc integers', async () => {
    const user = userEvent.setup()
    await openForm()
    await fillValidForm(user)
    await save(user)
    expect(await heading('INV-1047')).toBeInTheDocument()
    expect(await screen.findByText('Draft INV-1047 saved.')).toBeInTheDocument()
    expect(screen.getByText('Draft', { selector: 'span' })).toBeInTheDocument()
    expect(invoiceService.createDraft).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        branchId: SAMPLE_BRANCH_IDS.remera,
        assignedToUserId: DEMO_USER_IDS.cashier,
        taxMode: 'EXCLUSIVE',
        items: [expect.objectContaining({ quantity: 2, unitPrice: 2500, discount: 0 })],
      }),
    )
  })

  it('confirms before issuing, then issues: unpaid, and stating that issuing is not payment', async () => {
    const user = userEvent.setup()
    await openForm()
    await fillValidForm(user)
    await issue(user)
    const dialog = await screen.findByRole('dialog', { name: 'Issue this invoice?' })
    expect(within(dialog).getByText(/can no longer be edited/)).toBeInTheDocument()
    expect(within(dialog).getByText(/show as unpaid/)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Issue invoice' }))

    expect(await heading('INV-1047')).toBeInTheDocument()
    expect(await screen.findByText('Invoice INV-1047 issued.')).toBeInTheDocument()
    expect(screen.getByText('Issued', { selector: 'span' })).toBeInTheDocument()
    expect(screen.getAllByText('Unpaid', { selector: 'span' }).length).toBeGreaterThan(0)
  })

  it('does not issue when the confirmation is dismissed', async () => {
    const user = userEvent.setup()
    await openForm()
    await fillValidForm(user)
    await issue(user)
    const dialog = await screen.findByRole('dialog', { name: 'Issue this invoice?' })
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(invoiceService.createDraft).not.toHaveBeenCalled()
    expect(invoiceService.issueInvoice).not.toHaveBeenCalled()
  })

  it('prevents duplicate submissions while saving', async () => {
    const user = userEvent.setup()
    let finish: (invoice: Invoice) => void = () => {}
    vi.mocked(invoiceService.createDraft).mockImplementation(
      () => new Promise<Invoice>((resolve) => (finish = resolve)),
    )
    await openForm()
    await fillValidForm(user)
    const button = screen.getByRole('button', { name: 'Save draft' })
    await user.click(button)
    await user.click(button)
    await user.dblClick(screen.getByRole('button', { name: 'Issue invoice' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled())
    expect(screen.getByRole('button', { name: 'Issue invoice' })).toBeDisabled()
    expect(invoiceService.createDraft).toHaveBeenCalledTimes(1)
    finish({} as Invoice)
  })

  it('keeps the saved draft when issuing fails, says so, and a retry does not duplicate it', async () => {
    const user = userEvent.setup()
    vi.mocked(invoiceService.issueInvoice).mockRejectedValueOnce(
      new InvoiceServiceError(
        'branch_inactive',
        'Remera Main is inactive and cannot be used for new invoices.',
      ),
    )
    await openForm()
    await fillValidForm(user)
    await issue(user)
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Issue invoice' }),
    )

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('INV-1047 was saved as a draft but could not be issued')
    expect(alert).toHaveTextContent('Remera Main is inactive')

    await issue(user)
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Issue invoice' }),
    )
    expect(await heading('INV-1047')).toBeInTheDocument()
    expect(invoiceService.createDraft).toHaveBeenCalledTimes(1)
    expect(invoiceService.updateDraft).toHaveBeenCalledTimes(1)
  })

  it('shows service errors from saving and lets the user try again', async () => {
    const user = userEvent.setup()
    vi.mocked(invoiceService.createDraft).mockRejectedValueOnce(
      new InvoiceServiceError('service_unavailable', 'Invoicing is down.'),
    )
    await openForm()
    await fillValidForm(user)
    await save(user)
    expect(await screen.findByRole('alert')).toHaveTextContent('Invoicing is down.')
    await save(user)
    expect(await heading('INV-1047')).toBeInTheDocument()
  })

  it('cancels back to the list without saving anything', async () => {
    const user = userEvent.setup()
    const { router } = await openForm()
    await user.type(field(/Customer name/), 'Draft only in the browser')
    await user.click(screen.getByRole('link', { name: 'Cancel' }))
    await heading('Invoices')
    expect(router.state.location.pathname).toBe('/invoices')
    expect(invoiceService.createDraft).not.toHaveBeenCalled()
  })

  it('works for a cashier, creating an invoice assigned to themselves', async () => {
    const user = userEvent.setup()
    await openForm({ signedInAs: 'cashier' })
    await user.type(field(/Customer name/), 'Walk-in')
    await user.selectOptions(field(/^Branch/), SAMPLE_BRANCH_IDS.cityCentre)
    await fillItem(user, 1, { unitPrice: '4000' })
    await save(user)
    expect(await heading('INV-1047')).toBeInTheDocument()
    expect(invoiceService.createDraft).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ assignedToUserId: DEMO_USER_IDS.cashier }),
    )
  })
})
