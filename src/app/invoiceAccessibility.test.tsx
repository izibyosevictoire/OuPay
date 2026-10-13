import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SAMPLE_BRANCH_IDS } from '@/services/mock/sampleOrganization'
import { SAMPLE_MERCHANT_ID } from '@/services/mock/sampleMerchants'
import { findAccessibilityViolations } from '@/test/axe'
import { getActiveTestBackend, useFastBackend } from '@/test/merchantTestDouble'
import { renderAppAt } from '@/test/renderApp'

const idOf = (number: string) =>
  getActiveTestBackend()
    .store.loadInvoices()
    .find((i) => i.invoiceNumber === number && i.merchantId === SAMPLE_MERCHANT_ID)!.id

beforeEach(() => {
  useFastBackend()
})

describe('accessibility: invoice list', () => {
  it('loaded list, with filters', async () => {
    const { container } = await renderAppAt('/invoices')
    await screen.findByRole('table')
    expect(await findAccessibilityViolations(container)).toEqual([])
  })

  it('cashier view, empty result and error-free states', async () => {
    const user = userEvent.setup()
    const { container } = await renderAppAt('/invoices', { signedInAs: 'cashier' })
    await screen.findByRole('table')
    expect(await findAccessibilityViolations(container)).toEqual([])
    await user.type(screen.getByRole('searchbox', { name: 'Search invoices' }), 'zzzz')
    await screen.findByText('No invoices match')
    expect(await findAccessibilityViolations(container)).toEqual([])
  })
})

describe('accessibility: new invoice form', () => {
  it('empty form, then with validation errors, extra items and a custom tax rate', async () => {
    const user = userEvent.setup()
    const { container } = await renderAppAt('/invoices/new')
    await screen.findByLabelText(/Customer name/)
    expect(await findAccessibilityViolations(container)).toEqual([])

    await user.click(screen.getByRole('button', { name: 'Add item' }))
    await user.selectOptions(
      within(screen.getByRole('group', { name: 'Item 2' })).getByLabelText(/^Tax/),
      'CUSTOM',
    )
    await user.click(screen.getByRole('button', { name: 'Save draft' }))
    await screen.findByText('Customer name is required.')
    expect(await findAccessibilityViolations(container)).toEqual([])
  })

  it('the issue confirmation dialog', async () => {
    const user = userEvent.setup()
    await renderAppAt('/invoices/new')
    await user.type(await screen.findByLabelText(/Customer name/), 'Jane')
    await user.selectOptions(screen.getByLabelText(/^Branch/), SAMPLE_BRANCH_IDS.remera)
    await user.selectOptions(
      screen.getByLabelText(/Assigned cashier/),
      (await screen.findAllByRole('option', { name: 'Aline Uwase' }))[0]!.getAttribute('value')!,
    )
    const item = within(screen.getByRole('group', { name: 'Item 1' }))
    await user.type(item.getByLabelText(/Description/), 'Tea')
    await user.type(item.getByLabelText(/Unit price/), '1000')
    await user.click(screen.getByRole('button', { name: 'Issue invoice' }))
    const dialog = await screen.findByRole('dialog', { name: 'Issue this invoice?' })
    expect(await findAccessibilityViolations(dialog)).toEqual([])
  })

  it('the no-eligible-branch notice and the cashier form', async () => {
    const cashier = await renderAppAt('/invoices/new', { signedInAs: 'cashier' })
    await screen.findByLabelText(/Customer name/)
    expect(await findAccessibilityViolations(cashier.container)).toEqual([])
    cashier.unmount()

    const { store } = getActiveTestBackend()
    store.saveBranches(store.loadBranches().map((b) => ({ ...b, status: 'INACTIVE' as const })))
    const empty = await renderAppAt('/invoices/new')
    await screen.findByText('No branch available for invoicing')
    expect(await findAccessibilityViolations(empty.container)).toEqual([])
  })
})

describe('accessibility: invoice details', () => {
  it.each([
    ['a draft', 'SMP-INV-1040'],
    ['an issued, unpaid invoice (with void action)', 'SMP-INV-1044'],
    ['a partially paid invoice', 'SMP-INV-1043'],
    ['an inclusive-price invoice', 'SMP-INV-1042'],
    ['a cancelled invoice', 'SMP-INV-1045'],
    ['a voided invoice', 'SMP-INV-1046'],
  ])('%s', async (_label, number) => {
    const { container } = await renderAppAt(`/invoices/${idOf(number)}`)
    await screen.findByRole('heading', { level: 1, name: number })
    expect(await findAccessibilityViolations(container)).toEqual([])
  })

  it('the void, cancel and issue dialogs', async () => {
    const user = userEvent.setup()
    const issued = await renderAppAt(`/invoices/${idOf('SMP-INV-1044')}`)
    await screen.findByRole('heading', { level: 1, name: 'SMP-INV-1044' })
    await user.click(screen.getByRole('button', { name: /Void invoice/ }))
    const voidDialog = await screen.findByRole('dialog', { name: 'Void SMP-INV-1044?' })
    expect(await findAccessibilityViolations(voidDialog)).toEqual([])
    await user.click(within(voidDialog).getByRole('button', { name: 'Void invoice' }))
    await within(voidDialog).findByText('Give a reason for voiding this invoice.')
    expect(await findAccessibilityViolations(voidDialog)).toEqual([])
    issued.unmount()

    await renderAppAt(`/invoices/${idOf('SMP-INV-1040')}`)
    await screen.findByRole('heading', { level: 1, name: 'SMP-INV-1040' })
    await user.click(screen.getByRole('button', { name: /Cancel draft/ }))
    expect(await findAccessibilityViolations(await screen.findByRole('dialog'))).toEqual([])
  })

  it('the edit page, the not-found page and the cashier view', async () => {
    const edit = await renderAppAt(`/invoices/${idOf('SMP-INV-1040')}/edit`)
    await screen.findByLabelText(/Customer name/)
    expect(await findAccessibilityViolations(edit.container)).toEqual([])
    edit.unmount()

    const missing = await renderAppAt('/invoices/inv-nope')
    await screen.findByRole('heading', { level: 1, name: 'Invoice not found' })
    expect(await findAccessibilityViolations(missing.container)).toEqual([])
    missing.unmount()

    const cashier = await renderAppAt(`/invoices/${idOf('SMP-INV-1043')}`, {
      signedInAs: 'cashier',
    })
    await screen.findByRole('heading', { level: 1, name: 'SMP-INV-1043' })
    expect(await findAccessibilityViolations(cashier.container)).toEqual([])
  })
})

describe('accessibility: printable invoice and dashboard', () => {
  it.each(['SMP-INV-1044', 'SMP-INV-1040', 'SMP-INV-1046'])('print view of %s', async (number) => {
    const { container } = await renderAppAt(`/invoices/${idOf(number)}/print`)
    await screen.findByRole('article', { name: `Invoice ${number}` })
    expect(await findAccessibilityViolations(container)).toEqual([])
  })

  it('dashboard with invoice figures, for an owner and a cashier', async () => {
    const owner = await renderAppAt('/')
    await screen.findByText('Issued invoices')
    await screen.findAllByText(/SMP-INV-1043/)
    expect(await findAccessibilityViolations(owner.container)).toEqual([])
    owner.unmount()

    const cashier = await renderAppAt('/', { signedInAs: 'cashier' })
    await screen.findByText('My issued invoices')
    await screen.findAllByText(/SMP-INV-1043/)
    expect(await findAccessibilityViolations(cashier.container)).toEqual([])
  })
})
