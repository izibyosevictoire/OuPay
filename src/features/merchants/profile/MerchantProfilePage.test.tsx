import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { merchantService } from '@/services'
import { SAMPLE_MERCHANTS } from '@/services/mock/sampleMerchants'
import { useFastBackend } from '@/test/merchantTestDouble'
import { renderAppAt } from '@/test/renderApp'
import type { Merchant, MerchantStatus } from '@/types/merchant'

const sampleMerchant = SAMPLE_MERCHANTS[0]!

const withStatus = (status: MerchantStatus): Merchant => ({ ...sampleMerchant, status })

describe('merchant profile', () => {
  beforeEach(() => {
    useFastBackend()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shows the merchant ID, pending status and registered information', async () => {
    await renderAppAt('/profile')
    expect(await screen.findByText('mrc-sample-001')).toBeInTheDocument()
    expect(screen.getByText('Pending verification')).toBeInTheDocument()
    expect(screen.getByText(/not verified or bank-approved/)).toBeInTheDocument()
    expect(screen.getByText('Sample Business Ltd')).toBeInTheDocument()
    expect(screen.getByText('Registered company')).toBeInTheDocument()
    expect(screen.getByText('100000001')).toBeInTheDocument()
    expect(screen.getByText('Not configured')).toBeInTheDocument()
  })

  it.each<[MerchantStatus, string]>([
    ['draft', 'Draft'],
    ['pending_verification', 'Pending verification'],
    ['active', 'Active'],
    ['suspended', 'Suspended'],
    ['rejected', 'Rejected'],
  ])('labels the %s status distinctly with text', async (status, label) => {
    vi.mocked(merchantService.listMerchantsForCurrentUser).mockResolvedValue([withStatus(status)])
    await renderAppAt('/profile')
    const statusBadge = await screen.findByText(label, { selector: 'span' })
    expect(statusBadge).toBeInTheDocument()
  })

  it('updates permitted fields and shows the saved values', async () => {
    const user = userEvent.setup()
    await renderAppAt('/profile')
    await screen.findByText('mrc-sample-001')

    await user.click(screen.getByRole('button', { name: /Edit business and contact details/ }))
    const tradingName = screen.getByLabelText(/Trading name/)
    await user.clear(tradingName)
    await user.type(tradingName, 'Sample Shop Remera')
    const phone = screen.getByLabelText(/Phone number/)
    await user.clear(phone)
    await user.type(phone, '0733 000 111')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Changes saved.')
    expect(screen.getAllByText('Sample Shop Remera').length).toBeGreaterThan(0)
    expect(screen.getByText('+250733000111')).toBeInTheDocument()
    expect(merchantService.updateMerchant).toHaveBeenCalledWith(
      'mrc-sample-001',
      expect.objectContaining({ tradingName: 'Sample Shop Remera' }),
    )
  })

  it('validates edits and does not save invalid data', async () => {
    const user = userEvent.setup()
    await renderAppAt('/profile')
    await screen.findByText('mrc-sample-001')
    await user.click(screen.getByRole('button', { name: /Edit business and contact details/ }))
    await user.clear(screen.getByLabelText(/Email address/))
    await user.type(screen.getByLabelText(/Email address/), 'nope')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByText(/Enter a valid email address/)).toBeInTheDocument()
    expect(merchantService.updateMerchant).not.toHaveBeenCalled()
  })

  it('shows an error and keeps the form open when saving fails', async () => {
    const user = userEvent.setup()
    vi.mocked(merchantService.updateMerchant).mockRejectedValue(new Error('network'))
    await renderAppAt('/profile')
    await screen.findByText('mrc-sample-001')
    await user.click(screen.getByRole('button', { name: /Edit business and contact details/ }))
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('could not be saved')
    expect(screen.getByRole('form', { name: 'Edit business details' })).toBeInTheDocument()
  })

  it('does not allow registration data to be edited', async () => {
    const user = userEvent.setup()
    await renderAppAt('/profile')
    await screen.findByText('mrc-sample-001')
    await user.click(screen.getByRole('button', { name: /Edit business and contact details/ }))
    const form = screen.getByRole('form', { name: 'Edit business details' })
    expect(within(form).queryByLabelText(/Legal business name/)).not.toBeInTheDocument()
    expect(within(form).queryByLabelText(/Tax Identification Number/)).not.toBeInTheDocument()
  })

  it('disables editing for suspended businesses', async () => {
    vi.mocked(merchantService.listMerchantsForCurrentUser).mockResolvedValue([
      withStatus('suspended'),
    ])
    await renderAppAt('/profile')
    await screen.findByText('mrc-sample-001')
    expect(screen.getByRole('button', { name: /Edit business and contact details/ })).toBeDisabled()
  })

  it('offers registration when the user has no business yet', async () => {
    vi.mocked(merchantService.listMerchantsForCurrentUser).mockResolvedValue([])
    await renderAppAt('/profile')
    expect(await screen.findByText('No business registered yet')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Register a business' })).toHaveAttribute(
      'href',
      '/onboarding',
    )
  })

  it('shows a retryable error when the profile cannot be loaded', async () => {
    vi.mocked(merchantService.listMerchantsForCurrentUser).mockRejectedValue(new Error('down'))
    await renderAppAt('/profile')
    expect(await screen.findByRole('alert', {}, { timeout: 4000 })).toHaveTextContent(
      'could not be loaded',
    )
  })
})
