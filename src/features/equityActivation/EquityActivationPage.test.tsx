import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PRIMARY_NAVIGATION } from '@/constants/navigation'
import { kycService } from '@/services'
import { KycServiceError } from '@/services/kycService'
import { findAccessibilityViolations } from '@/test/axe'
import { getActiveTestBackend, useFastBackend, type DemoUserKey } from '@/test/merchantTestDouble'
import { renderAppAt } from '@/test/renderApp'

type User = ReturnType<typeof userEvent.setup>

const ID_NUMBER = '1199880012345678'

async function open(as: DemoUserKey = 'owner') {
  return renderAppAt('/equity-activation', { signedInAs: as })
}

const field = (label: RegExp | string) => screen.findByLabelText(label)
const button = (name: RegExp | string) => screen.getByRole('button', { name })

async function startApplication(user: User) {
  await user.click(await screen.findByRole('button', { name: 'Start application' }))
  await screen.findByRole('heading', { level: 2, name: 'Business information' })
}

/** Fills what registration cannot know, walking through the steps like a person would. */
async function completeThroughToConsent(user: User) {
  await user.click(button('Next'))
  await screen.findByRole('heading', { level: 2, name: 'Representative information' })
  await user.selectOptions(await field(/Role in the business/), 'OWNER')
  await user.selectOptions(await field(/Identity document type/), 'NATIONAL_ID')
  await user.click(button('Next'))
  await screen.findByRole('heading', { level: 2, name: 'Equity account information' })
  await user.selectOptions(await field(/already have an Equity business account/), 'NO')
  await user.click(button('Next'))
  await screen.findByRole('heading', { level: 2, name: 'Document requirements' })
  await user.click(button('Next'))
  await screen.findByRole('heading', { level: 2, name: 'Consent and review' })
}

beforeEach(() => {
  useFastBackend()
})

describe('Equity activation: access', () => {
  it('is for owners: other roles get an access-denied page and no navigation entry', async () => {
    for (const person of ['manager', 'cashier'] as const) {
      const { unmount } = await open(person)
      expect(
        await screen.findByRole('heading', { level: 1, name: 'Access denied' }),
      ).toBeInTheDocument()
      expect(screen.queryByText('Prepare your Equity application')).not.toBeInTheDocument()
      expect(kycService.getOptions).not.toHaveBeenCalled()
      unmount()
    }
    for (const person of ['manager', 'cashier'] as const) {
      const { unmount } = await renderAppAt('/invoices', { signedInAs: person })
      const nav = await screen.findByRole('navigation', { name: 'Primary' })
      await within(nav).findByRole('link', { name: 'Settings' })
      expect(within(nav).queryByRole('link', { name: 'Equity activation' })).not.toBeInTheDocument()
      unmount()
    }
    await renderAppAt('/invoices')
    const nav = await screen.findByRole('navigation', { name: 'Primary' })
    expect(await within(nav).findByRole('link', { name: 'Equity activation' })).toHaveAttribute(
      'href',
      '/equity-activation',
    )
    expect(PRIMARY_NAVIGATION.find((item) => item.path === '/equity-activation')?.permission).toBe(
      'kyc:manage',
    )
  })
})

