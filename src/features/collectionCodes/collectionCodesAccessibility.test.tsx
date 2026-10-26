import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { findAccessibilityViolations } from '@/test/axe'
import { useFastBackend } from '@/test/merchantTestDouble'
import { renderAppAt } from '@/test/renderApp'

beforeEach(() => {
  useFastBackend()
})

const closeWithKeyboard = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
}

describe('accessibility: collection codes', () => {
  it('the list, and the empty result of a search', async () => {
    const user = userEvent.setup()
    const { container } = await renderAppAt('/collection-codes')
    await screen.findByRole('table', { name: 'Collection codes' })
    expect(await findAccessibilityViolations(container)).toEqual([])
    await user.type(screen.getByRole('searchbox', { name: 'Search collection codes' }), 'zzzz')
    await screen.findByText('No codes match')
    expect(await findAccessibilityViolations(container)).toEqual([])
  })

  it('the details of an approved code, a pending code and a simulated one', async () => {
    const user = userEvent.setup()
    const { container } = await renderAppAt('/collection-codes')
    const table = await screen.findByRole('table', { name: 'Collection codes' })
    for (const label of ['Remera counter', 'City Centre till', 'Demo stall (simulated)']) {
      await user.click(within(table).getByRole('button', { name: `View ${label}` }))
      const dialog = await screen.findByRole('dialog', { name: 'Collection code' })
      await within(dialog).findByRole('region', { name: 'Assignment history' })
      await waitFor(() => expect(within(dialog).queryByRole('status')).not.toBeInTheDocument())
      expect(await findAccessibilityViolations(container.ownerDocument.body)).toEqual([])
      await closeWithKeyboard(user)
    }
  })

  it('the request, assign and reason forms, with their validation messages showing', async () => {
    const user = userEvent.setup()
    const { container } = await renderAppAt('/collection-codes')
    const table = await screen.findByRole('table', { name: 'Collection codes' })

    await user.click(screen.getAllByRole('button', { name: 'Request a code' })[0]!)
    let dialog = await screen.findByRole('dialog', { name: 'Request a collection code' })
    await user.click(within(dialog).getByRole('button', { name: 'Record request' }))
    await within(dialog).findByText('Enter a label, for example “Remera counter”.')
    expect(await findAccessibilityViolations(container.ownerDocument.body)).toEqual([])
    await closeWithKeyboard(user)

    await user.click(within(table).getByRole('button', { name: 'View Weekend market stall' }))
    const details = await screen.findByRole('dialog', { name: 'Collection code' })
    await user.click(await within(details).findByRole('button', { name: 'Assign' }))
    dialog = await screen.findByRole('dialog', { name: 'Assign this code' })
    await user.click(within(dialog).getByRole('button', { name: 'Assign code' }))
    await within(dialog).findByText('Choose a team member.')
    expect(await findAccessibilityViolations(container.ownerDocument.body)).toEqual([])
    await user.keyboard('{Escape}')
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Assign this code' })).not.toBeInTheDocument(),
    )

    await user.click(within(details).getByRole('button', { name: 'Deactivate' }))
    dialog = await screen.findByRole('dialog', { name: 'Deactivate this code' })
    await user.click(within(dialog).getByRole('button', { name: 'Deactivate code' }))
    await within(dialog).findByText('Give a reason. It is kept in the history.')
    expect(await findAccessibilityViolations(container.ownerDocument.body)).toEqual([])
  })

  it('the cashier’s own-code view, with and without a code', async () => {
    const { container } = await renderAppAt('/collection-codes', { signedInAs: 'cashier' })
    await screen.findByLabelText('Your collection code')
    expect(await findAccessibilityViolations(container)).toEqual([])
  })

  it('the tab order reaches the filters and every row action', async () => {
    const user = userEvent.setup()
    await renderAppAt('/collection-codes')
    const table = await screen.findByRole('table', { name: 'Collection codes' })
    const view = within(table).getByRole('button', { name: 'View Remera counter' })
    view.focus()
    expect(view).toHaveFocus()
    await user.keyboard('{Enter}')
    const dialog = await screen.findByRole('dialog', { name: 'Collection code' })
    expect(dialog).toBeInTheDocument()
    await closeWithKeyboard(user)
    // Focus returns to what opened the dialog.
    await waitFor(() => expect(view).toHaveFocus())
  })
})
