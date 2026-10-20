import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { merchantService } from '@/services'
import { MerchantServiceError } from '@/services/merchantService'
import { SAMPLE_MERCHANT_ID, SAMPLE_SECOND_MERCHANT_ID } from '@/services/mock/sampleMerchants'
import { findAccessibilityViolations } from '@/test/axe'
import { useFastBackend } from '@/test/merchantTestDouble'
import { renderAppAt } from '@/test/renderApp'

const businessRadio = () => screen.findByRole('radio', { name: /^Business/ })
const simplifiedRadio = () => screen.findByRole('radio', { name: /^Simplified/ })
const saveButton = () => screen.getByRole('button', { name: /Save changes|Saving/ })

describe('business settings', () => {
  beforeEach(() => {
    useFastBackend()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('replaces the settings placeholder and shows the current operating mode', async () => {
    await renderAppAt('/settings')
    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument()
    expect(await businessRadio()).toBeChecked()
    expect(await simplifiedRadio()).not.toBeChecked()
    expect(screen.queryByText(/coming soon/i)).not.toBeInTheDocument()
    expect(merchantService.getMerchantSettings).toHaveBeenCalledWith(SAMPLE_MERCHANT_ID)
  })

  it('explains both modes in plain language', async () => {
    await renderAppAt('/settings')
    await businessRadio()
    expect(screen.getByText(/For shops and businesses that keep full records/)).toBeInTheDocument()
    expect(screen.getByText(/For sellers who mainly want to collect payments/)).toBeInTheDocument()
  })

  it('lets the owner switch the mode and keeps the saved choice', async () => {
    const user = userEvent.setup()
    await renderAppAt('/settings')
    await businessRadio()
    expect(saveButton()).toBeDisabled()

    await user.click(await simplifiedRadio())
    expect(saveButton()).toBeEnabled()
    await user.click(saveButton())

    expect(await screen.findByText('Operating mode is now Simplified.')).toBeInTheDocument()
    expect(merchantService.updateMerchantSettings).toHaveBeenCalledWith(SAMPLE_MERCHANT_ID, {
      operatingMode: 'SIMPLIFIED',
      expectedVersion: 0,
    })
    expect(await simplifiedRadio()).toBeChecked()
    expect(await screen.findByText(/Last changed/)).toBeInTheDocument()
    expect(saveButton()).toBeDisabled()
    // The business itself, its record and the rest of the app are untouched.
    expect((await merchantService.getMerchantById(SAMPLE_MERCHANT_ID)).businessType).toBe(
      'registered_company',
    )
  })

  it('does not send anything when the choice has not changed', async () => {
    const user = userEvent.setup()
    await renderAppAt('/settings')
    await user.click(await simplifiedRadio())
    await user.click(await businessRadio())
    expect(saveButton()).toBeDisabled()
    expect(merchantService.updateMerchantSettings).not.toHaveBeenCalled()
  })

  it.each(['manager', 'cashier'] as const)(
    'shows a %s the mode but no way to change it',
    async (role) => {
      await renderAppAt('/settings', { signedInAs: role })
      expect(await businessRadio()).toBeChecked()
      expect(await businessRadio()).toBeDisabled()
      expect(await simplifiedRadio()).toBeDisabled()
      expect(screen.getByText(/Only the business owner can change/)).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /Save changes/ })).not.toBeInTheDocument()
    },
  )

  it('tells the owner when the settings changed elsewhere and shows the latest value', async () => {
    const user = userEvent.setup()
    vi.mocked(merchantService.updateMerchantSettings).mockRejectedValueOnce(
      new MerchantServiceError(
        'version_conflict',
        'The settings were changed by someone else. Reload them and try again.',
      ),
    )
    await renderAppAt('/settings')
    await user.click(await simplifiedRadio())
    await user.click(saveButton())

    expect(await screen.findByRole('alert')).toHaveTextContent('changed by someone else')
    expect(await businessRadio()).toBeChecked()
  })

  it('shows a retryable error when the settings cannot be loaded', async () => {
    vi.mocked(merchantService.getMerchantSettings).mockRejectedValue(
      new MerchantServiceError('service_unavailable', 'Down.'),
    )
    await renderAppAt('/settings')
    expect(
      await screen.findByText('Your business settings could not be loaded.', {}, { timeout: 5000 }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Try again|Retry/i })).toBeInTheDocument()
  })

  it('is reachable from the existing navigation without disturbing other pages', async () => {
    const user = userEvent.setup()
    await renderAppAt('/')
    await screen.findByRole('heading', { level: 1, name: 'Dashboard' })
    const navigation = screen.getAllByRole('navigation', { name: 'Primary' })[0]!
    await user.click(within(navigation).getByRole('link', { name: 'Settings' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument()
    await user.click(within(navigation).getByRole('link', { name: 'Invoices' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Invoices' })).toBeInTheDocument()
  })

  it("keeps each business's own mode when the user switches between businesses", async () => {
    const user = userEvent.setup()
    await renderAppAt('/settings')
    await user.click(await simplifiedRadio())
    await user.click(saveButton())
    expect(await screen.findByText('Operating mode is now Simplified.')).toBeInTheDocument()

    const switchTo = async (business: RegExp) => {
      await user.click(screen.getByRole('button', { name: /Account menu for/ }))
      const menu = await screen.findByRole('menu')
      await user.click(await within(menu).findByRole('menuitemradio', { name: business }))
      // Switching business returns to the dashboard, so open the settings again.
      await screen.findByRole('heading', { level: 1, name: 'Dashboard' })
      const navigation = screen.getAllByRole('navigation', { name: 'Primary' })[0]!
      await user.click(within(navigation).getByRole('link', { name: 'Settings' }))
    }

    // The other business has its own saved mode, and this user only has a read-only role there.
    await switchTo(/Sample Corner Cafe/)
    expect(await businessRadio()).toBeChecked()
    expect(await businessRadio()).toBeDisabled()
    expect(merchantService.getMerchantSettings).toHaveBeenCalledWith(SAMPLE_SECOND_MERCHANT_ID)

    // Back in the first business, the saved choice is still there and still editable.
    await switchTo(/Sample Shop/)
    expect(await simplifiedRadio()).toBeChecked()
    expect(await simplifiedRadio()).toBeEnabled()
  })

  it('has no automatically detectable accessibility violations', async () => {
    const { container } = await renderAppAt('/settings')
    await businessRadio()
    expect(await findAccessibilityViolations(container)).toEqual([])
  })
})
