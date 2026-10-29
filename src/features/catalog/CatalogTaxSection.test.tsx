import { cleanup, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useFastBackend } from '@/test/merchantTestDouble'
import { renderAppAt } from '@/test/renderApp'

type User = ReturnType<typeof userEvent.setup>

const table = () => within(screen.getByRole('table'))

async function openDetails(
  user: User,
  name: string,
  signedInAs: Parameters<typeof renderAppAt>[1] = {},
) {
  await renderAppAt('/catalog', signedInAs)
  await screen.findByRole('table')
  await user.click(table().getByRole('button', { name }))
  return screen.findByRole('dialog', { name })
}

beforeEach(() => {
  useFastBackend()
})

describe('catalog: tax treatment of an item (R7b)', () => {
  it('shows an explicit treatment, and says plainly when there is none and what that means', async () => {
    const user = userEvent.setup()
    let dialog = await openDetails(user, 'Rice')
    expect(await within(dialog).findByText('Exempt', { selector: 'p' })).toBeInTheDocument()
    cleanup()
    dialog = await openDetails(user, 'Cement')
    expect(
      await within(dialog).findByText(
        /No tax treatment is set\. This item cannot be billed at a POS/,
      ),
    ).toBeInTheDocument()
  })

  it('sets a treatment (a rate only for the standard rate) and never defaults one', async () => {
    const user = userEvent.setup()
    const dialog = await openDetails(user, 'Cement')
    await within(dialog).findByText(/No tax treatment is set/)
    // Nothing chosen: nothing is assumed.
    await user.click(within(dialog).getByRole('button', { name: 'Save tax treatment' }))
    expect(
      await within(dialog).findByText('Choose a tax treatment. Nothing is assumed.'),
    ).toBeInTheDocument()
    await user.selectOptions(
      within(dialog).getByRole('combobox', { name: /Tax treatment/ }),
      'Standard rate',
    )
    await user.type(within(dialog).getByLabelText(/^Rate/), '18.555')
    await user.click(within(dialog).getByRole('button', { name: 'Save tax treatment' }))
    expect(await within(dialog).findByText(/at most two decimals/)).toBeInTheDocument()
    const rate = within(dialog).getByLabelText(/^Rate/)
    await user.clear(rate)
    await user.type(rate, '18')
    await user.click(within(dialog).getByRole('button', { name: 'Save tax treatment' }))
    expect(await within(dialog).findByText('Standard rate 18.00%')).toBeInTheDocument()
  })

  it('shows a configured treatment to people who cannot manage the catalog, without the form', async () => {
    const user = userEvent.setup()
    const dialog = await openDetails(user, 'Rice', { signedInAs: 'cashier' })
    expect(await within(dialog).findByText('Exempt', { selector: 'p' })).toBeInTheDocument()
    expect(
      within(dialog).queryByRole('button', { name: 'Save tax treatment' }),
    ).not.toBeInTheDocument()
  })
})
