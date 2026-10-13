import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { authService } from '@/services'
import { DEMO_OUTAGE_EMAIL, DEMO_PASSWORD } from '@/services/mock/sampleAccounts'
import { useFastBackend } from '@/test/merchantTestDouble'
import { renderAppAt } from '@/test/renderApp'
import type { AuthSession } from '@/types/auth'

type User = ReturnType<typeof userEvent.setup>

const heading = (name: string) => screen.findByRole('heading', { level: 1, name })
const field = (label: RegExp) => screen.getByLabelText(label)

async function signIn(user: User, email: string, password: string) {
  await user.type(field(/Email address/), email)
  await user.type(field(/^Password/), password)
  await user.click(screen.getByRole('button', { name: 'Sign in' }))
}

describe('login', () => {
  beforeEach(() => {
    useFastBackend()
  })

  it('signs in with valid credentials and lands on the dashboard', async () => {
    const user = userEvent.setup()
    await renderAppAt('/login', { signedInAs: null })
    await signIn(user, 'owner@oupay.demo', DEMO_PASSWORD)
    expect(await heading('Dashboard')).toBeInTheDocument()
  })

  it('shows a clear error and stays on the page for wrong credentials', async () => {
    const user = userEvent.setup()
    await renderAppAt('/login', { signedInAs: null })
    await signIn(user, 'owner@oupay.demo', 'wrong-password')
    expect(await screen.findByRole('alert')).toHaveTextContent('Incorrect email or password.')
    expect(screen.getByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument()
  })

  it('shows the service error when sign-in is unavailable', async () => {
    const user = userEvent.setup()
    await renderAppAt('/login', { signedInAs: null })
    await signIn(user, DEMO_OUTAGE_EMAIL, DEMO_PASSWORD)
    expect(await screen.findByRole('alert')).toHaveTextContent('temporarily unavailable')
  })

  it('validates required fields before calling the service', async () => {
    const user = userEvent.setup()
    await renderAppAt('/login', { signedInAs: null })
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByText('Email address is required.')).toBeInTheDocument()
    expect(screen.getByText('Enter your password.')).toBeInTheDocument()
    expect(field(/Email address/)).toHaveAttribute('aria-invalid', 'true')
    expect(authService.login).not.toHaveBeenCalled()
  })

  it('shows a loading state and blocks repeat submissions while signing in', async () => {
    const user = userEvent.setup()
    vi.mocked(authService.login).mockImplementation(() => new Promise<AuthSession>(() => {}))
    await renderAppAt('/login', { signedInAs: null })
    await signIn(user, 'owner@oupay.demo', DEMO_PASSWORD)
    const button = await screen.findByRole('button', { name: /Signing in/ })
    expect(button).toBeDisabled()
    expect(authService.login).toHaveBeenCalledTimes(1)
  })

  it('toggles password visibility with an accessible control', async () => {
    const user = userEvent.setup()
    await renderAppAt('/login', { signedInAs: null })
    const password = field(/^Password/)
    const toggle = screen.getByRole('button', { name: 'Show password' })
    expect(password).toHaveAttribute('type', 'password')
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await user.click(toggle)
    expect(password).toHaveAttribute('type', 'text')
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
  })

  it('passes the remembered-session choice to the service', async () => {
    const user = userEvent.setup()
    await renderAppAt('/login', { signedInAs: null })
    await user.click(screen.getByRole('checkbox', { name: 'Keep me signed in' }))
    await signIn(user, 'manager@oupay.demo', DEMO_PASSWORD)
    await heading('Dashboard')
    expect(authService.login).toHaveBeenCalledWith(
      { email: 'manager@oupay.demo', password: DEMO_PASSWORD },
      { rememberMe: true },
    )
  })

  it('links to password recovery and registration', async () => {
    const user = userEvent.setup()
    await renderAppAt('/login', { signedInAs: null })
    expect(screen.getByRole('link', { name: 'Create an account' })).toHaveAttribute(
      'href',
      '/register',
    )
    await user.click(screen.getByRole('link', { name: 'Forgot password?' }))
    expect(await heading('Forgot your password?')).toBeInTheDocument()
  })

  it('labels demo mode clearly', async () => {
    await renderAppAt('/login', { signedInAs: null })
    expect(screen.getByText(/Demo mode/)).toBeInTheDocument()
  })
})

