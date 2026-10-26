import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SAMPLE_MERCHANT_ID } from '@/services/mock/sampleMerchants'
import { findAccessibilityViolations } from '@/test/axe'
import { getActiveTestBackend, useFastBackend } from '@/test/merchantTestDouble'
import { renderAppAt } from '@/test/renderApp'

beforeEach(() => {
  useFastBackend()
})

describe('accessibility: catalog list', () => {
  it('loaded list, and the empty result of a search', async () => {
    const user = userEvent.setup()
    const { container } = await renderAppAt('/catalog')
    await screen.findByRole('table')
    expect(await findAccessibilityViolations(container)).toEqual([])
    await user.type(screen.getByRole('searchbox', { name: 'Search catalog' }), 'zzzz')
    await screen.findByText('No items match')
    expect(await findAccessibilityViolations(container)).toEqual([])
  })

  it('the cashier’s read-only view', async () => {
    const { container } = await renderAppAt('/catalog', { signedInAs: 'cashier' })
    await screen.findByRole('table')
    expect(await findAccessibilityViolations(container)).toEqual([])
  })

  it('the explanation shown to a simplified business', async () => {
    const backend = getActiveTestBackend()
    backend.signInAs('owner')
    await backend.fastMerchants.updateMerchantSettings(SAMPLE_MERCHANT_ID, {
      operatingMode: 'SIMPLIFIED',
      expectedVersion: 0,
    })
    const { container } = await renderAppAt('/catalog')
    await screen.findByText('The catalog is for businesses in business mode')
    expect(await findAccessibilityViolations(container)).toEqual([])
  })
})

describe('accessibility: catalog dialogs', () => {
  it('the add form, empty, with validation errors, and as a service', async () => {
    const user = userEvent.setup()
    await renderAppAt('/catalog')
    await screen.findByRole('table')
    await user.click(screen.getByRole('button', { name: 'Add item' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add a catalog item' })
    expect(await findAccessibilityViolations(dialog)).toEqual([])
    await user.click(within(dialog).getByRole('button', { name: 'Add item' }))
    await within(dialog).findByText('Name is required.')
    expect(await findAccessibilityViolations(dialog)).toEqual([])
    await user.selectOptions(within(dialog).getByLabelText(/^Type/), 'SERVICE')
    expect(await findAccessibilityViolations(dialog)).toEqual([])
  })

  it('the edit form, with the reason field shown after a price change', async () => {
    const user = userEvent.setup()
    await renderAppAt('/catalog')
    await screen.findByRole('table')
    await user.click(
      within(screen.getByRole('table')).getByRole('button', { name: 'Actions for Rice' }),
    )
    await user.click(await screen.findByRole('menuitem', { name: /Edit/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit catalog item' })
    await waitFor(() => expect(within(dialog).getByLabelText(/Measured in/)).toHaveValue('MASS'))
    await user.clear(within(dialog).getByLabelText(/Price/))
    await user.type(within(dialog).getByLabelText(/Price/), '1500')
    await within(dialog).findByLabelText(/Reason for the change/)
    expect(await findAccessibilityViolations(dialog)).toEqual([])
  })

  it('the status confirmation', async () => {
    const user = userEvent.setup()
    await renderAppAt('/catalog')
    await screen.findByRole('table')
    await user.click(
      within(screen.getByRole('table')).getByRole('button', { name: 'Actions for Haircut' }),
    )
    await user.click(await screen.findByRole('menuitem', { name: 'Deactivate' }))
    const dialog = await screen.findByRole('dialog', { name: 'Deactivate Haircut?' })
    expect(await findAccessibilityViolations(dialog)).toEqual([])
  })

  it('the details with packages, the package form and the price history', async () => {
    const user = userEvent.setup()
    await renderAppAt('/catalog')
    await screen.findByRole('table')
    await user.click(within(screen.getByRole('table')).getByRole('button', { name: 'Rice' }))
    const dialog = await screen.findByRole('dialog', { name: 'Rice' })
    await within(dialog).findByRole('region', { name: 'Packages' })
    expect(await findAccessibilityViolations(dialog)).toEqual([])
    await user.click(within(dialog).getByRole('button', { name: 'Add package' }))
    await within(dialog).findByRole('form', { name: 'Add package' })
    await user.click(within(dialog).getByRole('button', { name: 'Show price history' }))
    await within(dialog).findByRole('list', { name: 'Price versions' })
    expect(await findAccessibilityViolations(dialog)).toEqual([])
  })

  it('moves focus into a dialog and returns it to the page when closed with Escape', async () => {
    const user = userEvent.setup()
    await renderAppAt('/catalog')
    await screen.findByRole('table')
    await user.click(screen.getByRole('button', { name: 'Add item' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add a catalog item' })
    expect(dialog.contains(document.activeElement)).toBe(true)
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add item' })).toHaveFocus())
  })
})
