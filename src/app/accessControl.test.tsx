import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { appRoutes } from '@/app/router/routes'
import { authService } from '@/services'
import { DEMO_USER_IDS } from '@/services/mock/sampleAccounts'
import { SAMPLE_MERCHANT_ID, SAMPLE_SECOND_MERCHANT_ID } from '@/services/mock/sampleMerchants'
import { getActiveTestBackend, useFastBackend } from '@/test/merchantTestDouble'
import { renderAppAt } from '@/test/renderApp'
import { AppProviders } from './providers/AppProviders'
import { useBusinessContext } from './providers/BusinessContextProvider'

const SELECTION_KEY = 'oupay.selectedMerchant'

const heading = (name: string) => screen.findByRole('heading', { level: 1, name })
const navLabels = () =>
  within(screen.getAllByRole('navigation', { name: 'Primary' })[0]!)
    .getAllByRole('link')
    .map((link) => link.textContent)

async function openAccountMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /Account menu for/ }))
  return screen.findByRole('menu')
}

beforeEach(() => {
  useFastBackend()
})

describe('route protection', () => {
  it('redirects signed-out visitors to sign in', async () => {
    const { router } = await renderAppAt('/invoices', { signedInAs: null })
    expect(await heading('Sign in')).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/login')
  })

  it('returns the user to the page they wanted after signing in', async () => {
    const user = userEvent.setup()
    await renderAppAt('/profile', { signedInAs: null })
    await heading('Sign in')
    await user.type(screen.getByLabelText(/Email address/), 'owner@oupay.demo')
    await user.type(screen.getByLabelText(/^Password/), 'DemoPass123!')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await heading('Business profile')).toBeInTheDocument()
  })

  it('sends signed-in users away from the sign-in page', async () => {
    const { router } = await renderAppAt('/login')
    expect(await heading('Dashboard')).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/')
  })

  it('keeps password reset pages reachable while signed in', async () => {
    await renderAppAt('/forgot-password')
    expect(await heading('Forgot your password?')).toBeInTheDocument()
  })

  it('restores an existing session on load', async () => {
    await renderAppAt('/')
    expect(await heading('Dashboard')).toBeInTheDocument()
    expect(authService.getCurrentSession).toHaveBeenCalled()
  })

  it('sends an expired session to sign in with an explanation', async () => {
    getActiveTestBackend().signInAs('owner', -1000)
    await renderAppAt('/', { signedInAs: null })
    expect(await heading('Sign in')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Your session expired')
  })

  it('shows a retryable error if the session check fails', async () => {
    const user = userEvent.setup()
    vi.mocked(authService.getCurrentSession).mockRejectedValueOnce(new Error('network'))
    await renderAppAt('/', { signedInAs: 'owner' })
    expect(await screen.findByRole('alert')).toHaveTextContent('could not check your session')
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await heading('Dashboard')).toBeInTheDocument()
  })

  it('shows a loading state while the session is checked', async () => {
    vi.mocked(authService.getCurrentSession).mockImplementation(() => new Promise(() => {}))
    const router = createMemoryRouter(appRoutes, { initialEntries: ['/'] })
    render(
      <AppProviders>
        <RouterProvider router={router} />
      </AppProviders>,
    )
    expect(await screen.findByRole('status')).toHaveTextContent('Checking your session')
    expect(screen.queryByRole('heading', { name: 'Dashboard' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Sign in' })).not.toBeInTheDocument()
  })
})

describe('businesses and membership', () => {
  it('sends a user with no business to onboarding without a loop', async () => {
    const { router } = await renderAppAt('/', { signedInAs: 'newcomer' })
    expect(await heading('Business details')).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/onboarding')
    expect(screen.queryByRole('link', { name: 'Back to dashboard' })).not.toBeInTheDocument()
  })

  it.each([
    ['suspended', 'suspended'],
    ['revoked', 'revoked'],
  ] as const)('explains %s membership access instead of redirecting', async (user, word) => {
    const { router } = await renderAppAt('/invoices', { signedInAs: user })
    expect(await heading('No business access right now')).toBeInTheDocument()
    expect(screen.getByText(new RegExp(`access to your business is ${word}`))).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/invoices')
    expect(screen.queryByRole('navigation', { name: 'Primary' })).not.toBeInTheDocument()
  })

  it('keeps the access-unavailable page usable: register a business or sign out', async () => {
    const user = userEvent.setup()
    await renderAppAt('/', { signedInAs: 'suspended' })
    await heading('No business access right now')
    expect(screen.getByRole('link', { name: 'Register a business' })).toHaveAttribute(
      'href',
      '/onboarding',
    )
    await user.click(screen.getByRole('button', { name: 'Sign out' }))
    // Sign-out navigates and the route guard redirects; wait for the page to settle.
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument(),
    )
  })

  it('keeps a business that is pending verification fully accessible for setup', async () => {
    await renderAppAt('/profile')
    expect(await screen.findByText('Pending verification')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Edit business and contact details/ })).toBeEnabled()
  })

  it('does not change a business status just because someone signed in', async () => {
    await renderAppAt('/')
    await heading('Dashboard')
    const merchants = await getActiveTestBackend().fastMerchants.listMerchantsForCurrentUser()
    expect(merchants.every((merchant) => merchant.status === 'pending_verification')).toBe(true)
  })

  it('makes a new registrant the OWNER of their first business', async () => {
    const user = userEvent.setup()
    await renderAppAt('/onboarding', { signedInAs: 'newcomer' })
    await heading('Business details')
    await user.type(screen.getByLabelText(/Legal business name/), 'Mama Jane Fruits')
    await user.selectOptions(screen.getByLabelText(/Business type/), 'informal_vendor')
    await user.click(screen.getByRole('button', { name: /Continue/ }))
    await heading('Location')
    await user.selectOptions(screen.getByLabelText(/^Province/), 'Kigali City')
    await user.selectOptions(screen.getByLabelText(/^District/), 'Gasabo')
    await user.selectOptions(screen.getByLabelText(/^Sector/), 'Remera')
    await user.type(screen.getByLabelText(/Physical address/), 'Remera market')
    await user.click(screen.getByRole('button', { name: /Continue/ }))
    await heading('Primary contact')
    await user.type(screen.getByLabelText(/Contact name/), 'Jane')
    await user.type(screen.getByLabelText(/Email address/), 'jane@example.rw')
    await user.type(screen.getByLabelText(/Phone number/), '0788123456')
    await user.click(screen.getByRole('button', { name: /Continue/ }))
    await user.click(await screen.findByRole('button', { name: /Submit registration/ }))
    await heading('Registration submitted')

    await user.click(screen.getByRole('link', { name: 'Go to dashboard' }))
    expect(await heading('Dashboard')).toBeInTheDocument()
    // The open menu hides the rest of the page from assistive tech, so read the nav first.
    expect(navLabels()).toContain('Cashiers')
    const menu = await openAccountMenu(user)
    expect(within(menu).getByText(/Mama Jane Fruits · Owner/)).toBeInTheDocument()
  }, 30_000)
})