describe('registration', () => {
  beforeEach(() => {
    useFastBackend()
  })

  async function fillRegistration(user: User, overrides: Partial<Record<string, string>> = {}) {
    await user.type(field(/Full name/), overrides.fullName ?? 'Patrick Nshuti')
    await user.type(field(/Email address/), overrides.email ?? 'patrick@example.rw')
    await user.type(field(/Phone number/), overrides.phone ?? '0788 111 222')
    await user.type(field(/^Password/), overrides.password ?? 'Sunrise2026')
    await user.type(field(/Confirm password/), overrides.confirm ?? 'Sunrise2026')
  }

  it('shows validation messages for every invalid field', async () => {
    const user = userEvent.setup()
    await renderAppAt('/register', { signedInAs: null })
    await user.click(screen.getByRole('button', { name: 'Create account' }))
    expect(await screen.findByText('Enter your full name.')).toBeInTheDocument()
    expect(screen.getByText('Phone number is required.')).toBeInTheDocument()
    expect(screen.getByText('Use at least 8 characters.')).toBeInTheDocument()
    expect(screen.getByText('You must accept the terms to create an account.')).toBeInTheDocument()
    expect(authService.register).not.toHaveBeenCalled()
  })

  it('rejects mismatched passwords and weak passwords', async () => {
    const user = userEvent.setup()
    await renderAppAt('/register', { signedInAs: null })
    await fillRegistration(user, { password: 'onlyletters', confirm: 'different' })
    await user.click(screen.getByRole('button', { name: 'Create account' }))
    expect(
      await screen.findByText('Include at least one letter and one number.'),
    ).toBeInTheDocument()
    expect(screen.getByText('Passwords do not match.')).toBeInTheDocument()
  })

  it('creates the account and sends a user without a business to onboarding', async () => {
    const user = userEvent.setup()
    await renderAppAt('/register', { signedInAs: null })
    await fillRegistration(user)
    await user.click(screen.getByRole('checkbox', { name: /I agree/ }))
    await user.click(screen.getByRole('button', { name: 'Create account' }))

    expect(await heading('Business details')).toBeInTheDocument()
    expect(authService.register).toHaveBeenCalledWith({
      fullName: 'Patrick Nshuti',
      email: 'patrick@example.rw',
      phoneNumber: '+250788111222',
      password: 'Sunrise2026',
    })
  })

  it('reports an email that is already registered on the email field', async () => {
    const user = userEvent.setup()
    await renderAppAt('/register', { signedInAs: null })
    await fillRegistration(user, { email: 'owner@oupay.demo' })
    await user.click(screen.getByRole('checkbox', { name: /I agree/ }))
    await user.click(screen.getByRole('button', { name: 'Create account' }))
    expect(
      await screen.findByText('An account with this email address already exists.'),
    ).toBeInTheDocument()
    expect(field(/Email address/)).toHaveAttribute('aria-invalid', 'true')
  })
})

describe('forgot password', () => {
  beforeEach(() => {
    useFastBackend()
  })

  it('validates the email address', async () => {
    const user = userEvent.setup()
    await renderAppAt('/forgot-password', { signedInAs: null })
    await user.type(field(/Email address/), 'not-an-email')
    await user.click(screen.getByRole('button', { name: 'Send reset instructions' }))
    expect(await screen.findByText(/valid email address/)).toBeInTheDocument()
    expect(authService.requestPasswordReset).not.toHaveBeenCalled()
  })

  it('shows identical generic feedback for existing and unknown accounts', async () => {
    const user = userEvent.setup()
    const messages: string[] = []
    for (const email of ['owner@oupay.demo', 'nobody@example.com']) {
      const { unmount } = await renderAppAt('/forgot-password', { signedInAs: null })
      await user.type(field(/Email address/), email)
      await user.click(screen.getByRole('button', { name: 'Send reset instructions' }))
      await heading('Check your email')
      messages.push(screen.getByText(/If an account exists/).textContent ?? '')
      unmount()
    }
    expect(messages[0]).toBe(messages[1])
    expect(messages[0]).not.toContain('@')
  })
})

describe('reset password', () => {
  beforeEach(() => {
    useFastBackend()
  })

  it('lets a valid link set a new password', async () => {
    const user = userEvent.setup()
    await renderAppAt('/reset-password/demo-valid-token', { signedInAs: null })
    await heading('Choose a new password')
    await user.type(field(/^New password/), 'Another2026')
    await user.type(field(/Confirm new password/), 'Another2026')
    await user.click(screen.getByRole('button', { name: 'Reset password' }))
    expect(await heading('Password updated')).toBeInTheDocument()
    expect(authService.resetPassword).toHaveBeenCalledWith({
      token: 'demo-valid-token',
      newPassword: 'Another2026',
    })
    expect(screen.getByRole('link', { name: 'Go to sign in' })).toHaveAttribute('href', '/login')
  })

  it('validates matching, strong passwords', async () => {
    const user = userEvent.setup()
    await renderAppAt('/reset-password/demo-valid-token', { signedInAs: null })
    await heading('Choose a new password')
    await user.type(field(/^New password/), 'Another2026')
    await user.type(field(/Confirm new password/), 'Mismatch2026')
    await user.click(screen.getByRole('button', { name: 'Reset password' }))
    expect(await screen.findByText('Passwords do not match.')).toBeInTheDocument()
    expect(authService.resetPassword).not.toHaveBeenCalled()
  })

  it('explains an expired link and offers a new one', async () => {
    await renderAppAt('/reset-password/demo-expired-token', { signedInAs: null })
    expect(await heading('This reset link has expired')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Request a new link' })).toHaveAttribute(
      'href',
      '/forgot-password',
    )
  })

  it('explains an invalid link', async () => {
    await renderAppAt('/reset-password/garbage', { signedInAs: null })
    expect(await heading('This reset link is not valid')).toBeInTheDocument()
  })

  it('shows an error if the link stops working while submitting', async () => {
    const user = userEvent.setup()
    await renderAppAt('/reset-password/demo-valid-token', { signedInAs: null })
    await heading('Choose a new password')
    vi.mocked(authService.resetPassword).mockRejectedValue(new Error('network'))
    await user.type(field(/^New password/), 'Another2026')
    await user.type(field(/Confirm new password/), 'Another2026')
    await user.click(screen.getByRole('button', { name: 'Reset password' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('could not reset'))
  })
})

describe('verify email', () => {
  beforeEach(() => {
    useFastBackend()
  })

  it('confirms the address once with a valid link, signed in or not', async () => {
    await renderAppAt('/verify-email/demo-verify-token', { signedInAs: null })
    expect(await heading('Email address confirmed')).toBeInTheDocument()
    expect(authService.confirmEmailVerification).toHaveBeenCalledTimes(1)
    expect(authService.confirmEmailVerification).toHaveBeenCalledWith('demo-verify-token')
  })

  it('explains a link that is not valid and offers sign-in', async () => {
    await renderAppAt('/verify-email/garbage', { signedInAs: null })
    expect(await heading('This link is not valid')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Go to sign in' })).toHaveAttribute('href', '/login')
  })
})
