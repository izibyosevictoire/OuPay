import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SAMPLE_MERCHANT_ID } from '@/services/mock/sampleMerchants'
import { findAccessibilityViolations } from '@/test/axe'
import { getActiveTestBackend, useFastBackend } from '@/test/merchantTestDouble'
import { renderAppAt } from '@/test/renderApp'

beforeEach(() => {
  useFastBackend()
})

describe('accessibility: inventory pages', () => {
  it('the stock list, and the empty result of a search', async () => {
    const user = userEvent.setup()
    const { container } = await renderAppAt('/inventory')
    await screen.findByRole('table')
    expect(await findAccessibilityViolations(container)).toEqual([])
    await user.type(screen.getByRole('searchbox', { name: 'Search stock' }), 'zzzz')
    await screen.findByText('No stock matches')
    expect(await findAccessibilityViolations(container)).toEqual([])
  })

  it('the movement history', async () => {
    const user = userEvent.setup()
    const { container } = await renderAppAt('/inventory')
    await screen.findByRole('table')
    await user.click(screen.getByRole('tab', { name: /Movements/ }))
    await screen.findByRole('table', { name: 'Stock movements' })
    expect(await findAccessibilityViolations(container)).toEqual([])
  })

  it('the cashier’s read-only view', async () => {
    const { container } = await renderAppAt('/inventory', { signedInAs: 'cashier' })
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
    const { container } = await renderAppAt('/inventory')
    await screen.findByText('Inventory is for businesses in business mode')
    expect(await findAccessibilityViolations(container)).toEqual([])
  })

  it('the tabs expose their selected state and panel', async () => {
    const user = userEvent.setup()
    await renderAppAt('/inventory')
    await screen.findByRole('table')
    const stock = screen.getByRole('tab', { name: /Stock/ })
    const movements = screen.getByRole('tab', { name: /Movements/ })
    expect(stock).toHaveAttribute('aria-selected', 'true')
    expect(movements).toHaveAttribute('aria-selected', 'false')
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', stock.id)
    await user.click(movements)
    expect(movements).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', movements.id)
  })
})

describe('accessibility: inventory dialogs', () => {
  it('the receive form, empty, with validation errors, and entering packages', async () => {
    const user = userEvent.setup()
    await renderAppAt('/inventory')
    await screen.findByRole('table')
    await user.click(screen.getByRole('button', { name: 'Receive stock' }))
    const dialog = await screen.findByRole('dialog', { name: 'Receive stock' })
    await within(dialog).findByRole('option', { name: 'Rice (RICE)' })
    expect(await findAccessibilityViolations(dialog)).toEqual([])
    await user.click(within(dialog).getByRole('button', { name: 'Receive stock' }))
    await within(dialog).findByText('Choose a branch.')
    expect(await findAccessibilityViolations(dialog)).toEqual([])
    await user.selectOptions(within(dialog).getByLabelText(/^Item/), 'Rice (RICE)')
    await user.selectOptions(
      within(dialog).getByLabelText(/Enter quantity as/),
      'A number of packages',
    )
    await within(dialog).findByLabelText(/Number of packages/)
    expect(await findAccessibilityViolations(dialog)).toEqual([])
  })

  it('the adjust form with its direction and reason', async () => {
    const user = userEvent.setup()
    await renderAppAt('/inventory')
    await screen.findByRole('table')
    await user.click(screen.getByRole('button', { name: 'Adjust stock' }))
    const dialog = await screen.findByRole('dialog', { name: 'Adjust stock' })
    await within(dialog).findByRole('option', { name: 'Rice (RICE)' })
    await user.click(within(dialog).getByRole('button', { name: 'Record adjustment' }))
    await within(dialog).findByText('Give a reason for the adjustment.')
    expect(await findAccessibilityViolations(dialog)).toEqual([])
  })

  it('the opening stock form', async () => {
    const user = userEvent.setup()
    await renderAppAt('/inventory')
    await screen.findByRole('table')
    await user.click(screen.getByRole('button', { name: 'Record opening stock' }))
    const dialog = await screen.findByRole('dialog', { name: 'Record opening stock' })
    await within(dialog).findByRole('option', { name: 'Rice (RICE)' })
    expect(await findAccessibilityViolations(dialog)).toEqual([])
  })

  it('moves focus into a dialog and returns it to the button that opened it when closed with Escape', async () => {
    const user = userEvent.setup()
    await renderAppAt('/inventory')
    await screen.findByRole('table')
    await user.click(screen.getByRole('button', { name: 'Receive stock' }))
    const dialog = await screen.findByRole('dialog', { name: 'Receive stock' })
    expect(dialog.contains(document.activeElement)).toBe(true)
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() => expect(screen.getByRole('button', { name: 'Receive stock' })).toHaveFocus())
  })
})