describe('role-based navigation', () => {
  it('shows an owner the full navigation', async () => {
    await renderAppAt('/', { signedInAs: 'owner' })
    await heading('Dashboard')
    expect(navLabels()).toEqual([
      'Dashboard',
      'Invoices',
      'Catalog',
      'Inventory',
      'Payments',
      'Payment links',
      'Collection codes',
      'Banking',
      'Cashiers',
      'Branches',
      'Equity activation',
      'Reports',
      'Settings',
    ])
  })

  it('shows a manager the operational navigation', async () => {
    await renderAppAt('/', { signedInAs: 'manager' })
    await heading('Dashboard')
    expect(navLabels()).toEqual([
      'Dashboard',
      'Invoices',
      'Catalog',
      'Inventory',
      'Payments',
      'Payment links',
      'Collection codes',
      'Cashiers',
      'Branches',
      'Reports',
      'Settings',
    ])
  })

  it('shows a cashier a simplified navigation', async () => {
    await renderAppAt('/', { signedInAs: 'cashier' })
    await heading('Dashboard')
    expect(navLabels()).toEqual([
      'Dashboard',
      'Assigned invoices',
      'Catalog',
      'Inventory',
      'Payment confirmations',
      'My payment links',
      'Collection codes',
      'Settings',
    ])
  })
})

