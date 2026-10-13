import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PRIMARY_NAVIGATION } from '@/constants/navigation'
import { findAccessibilityViolations } from '@/test/axe'
import { useFastBackend } from '@/test/merchantTestDouble'
import { renderAppAt } from '@/test/renderApp'

describe('accessibility (axe-core, WCAG 2.2 A/AA + best practices)', () => {
  beforeEach(() => {
    useFastBackend()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('dashboard has no violations once data has loaded', async () => {
    const { container } = await renderAppAt('/')
    await screen.findByText('Recent transactions')
    await screen.findAllByText('Confirmed')
    expect(await findAccessibilityViolations(container)).toEqual([])
  })

  it.each(PRIMARY_NAVIGATION.filter(({ path }) => path !== '/'))(
    '$label placeholder page has no violations',
    async ({ path }) => {
      const { container } = await renderAppAt(path)
      expect(await findAccessibilityViolations(container)).toEqual([])
    },
  )

  it('onboarding steps have no violations', async () => {
    const user = userEvent.setup()
    const { container } = await renderAppAt('/onboarding')
    expect(await findAccessibilityViolations(container)).toEqual([])

    // Errors on screen must also be accessible.
    await user.click(screen.getByRole('button', { name: /Continue/ }))
    await screen.findByText('Legal business name is required.')
    expect(await findAccessibilityViolations(container)).toEqual([])
  })

  it('profile page, including its edit form, has no violations', async () => {
    const user = userEvent.setup()
    const { container } = await renderAppAt('/profile')
    await screen.findByText('mrc-sample-001')
    expect(await findAccessibilityViolations(container)).toEqual([])

    await user.click(screen.getByRole('button', { name: /Edit business and contact details/ }))
    expect(await findAccessibilityViolations(container)).toEqual([])
  })

  it('mobile navigation drawer has no violations when open', async () => {
    const user = userEvent.setup()
    await renderAppAt('/')
    await user.click(screen.getByRole('button', { name: 'Open navigation menu' }))
    const dialog = await screen.findByRole('dialog')
    expect(await findAccessibilityViolations(dialog)).toEqual([])
  })

  it('account menu has no violations when open', async () => {
    const user = userEvent.setup()
    await renderAppAt('/')
    await user.click(screen.getByRole('button', { name: /Account menu/ }))
    const menu = await screen.findByRole('menu')
    expect(await findAccessibilityViolations(menu)).toEqual([])
  })

  describe('authentication and access screens', () => {
    it('sign in page, including its error state, has no violations', async () => {
      const user = userEvent.setup()
      const { container } = await renderAppAt('/login', { signedInAs: null })
      await screen.findByRole('heading', { level: 1, name: 'Sign in' })
      expect(await findAccessibilityViolations(container)).toEqual([])
      await user.click(screen.getByRole('button', { name: 'Sign in' }))
      await screen.findByText('Enter your password.')
      expect(await findAccessibilityViolations(container)).toEqual([])
    })

    it('registration page, including its errors, has no violations', async () => {
      const user = userEvent.setup()
      const { container } = await renderAppAt('/register', { signedInAs: null })
      expect(await findAccessibilityViolations(container)).toEqual([])
      await user.click(screen.getByRole('button', { name: 'Create account' }))
      await screen.findByText('Enter your full name.')
      expect(await findAccessibilityViolations(container)).toEqual([])
    })

    it('forgot password page and its confirmation have no violations', async () => {
      const user = userEvent.setup()
      const { container } = await renderAppAt('/forgot-password', { signedInAs: null })
      expect(await findAccessibilityViolations(container)).toEqual([])
      await user.type(screen.getByLabelText(/Email address/), 'a@b.rw')
      await user.click(screen.getByRole('button', { name: 'Send reset instructions' }))
      await screen.findByRole('heading', { name: 'Check your email' })
      expect(await findAccessibilityViolations(container)).toEqual([])
    })

    it.each([
      ['demo-valid-token', 'Choose a new password'],
      ['demo-expired-token', 'This reset link has expired'],
      ['garbage', 'This reset link is not valid'],
    ])('reset password page for %s has no violations', async (token, title) => {
      const { container } = await renderAppAt(`/reset-password/${token}`, {
        signedInAs: null,
      })
      await screen.findByRole('heading', { level: 1, name: title })
      expect(await findAccessibilityViolations(container)).toEqual([])
    })

    it('403 page has no violations', async () => {
      const { container } = await renderAppAt('/reports', { signedInAs: 'cashier' })
      await screen.findByRole('heading', { level: 1, name: 'Access denied' })
      expect(await findAccessibilityViolations(container)).toEqual([])
    })

    it('no-access page has no violations', async () => {
      const { container } = await renderAppAt('/', { signedInAs: 'suspended' })
      await screen.findByRole('heading', { level: 1, name: 'No business access right now' })
      expect(await findAccessibilityViolations(container)).toEqual([])
    })

    it('cashier dashboard and profile have no violations', async () => {
      const { container, router } = await renderAppAt('/', { signedInAs: 'cashier' })
      await screen.findAllByText('SMP-INV-1042')
      expect(await findAccessibilityViolations(container)).toEqual([])
      await router.navigate('/profile')
      await screen.findByText('Business information')
      expect(await findAccessibilityViolations(container)).toEqual([])
    })

    it('account menu with the business switcher has no violations', async () => {
      const user = userEvent.setup()
      await renderAppAt('/', { signedInAs: 'owner' })
      await screen.findByRole('heading', { level: 1, name: 'Dashboard' })
      await user.click(screen.getByRole('button', { name: /Account menu for/ }))
      const menu = await screen.findByRole('menu')
      await screen.findByText('Switch business')
      expect(await findAccessibilityViolations(menu)).toEqual([])
    })
  })
})
