import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthContextValue } from '@/app/providers/AuthProvider'

const auth: AuthContextValue = {
  status: 'unauthenticated',
  user: null,
  memberships: [],
  login: vi.fn(),
  register: vi.fn(),
  logout: vi.fn(async () => undefined),
  refreshSession: vi.fn(),
  retrySessionCheck: vi.fn(),
  didSignOutOnPurpose: false,
}

vi.mock('@/app/providers/AuthProvider', () => ({ useAuth: () => auth }))

beforeEach(() => {
  vi.clearAllMocks()
  auth.status = 'unauthenticated'
  auth.user = null
  window.localStorage.clear()
  window.sessionStorage.clear()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('the demo banner', () => {
  it('says on every screen, signed in or not, that nothing is real', async () => {
    const { DemoModeBanner } = await import('./DemoModeBanner')
    render(<DemoModeBanner onReset={() => undefined} />)
    const banner = screen.getByRole('region', { name: 'Demo mode' })
    expect(banner).toHaveTextContent('DEMO MODE — No real money moves')
    // Signed out: no role switch, but the reset is always there.
    expect(screen.queryByRole('button', { name: /Switch role/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reset demo data' })).toBeInTheDocument()
    // Never shown when printing an invoice or a QR code.
    expect(banner.className).toContain('print:hidden')
  })

  it('shows who is signed in and lets them switch to another example role', async () => {
    auth.status = 'authenticated'
    auth.user = { id: 'kd-usr-cashier', fullName: 'Patrick Nsengimana', email: 'demo.cashier@oupay.demo', phoneNumber: '', status: 'ACTIVE', createdAt: '', updatedAt: '' }
    const user = userEvent.setup()
    const { DemoModeBanner } = await import('./DemoModeBanner')
    render(<DemoModeBanner onReset={() => undefined} />)
    expect(screen.getByTestId('demo-signed-in-as')).toHaveTextContent('Signed in as Patrick Nsengimana')
    await user.click(screen.getByRole('button', { name: /Switch role/ }))
    await waitFor(() => expect(auth.logout).toHaveBeenCalledTimes(1))
  })

  it('asks before resetting, does nothing on Cancel, and on confirm clears only the demo and reloads it', async () => {
    window.localStorage.setItem('oupay.demo.branches', '[{"id":"mine"}]')
    window.localStorage.setItem('oupay.demo.demoInitialisedAt', '2026-11-07T00:00:00Z')
    window.localStorage.setItem('oupay.mock.users', '["ordinary"]')
    window.localStorage.setItem('unrelated', 'keep')
    const onReset = vi.fn()
    const user = userEvent.setup()
    const { DemoModeBanner } = await import('./DemoModeBanner')
    render(<DemoModeBanner onReset={onReset} />)

    await user.click(screen.getByRole('button', { name: 'Reset demo data' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Reset demo data?')
    expect(dialog).toHaveTextContent('puts back the original Kigali Demo Supermarket examples')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(onReset).not.toHaveBeenCalled()
    expect(window.localStorage.getItem('oupay.demo.branches')).toBe('[{"id":"mine"}]')

    await user.click(screen.getByRole('button', { name: 'Reset demo data' }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Reset demo data' }))
    expect(onReset).toHaveBeenCalledTimes(1)
    expect(window.localStorage.getItem('oupay.demo.branches')).toBeNull()
    expect(window.localStorage.getItem('oupay.demo.demoInitialisedAt')).toBeNull()
    expect(window.localStorage.getItem('oupay.mock.users')).toBe('["ordinary"]')
    expect(window.localStorage.getItem('unrelated')).toBe('keep')
  })
})

describe('the demo entry screen', () => {
  it('offers the three example people and signs in as the chosen one, remembered across refreshes', async () => {
    const user = userEvent.setup()
    const { DemoEntryPanel } = await import('./DemoEntryPanel')
    render(<DemoEntryPanel />)
    expect(screen.getByText('DEMO MODE — No real money moves')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /Enter the demo as/ })).toHaveLength(3)
    // No PIN, one-time code or bank detail is ever asked for.
    expect(screen.queryByLabelText(/PIN|OTP|one-time|account number/i)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Enter the demo as Manager' }))
    expect(auth.login).toHaveBeenCalledWith({ email: 'demo.manager@oupay.demo', password: 'DemoPass123!' }, { rememberMe: true })
  })

  it('shows a plain message when the demo can not be opened, and lets them try again', async () => {
    // Same module registry as the component, so `instanceof` sees one class.
    const { AuthServiceError } = await import('@/services/authService')
    vi.mocked(auth.login).mockRejectedValueOnce(new AuthServiceError('invalid_credentials', 'That did not work.'))
    const user = userEvent.setup()
    const { DemoEntryPanel } = await import('./DemoEntryPanel')
    render(<DemoEntryPanel />)
    await user.click(screen.getByRole('button', { name: 'Enter the demo as Owner' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('That did not work.')
    expect(screen.getByRole('button', { name: 'Enter the demo as Owner' })).toBeEnabled()
  })
})

describe('the sign-in page chooses by build, and links to the demo only when it is told where it is', () => {
  const renderLogin = async () => {
    const { LoginPage } = await import('@/features/auth/pages/LoginPage')
    return render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    )
  }

  it('the demo build shows the demo entry and no password form', async () => {
    vi.stubEnv('VITE_API_MODE', 'mock')
    vi.stubEnv('VITE_DEMO_EXPERIENCE', 'true')
    vi.resetModules()
    await renderLogin()
    expect(screen.getByRole('button', { name: 'Enter the demo as Owner' })).toBeInTheDocument()
    expect(screen.queryByLabelText(/Password/)).not.toBeInTheDocument()
  })

  it('the real sign-in has the ordinary form, no demo entry, and no demo link unless VITE_DEMO_URL is set', async () => {
    vi.stubEnv('VITE_API_MODE', 'http')
    vi.resetModules()
    await renderLogin()
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Enter the demo/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Try the demo/ })).not.toBeInTheDocument()
  })

  it('the real sign-in links to the separate demo site when its address is configured, opening it in a new tab', async () => {
    vi.stubEnv('VITE_API_MODE', 'http')
    vi.stubEnv('VITE_DEMO_URL', 'https://demo.example.test/')
    vi.resetModules()
    await renderLogin()
    const link = screen.getByRole('link', { name: /Try the demo/ })
    expect(link).toHaveAttribute('href', 'https://demo.example.test/')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link.getAttribute('rel')).toContain('noopener')
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
  })
})