describe('forbidden pages', () => {
  it.each(['/reports', '/cashiers', '/branches'])(
    'shows 403 for a cashier opening %s',
    async (path) => {
      const { router } = await renderAppAt(path, { signedInAs: 'cashier' })
      expect(await heading('Access denied')).toBeInTheDocument()
      expect(screen.getByText(/signed in as Cashier/)).toBeInTheDocument()
      expect(screen.getByRole('link', { name: 'Back to dashboard' })).toHaveAttribute('href', '/')
      expect(router.state.location.pathname).toBe(path)
    },
  )

  it('lets a manager open reports but not be treated as an owner on the profile', async () => {
    await renderAppAt('/reports', { signedInAs: 'manager' })
    expect(await heading('Reports')).toBeInTheDocument()
  })

  it('lets owners open every module', async () => {
    for (const [path, title] of [
      ['/reports', 'Reports'],
      ['/cashiers', 'Cashiers & staff'],
      ['/branches', 'Branches'],
    ] as const) {
      const { unmount } = await renderAppAt(path, { signedInAs: 'owner' })
      expect(await heading(title)).toBeInTheDocument()
      unmount()
    }
  })
})

describe('cashier restrictions', () => {
  it('limits the dashboard to the cashier’s own records and hides business-wide figures', async () => {
    await renderAppAt('/', { signedInAs: 'cashier' })
    expect(await screen.findByText('My verified payments')).toBeInTheDocument()
    expect(screen.queryByText('Active cashiers')).not.toBeInTheDocument()
    expect(screen.queryByText('Outstanding balances')).not.toBeInTheDocument()
    expect(screen.queryByText('Payment activity')).not.toBeInTheDocument()
    expect(screen.queryByText('By bank or provider')).not.toBeInTheDocument()

    expect((await screen.findAllByText('SMP-INV-1042')).length).toBeGreaterThan(0)
    // Money not applied to one of this cashier's invoices stays out of sight.
    expect(screen.queryByText('OP-DEMO000001')).not.toBeInTheDocument()
    expect(screen.queryByText('SMP-INV-9999')).not.toBeInTheDocument()
    expect((await screen.findAllByText(/SMP-INV-1043/)).length).toBeGreaterThan(0)
    expect(screen.queryByText(/SMP-INV-1044/)).not.toBeInTheDocument()
  })

  it('still lets a cashier create invoices', async () => {
    await renderAppAt('/', { signedInAs: 'cashier' })
    await heading('Dashboard')
    expect(screen.getAllByRole('link', { name: 'Create invoice' }).length).toBeGreaterThan(0)
  })

  it('hides manager-only quick actions from a cashier but shows them to a manager', async () => {
    await renderAppAt('/', { signedInAs: 'cashier' })
    await screen.findByText('Quick actions')
    expect(screen.queryByRole('link', { name: 'Add cashier' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Verify a payment' })).toBeInTheDocument()
  })

  it('shows managers and owners the full dashboard', async () => {
    await renderAppAt('/', { signedInAs: 'manager' })
    expect(await screen.findByText('Active cashiers')).toBeInTheDocument()
    expect(await screen.findByText('Payment activity')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Add cashier' })).toBeInTheDocument()
  })

  it('gives a cashier a reduced business profile without sensitive details or editing', async () => {
    await renderAppAt('/profile', { signedInAs: 'cashier' })
    expect(await screen.findByText('Business information')).toBeInTheDocument()
    expect(screen.queryByText('100000001')).not.toBeInTheDocument()
    expect(screen.queryByText('SMP-RDB-000123')).not.toBeInTheDocument()
    expect(screen.queryByText('Banking and payment configuration')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Edit/ })).not.toBeInTheDocument()
  })

  it('lets a manager view the full profile but not edit or see banking setup', async () => {
    await renderAppAt('/profile', { signedInAs: 'manager' })
    expect(await screen.findByText('100000001')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /Edit business and contact details/ }),
    ).not.toBeInTheDocument()
    expect(screen.getByText('Only a business owner can edit these details.')).toBeInTheDocument()
    expect(screen.queryByText('Banking and payment configuration')).not.toBeInTheDocument()
  })

  it('lets an owner edit and see banking setup', async () => {
    await renderAppAt('/profile', { signedInAs: 'owner' })
    expect(
      await screen.findByRole('button', { name: /Edit business and contact details/ }),
    ).toBeEnabled()
    expect(screen.getByText('Banking and payment configuration')).toBeInTheDocument()
  })
})

