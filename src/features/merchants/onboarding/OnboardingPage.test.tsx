import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { merchantService } from '@/services'
import { SIMULATED_OUTAGE_TIN } from '@/services/mock/mockMerchantService'
import { renderAppAt } from '@/test/renderApp'
import { useFastBackend } from '@/test/merchantTestDouble'
import { SAMPLE_MERCHANTS } from '@/services/mock/sampleMerchants'
import type { Merchant } from '@/types/merchant'

type User = ReturnType<typeof userEvent.setup>

const heading = (name: string) => screen.findByRole('heading', { level: 1, name })
const field = (label: RegExp) => screen.getByLabelText(label)

async function fillBusinessDetails(user: User, tin = '') {
  await user.type(field(/Legal business name/), 'Kivu Fresh Foods Ltd')
  await user.selectOptions(field(/Business type/), 'registered_company')
  await user.type(field(/Registration number/), 'RDB-2024-0042')
  if (tin) await user.type(field(/Tax Identification Number/), tin)
  await user.click(screen.getByRole('button', { name: /Continue/ }))
  await heading('Location')
}

async function fillLocation(user: User) {
  await user.selectOptions(field(/^Province/), 'Kigali City')
  await user.selectOptions(field(/^District/), 'Gasabo')
  await user.selectOptions(field(/^Sector/), 'Remera')
  await user.type(field(/Physical address/), 'KG 11 Ave')
  await user.click(screen.getByRole('button', { name: /Continue/ }))
  await heading('Primary contact')
}

async function fillContact(user: User) {
  await user.type(field(/Contact name/), 'Aline Uwase')
  await user.type(field(/Email address/), 'aline@kivufresh.example')
  await user.type(field(/Phone number/), '0788 123 456')
  await user.click(screen.getByRole('button', { name: /Continue/ }))
  await heading('Review and confirm')
}

async function reachReviewStep(user: User, tin = '') {
  await renderAppAt('/onboarding')
  await fillBusinessDetails(user, tin)
  await fillLocation(user)
  await fillContact(user)
}