describe('Equity activation: the application', () => {
  it('explains honestly what it is before anything starts, and passes axe', async () => {
    const { container } = await open()
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Equity activation' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { level: 2, name: 'Prepare your Equity application' }),
    ).toBeInTheDocument()
    expect(screen.getByText(/Equity has not confirmed it/)).toBeInTheDocument()
    expect(screen.getByText(/Documents cannot be uploaded yet/)).toBeInTheDocument()
    expect(screen.getByText(/does not send it to Equity yet/)).toBeInTheDocument()
    expect(
      screen.getByText(/never asks for an online banking password, PIN or one-time code/),
    ).toBeInTheDocument()
    expect(screen.getByRole('note')).toHaveTextContent('Demo mode.')
    expect(await findAccessibilityViolations(container)).toEqual([])
  })

  it('starts a draft with the registration details filled in, and marks required and optional items', async () => {
    const user = userEvent.setup()
    const { container } = await open()
    await startApplication(user)
    expect(await field(/Legal business name/)).toHaveValue('Sample Business Ltd')
    expect(await field(/Registration number/)).toHaveValue('SMP-RDB-000123')
    expect(((await field(/Physical address/)) as HTMLInputElement).value).toContain('KG 11 Ave')
    expect(await field(/Contact email/)).toHaveValue('owner@sample-business.example')
    expect(await field(/Legal business name/)).toBeRequired()
    expect(screen.getByLabelText(/Tax identification number/)).not.toBeRequired()
    expect(
      screen.getAllByText('Filled in from your business registration. Check it is right.').length,
    ).toBeGreaterThan(0)
    expect(screen.getByRole('navigation', { name: 'Application steps' })).toBeInTheDocument()
    // On a narrow screen the stepper collapses to one line that still says where you are.
    expect(screen.getByText(/Step 1 of 6:/)).toBeInTheDocument()
    expect(await findAccessibilityViolations(container)).toEqual([])
  })

  it('refuses to move on with something required missing, and names the problem', async () => {
    const user = userEvent.setup()
    await open()
    await startApplication(user)
    await user.clear(await field(/Legal business name/))
    await user.click(button('Next'))
    expect(
      await screen.findByText('Please complete the required items marked below.'),
    ).toBeInTheDocument()
    expect(screen.getByText('Legal business name is required.')).toBeInTheDocument()
    expect(await field(/Legal business name/)).toHaveAttribute('aria-invalid', 'true')
    expect(
      screen.getByRole('heading', { level: 2, name: 'Business information' }),
    ).toBeInTheDocument()
    // A badly formed value is refused in the browser, without repeating it.
    await user.type(await field(/Legal business name/), 'Shop')
    await user.clear(await field(/Contact email/))
    await user.type(await field(/Contact email/), 'not-an-email')
    await user.click(button('Next'))
    const alerts = await screen.findAllByText(/Contact email is not a valid email address/)
    expect(alerts.length).toBeGreaterThan(0)
    expect(screen.queryByText(/not-an-email/)).not.toBeInTheDocument()
    expect(kycService.saveAnswers).not.toHaveBeenCalled()
  })

  it('saves a draft and resumes it after leaving', async () => {
    const user = userEvent.setup()
    const first = await open()
    await startApplication(user)
    const tin = await field(/Tax identification number/)
    await user.clear(tin)
    await user.type(tin, '123456789')
    expect(screen.getByText('You have unsaved changes.')).toBeInTheDocument()
    await user.click(button('Save draft'))
    expect(await screen.findByText('Draft saved.')).toBeInTheDocument()
    // Moving between steps keeps what was typed, saved or not.
    const nationality = async () => field(/Nationality/)
    await user.click(button('Next'))
    await user.type(await nationality(), 'Rwandan')
    await user.click(button('Back'))
    await user.click(button('Next'))
    expect(await nationality()).toHaveValue('Rwandan')
    await user.click(button('Save draft'))
    await screen.findByText('Draft saved.')
    first.unmount()

    await open()
    // The application is still a draft; it opens at the first step with everything saved.
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Business information' }),
    ).toBeInTheDocument()
    expect(await field(/Tax identification number/)).toHaveValue('123456789')
    await user.click(button('Next'))
    expect(await nationality()).toHaveValue('Rwandan')
    expect(screen.queryByRole('button', { name: 'Start application' })).not.toBeInTheDocument()
  })

  it('keeps a protected value out of the page and out of every browser store, and offers no way to read it back', async () => {
    const user = userEvent.setup()
    await open()
    await startApplication(user)
    await user.click(button('Next'))
    await user.type(await field(/Identity document number/), ID_NUMBER)
    await user.click(button('Save draft'))
    expect(await screen.findByText(/A value is saved \(••••5678\)/)).toBeInTheDocument()
    // Not in the page, not in the field, not in any storage the browser keeps.
    expect(document.body.textContent).not.toContain(ID_NUMBER)
    expect(await field(/Identity document number/)).toHaveValue('')
    for (const store of [window.localStorage, window.sessionStorage]) {
      for (let index = 0; index < store.length; index += 1) {
        expect(store.getItem(store.key(index) as string)).not.toContain(ID_NUMBER)
      }
    }
    // Showing a saved value in full is unavailable (the server keeps it disabled), so no control and no call.
    expect(screen.queryByRole('button', { name: 'Show saved value' })).not.toBeInTheDocument()
    expect(kycService.revealValue).not.toHaveBeenCalled()
    // Typing a new value replaces it.
    await user.type(await field(/Identity document number/), '9988 7766 5544')
    await user.click(button('Save draft'))
    expect(await screen.findByText(/A value is saved \(••••5544\)/)).toBeInTheDocument()
  })

  it('keeps nothing personal in the tab session, only random retry identifiers', async () => {
    const user = userEvent.setup()
    await open()
    await startApplication(user)
    await completeThroughToConsent(user)
    await user.click(screen.getByLabelText('I have read this and I agree'))
    await user.click(button('Give consent'))
    await screen.findByText(/Consent recorded by/)
    const stored = Object.keys(window.sessionStorage).map(
      (key) => `${key}=${window.sessionStorage.getItem(key)}`,
    )
    expect(stored.join(' ')).not.toMatch(/Sample|owner@|\+250|SMP-RDB|KG 11/)
  })

  it('tracks documents without pretending to receive any', async () => {
    const user = userEvent.setup()
    await open()
    await startApplication(user)
    await user.click(button('Next'))
    await user.selectOptions(await field(/Role in the business/), 'OWNER')
    await user.selectOptions(await field(/Identity document type/), 'NATIONAL_ID')
    await user.click(button('Next'))
    await user.selectOptions(await field(/already have an Equity business account/), 'NO')
    await user.click(button('Next'))
    await screen.findByRole('heading', { level: 2, name: 'Document requirements' })
    const note = screen.getByText(/cannot be uploaded yet/)
    expect(note).toHaveTextContent(/Nothing is received here/)
    for (const upload of screen.getAllByRole('button', { name: 'Upload' }))
      expect(upload).toBeDisabled()
    expect(screen.getAllByText('Not provided').length).toBeGreaterThan(0)
    const ready = screen.getByLabelText(/I have my representative identity document ready/)
    await user.click(ready)
    expect(
      await screen.findByText(/You say this is ready. OuPay has not received a file./),
    ).toBeInTheDocument()
    expect(screen.queryByText(/Received and stored/)).not.toBeInTheDocument()
    expect(screen.getAllByText('Required').length).toBeGreaterThan(0)
    expect(screen.getByText('Optional')).toBeInTheDocument()
  })

  it('needs complete information, an explicit consent and then a submission that only reaches OuPay', async () => {
    const user = userEvent.setup()
    const { container } = await open()
    await startApplication(user)
    await completeThroughToConsent(user)
    expect(
      await screen.findByRole('heading', { level: 3, name: 'Review what you are giving to OuPay' }),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/does not mean that Equity has received, reviewed or approved it/),
    ).toBeInTheDocument()
    // Submitting needs consent first; consent needs the explicit agreement.
    expect(button('Submit to OuPay')).toBeDisabled()
    expect(button('Give consent')).toBeDisabled()
    await user.click(screen.getByLabelText('I have read this and I agree'))
    await user.click(button('Give consent'))
    expect(await screen.findByText(/Consent recorded by Sample Owner/)).toBeInTheDocument()
    expect(await findAccessibilityViolations(container)).toEqual([])
    expect(button('Submit to OuPay')).toBeEnabled()
    await user.click(button('Submit to OuPay'))

    // The status says what is true: OuPay has it; Equity has not.
    await screen.findByText('Submitted to OuPay', { selector: 'p' })
    const status = document.querySelector('[data-status]') as HTMLElement
    expect(status).toHaveAttribute('data-status', 'COLLECTED')
    expect(status).toHaveTextContent('Submitted to OuPay')
    expect(status).toHaveTextContent(/has not been sent to Equity/)
    expect(
      screen.queryByText(/Approved by Equity|Handed to Equity|Not approved/),
    ).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Submit to OuPay' })).not.toBeInTheDocument()
    expect(screen.getByText('Documents OuPay still needs')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Back to editing' })).not.toBeInTheDocument()
    expect(screen.getByText('Submitted to OuPay', { selector: 'dt' })).toBeInTheDocument()
  })

  it('asks for consent again after a change, and keeps the same submission id for a retry', async () => {
    const user = userEvent.setup()
    await open()
    await startApplication(user)
    await completeThroughToConsent(user)
    await user.click(screen.getByLabelText('I have read this and I agree'))
    await user.click(button('Give consent'))
    await screen.findByText(/Consent recorded by/)
    // Change something: the consent no longer covers it.
    await user.click(button('Back'))
    await user.click(button('Back'))
    await user.click(button('Back'))
    await user.click(button('Back'))
    const tin = await field(/Tax identification number/)
    await user.clear(tin)
    await user.type(tin, '123456789')
    await user.click(button('Save draft'))
    await screen.findByText('Draft saved.')
    for (let i = 0; i < 4; i += 1) await user.click(button('Next'))
    expect(await screen.findByText(/You changed information after consenting/)).toBeInTheDocument()
    expect(button('Submit to OuPay')).toBeDisabled()

    // A submission that fails is retried with the SAME identifier.
    await user.click(screen.getByLabelText('I have read this and I agree'))
    await user.click(button('Give consent'))
    await screen.findByText(/Consent recorded by/)
    vi.mocked(kycService.submit).mockRejectedValueOnce(
      new KycServiceError('service_unavailable', 'The service is not reachable.'),
    )
    await user.click(button('Submit to OuPay'))
    expect(await screen.findByRole('alert')).toHaveTextContent('not reachable')
    await user.click(button('Submit to OuPay'))
    await screen.findByText('Submitted to OuPay', { selector: 'p' })
    const calls = vi.mocked(kycService.submit).mock.calls
    expect(calls).toHaveLength(2)
    expect(calls[1]?.[3]).toBe(calls[0]?.[3])
  })

  it('shows a submitted application read-only on return, never as sent to or approved by Equity', async () => {
    const user = userEvent.setup()
    const first = await open()
    await startApplication(user)
    await completeThroughToConsent(user)
    await user.click(screen.getByLabelText('I have read this and I agree'))
    await user.click(button('Give consent'))
    await screen.findByText(/Consent recorded by/)
    await user.click(button('Submit to OuPay'))
    await screen.findByText('Submitted to OuPay', { selector: 'p' })
    first.unmount()

    await open()
    expect(await screen.findByText('Submitted to OuPay', { selector: 'p' })).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Application steps' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/Legal business name/)).not.toBeInTheDocument()
    expect(getActiveTestBackend().store.loadRecords('oupay.mock.kycApplications', [])).toHaveLength(
      1,
    )
  })

  it('reports a failure to load or save in words, with a retry for loading', async () => {
    const user = userEvent.setup()
    vi.mocked(kycService.getOptions).mockRejectedValueOnce(
      new KycServiceError('service_unavailable', 'down'),
    )
    await open()
    expect(await screen.findByText('Equity activation could not be loaded.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    await screen.findByRole('heading', { level: 2, name: 'Prepare your Equity application' })
    vi.mocked(kycService.startApplication).mockRejectedValueOnce(
      new KycServiceError('service_unavailable', 'The service is not reachable.'),
    )
    await user.click(screen.getByRole('button', { name: 'Start application' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('not reachable')
    await user.click(screen.getByRole('button', { name: 'Start application' }))
    await screen.findByRole('heading', { level: 2, name: 'Business information' })
    const calls = vi.mocked(kycService.startApplication).mock.calls
    expect(calls[1]?.[1]).toBe(calls[0]?.[1])
  })
})