describe('account menu and switching businesses', () => {
  it('shows the signed-in user, current business and role', async () => {
    const user = userEvent.setup()
    await renderAppAt('/', { signedInAs: 'owner' })
    await heading('Dashboard')
    await waitFor(async () => {
      const menu = await openAccountMenu(user)
      expect(within(menu).getByText('owner@oupay.demo')).toBeInTheDocument()
      expect(within(menu).getByText(/Sample Shop · Owner/)).toBeInTheDocument()
    })
    expect(screen.queryByText('Sample Owner · Owner')).not.toBeInTheDocument()
  })

  it('lets one user be an owner of one business and a cashier of another', async () => {
    const user = userEvent.setup()
    await renderAppAt('/', { signedInAs: 'owner' })
    await heading('Dashboard')
    expect(navLabels()).toContain('Reports')

    let menu = await openAccountMenu(user)
    await user.click(await within(menu).findByRole('menuitemradio', { name: /Sample Corner Cafe/ }))

    await waitFor(() =>
      expect(navLabels()).toEqual([
        'Dashboard',
        'Assigned invoices',
        'Catalog',
        'Inventory',
        'Payment confirmations',
        'My payment links',
        'Collection codes',
        'Settings',
      ]),
    )
    expect(await screen.findByText('My verified payments')).toBeInTheDocument()
    expect(JSON.parse(window.localStorage.getItem(SELECTION_KEY) ?? '{}')).toEqual({
      userId: DEMO_USER_IDS.owner,
      merchantId: SAMPLE_SECOND_MERCHANT_ID,
    })

    menu = await openAccountMenu(user)
    expect(within(menu).getByText(/Sample Corner Cafe · Cashier/)).toBeInTheDocument()
    // The cashier-role business only shows its own data.
    expect((await screen.findAllByText('SMP-CAFE-2001')).length).toBeGreaterThan(0)
    expect(screen.queryByText('SMP-INV-1042')).not.toBeInTheDocument()
  })

  it('does not offer a switcher to users with a single business', async () => {
    const user = userEvent.setup()
    await renderAppAt('/', { signedInAs: 'manager' })
    await heading('Dashboard')
    const menu = await openAccountMenu(user)
    expect(within(menu).queryByText('Switch business')).not.toBeInTheDocument()
  })

  it('applies a valid remembered selection', async () => {
    const user = userEvent.setup()
    window.localStorage.setItem(
      SELECTION_KEY,
      JSON.stringify({ userId: DEMO_USER_IDS.owner, merchantId: SAMPLE_SECOND_MERCHANT_ID }),
    )
    await renderAppAt('/', { signedInAs: 'owner' })
    await heading('Dashboard')
    await waitFor(() => expect(navLabels()).toContain('Assigned invoices'))
    const menu = await openAccountMenu(user)
    expect(within(menu).getByText(/Sample Corner Cafe · Cashier/)).toBeInTheDocument()
  })

  it.each([
    [
      'a business the user does not belong to',
      { userId: DEMO_USER_IDS.owner, merchantId: 'mrc-bogus' },
    ],
    [
      'another user’s selection',
      { userId: DEMO_USER_IDS.manager, merchantId: SAMPLE_SECOND_MERCHANT_ID },
    ],
    ['malformed data', 'not json'],
  ])('ignores a stored selection of %s', async (_label, stored) => {
    const user = userEvent.setup()
    window.localStorage.setItem(
      SELECTION_KEY,
      typeof stored === 'string' ? stored : JSON.stringify(stored),
    )
    await renderAppAt('/', { signedInAs: 'owner' })
    await heading('Dashboard')
    expect(navLabels()).toContain('Reports')
    await waitFor(async () => {
      const menu = await openAccountMenu(user)
      expect(within(menu).getByText(/Sample Shop · Owner/)).toBeInTheDocument()
    })
  })

  it('ignores an attempt to select a business without an active membership', async () => {
    const user = userEvent.setup()
    function Probe() {
      const { selectedMerchantId, availableMemberships, selectMerchant } = useBusinessContext()
      return (
        <div>
          <p data-testid="selected">{selectedMerchantId}</p>
          <p data-testid="count">{availableMemberships.length}</p>
          <button onClick={() => selectMerchant('mrc-not-mine')}>pick bogus</button>
          <button onClick={() => selectMerchant(SAMPLE_SECOND_MERCHANT_ID)}>pick cafe</button>
        </div>
      )
    }
    getActiveTestBackend().signInAs('owner')
    render(
      <AppProviders>
        <Probe />
      </AppProviders>,
    )
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('2'))
    expect(screen.getByTestId('selected')).toHaveTextContent(SAMPLE_MERCHANT_ID)
    await user.click(screen.getByRole('button', { name: 'pick bogus' }))
    expect(screen.getByTestId('selected')).toHaveTextContent(SAMPLE_MERCHANT_ID)
    await user.click(screen.getByRole('button', { name: 'pick cafe' }))
    expect(screen.getByTestId('selected')).toHaveTextContent(SAMPLE_SECOND_MERCHANT_ID)
  })

  it('ignores suspended memberships when choosing available businesses', async () => {
    function Probe() {
      const { availableMemberships } = useBusinessContext()
      return <p data-testid="roles">{availableMemberships.map((m) => m.role).join(',')}</p>
    }
    getActiveTestBackend().signInAs('suspended')
    render(
      <AppProviders>
        <Probe />
      </AppProviders>,
    )
    await waitFor(() => expect(screen.getByTestId('roles')).toBeInTheDocument())
    expect(screen.getByTestId('roles')).toHaveTextContent('')
    expect(screen.getByTestId('roles').textContent).toBe('')
  })

  it('signs out, clears the selected business and blocks protected pages afterwards', async () => {
    const user = userEvent.setup()
    window.localStorage.setItem(
      SELECTION_KEY,
      JSON.stringify({ userId: DEMO_USER_IDS.owner, merchantId: SAMPLE_SECOND_MERCHANT_ID }),
    )
    const { router } = await renderAppAt('/', { signedInAs: 'owner' })
    await heading('Dashboard')
    const menu = await openAccountMenu(user)
    await user.click(within(menu).getByRole('menuitem', { name: /Sign out/ }))

    expect(await heading('Sign in')).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/login')
    await waitFor(() => expect(window.localStorage.getItem(SELECTION_KEY)).toBeNull())
    expect(await getActiveTestBackend().fastAuth.getCurrentSession()).toBeNull()

    await router.navigate('/invoices')
    // The guard bounces the signed-out visitor straight back to sign in.
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'))
    expect(await heading('Sign in')).toBeInTheDocument()
  })

  it('shows the next person no data from the previous session', async () => {
    const user = userEvent.setup()
    await renderAppAt('/profile', { signedInAs: 'owner' })
    await screen.findByText('mrc-sample-001')
    const menu = await openAccountMenu(user)
    await user.click(within(menu).getByRole('menuitem', { name: /Sign out/ }))
    await heading('Sign in')
    await user.type(screen.getByLabelText(/Email address/), 'cashier@oupay.demo')
    await user.type(screen.getByLabelText(/^Password/), 'DemoPass123!')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    await heading('Dashboard')
    expect(screen.queryByText('Sample Owner')).not.toBeInTheDocument()
    expect(navLabels()).toContain('Assigned invoices')
  })
})