describe('business onboarding', () => {
  beforeEach(() => {
    useFastBackend()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('blocks each step until its required fields are valid, with clear messages', async () => {
    const user = userEvent.setup()
    await renderAppAt('/onboarding')

    await user.click(screen.getByRole('button', { name: /Continue/ }))
    expect(await screen.findByText('Legal business name is required.')).toBeInTheDocument()
    expect(
      screen.getByText('Choose the type that best describes the business.'),
    ).toBeInTheDocument()
    expect(field(/Legal business name/)).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('heading', { level: 1, name: 'Business details' })).toBeInTheDocument()
  })

  it('requires a registration number for companies but not for informal vendors', async () => {
    const user = userEvent.setup()
    await renderAppAt('/onboarding')
    await user.type(field(/Legal business name/), 'Mama Jane Fruits')
    await user.selectOptions(field(/Business type/), 'registered_company')
    await user.click(screen.getByRole('button', { name: /Continue/ }))
    expect(
      await screen.findByText('Registration number is required for this business type.'),
    ).toBeInTheDocument()

    await user.selectOptions(field(/Business type/), 'informal_vendor')
    await user.click(screen.getByRole('button', { name: /Continue/ }))
    expect(await heading('Location')).toBeInTheDocument()
  })

  it('validates the TIN format and the contact details', async () => {
    const user = userEvent.setup()
    await renderAppAt('/onboarding')
    await user.type(field(/Legal business name/), 'Mama Jane Fruits')
    await user.selectOptions(field(/Business type/), 'informal_vendor')
    await user.type(field(/Tax Identification Number/), '123')
    await user.click(screen.getByRole('button', { name: /Continue/ }))
    expect(await screen.findByText('A TIN has exactly 9 digits.')).toBeInTheDocument()
  })

  it('keeps entered values when moving back and forward between steps', async () => {
    const user = userEvent.setup()
    await renderAppAt('/onboarding')
    await fillBusinessDetails(user, '123456789')
    await fillLocation(user)

    await user.click(screen.getByRole('button', { name: /Back/ }))
    await heading('Location')
    expect(field(/^Province/)).toHaveValue('Kigali City')
    expect(field(/^District/)).toHaveValue('Gasabo')
    expect(field(/^Sector/)).toHaveValue('Remera')
    expect(field(/Physical address/)).toHaveValue('KG 11 Ave')

    await user.click(screen.getByRole('button', { name: /Back/ }))
    await heading('Business details')
    expect(field(/Legal business name/)).toHaveValue('Kivu Fresh Foods Ltd')
    expect(field(/Business type/)).toHaveValue('registered_company')
    expect(field(/Registration number/)).toHaveValue('RDB-2024-0042')
    expect(field(/Tax Identification Number/)).toHaveValue('123456789')
  })

  it('resets district and sector when the province changes', async () => {
    const user = userEvent.setup()
    await renderAppAt('/onboarding')
    await fillBusinessDetails(user)
    await user.selectOptions(field(/^Province/), 'Kigali City')
    await user.selectOptions(field(/^District/), 'Gasabo')
    await user.selectOptions(field(/^Province/), 'Southern Province')
    expect(field(/^District/)).toHaveValue('')
    expect(screen.queryByRole('option', { name: 'Gasabo' })).not.toBeInTheDocument()
  })

  it('shows every answer on the review step and lets users edit earlier steps', async () => {
    const user = userEvent.setup()
    await reachReviewStep(user)

    expect(screen.getByText('Kivu Fresh Foods Ltd')).toBeInTheDocument()
    expect(screen.getByText('Registered company')).toBeInTheDocument()
    expect(screen.getByText('Remera')).toBeInTheDocument()
    expect(screen.getByText('+250788123456')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Edit location/ }))
    await heading('Location')
    expect(field(/Physical address/)).toHaveValue('KG 11 Ave')
  })

  it('registers the business as pending verification, not approved', async () => {
    const user = userEvent.setup()
    await reachReviewStep(user)
    await user.click(screen.getByRole('button', { name: /Submit registration/ }))

    expect(await heading('Registration submitted')).toBeInTheDocument()
    expect(screen.getByText('Pending verification')).toBeInTheDocument()
    expect(screen.getByText(/not verified or bank-approved/)).toBeInTheDocument()
    expect(screen.getByText(/mrc-/)).toBeInTheDocument()
    expect(merchantService.createMerchant).toHaveBeenCalledWith(
      expect.objectContaining({
        legalName: 'Kivu Fresh Foods Ltd',
        contact: expect.objectContaining({ phoneNumber: '+250788123456' }),
      }),
    )
  })

  it(
    'sends the user back to the business step when the TIN is already registered',
    { timeout: 20_000 },
    async () => {
      const user = userEvent.setup()
      const firstRender = await renderAppAt('/onboarding')
      await fillBusinessDetails(user, '123456789')
      await fillLocation(user)
      await fillContact(user)
      await user.click(screen.getByRole('button', { name: /Submit registration/ }))
      await heading('Registration submitted')

      // Second registration with the same TIN, on a fresh form.
      firstRender.unmount()
      await renderAppAt('/onboarding')
      await fillBusinessDetails(user, '123456789')
      await fillLocation(user)
      await fillContact(user)
      await user.click(screen.getByRole('button', { name: /Submit registration/ }))

      expect(
        await screen.findByText('A business with this TIN is already registered.'),
      ).toBeInTheDocument()
      expect(
        screen.getByRole('heading', { level: 1, name: 'Business details' }),
      ).toBeInTheDocument()
    },
  )

  it('shows a retryable error when the service fails, keeping all entered data', async () => {
    const user = userEvent.setup()
    await reachReviewStep(user, SIMULATED_OUTAGE_TIN)
    await user.click(screen.getByRole('button', { name: /Submit registration/ }))

    expect(await screen.findByRole('alert')).toHaveTextContent('temporarily unavailable')
    expect(screen.getByText('Kivu Fresh Foods Ltd')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Submit registration/ })).toBeEnabled()
  })

  it('prevents duplicate submissions while a request is in flight', async () => {
    const user = userEvent.setup()
    let resolveRequest: (merchant: Merchant) => void = () => {}
    vi.mocked(merchantService.createMerchant).mockImplementation(
      () => new Promise<Merchant>((resolve) => (resolveRequest = resolve)),
    )
    await reachReviewStep(user)

    const submit = screen.getByRole('button', { name: /Submit registration/ })
    await user.dblClick(submit)
    await user.click(submit)

    await waitFor(() => expect(screen.getByRole('button', { name: /Submitting/ })).toBeDisabled())
    expect(merchantService.createMerchant).toHaveBeenCalledTimes(1)
    resolveRequest(SAMPLE_MERCHANTS[0]!)
  })
})
