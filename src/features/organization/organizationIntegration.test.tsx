import { QueryClient } from '@tanstack/react-query'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DEMO_USER_IDS } from '@/services/mock/sampleAccounts'
import { SAMPLE_MERCHANT_ID, SAMPLE_SECOND_MERCHANT_ID } from '@/services/mock/sampleMerchants'
import { createMockDashboardService } from '@/services/mock/mockDashboardService'
import { getActiveTestBackend, useFastBackend } from '@/test/merchantTestDouble'
import { renderAppAt } from '@/test/renderApp'
import { invalidateMerchantOrganization, organizationKeys } from './organizationQueries'

const heading = (name: string) => screen.findByRole('heading', { level: 1, name })
const table = () => within(screen.getByRole('table'))

const activeCashiersFigure = () =>
  screen.getByText('Active cashiers').parentElement!.parentElement!.querySelector('p.tabular-nums')!

/** React Router keeps the old page mounted during a transition, so wait for the new heading. */
async function go(
  router: { navigate: (path: string) => Promise<void> },
  path: string,
  title: string,
) {
  await router.navigate(path)
  await heading(title)
}

beforeEach(() => {
  useFastBackend()
})

describe('dashboard integration', () => {
  it('derives the active-cashier figure from staff memberships, not a separate dataset', async () => {
    const { store } = getActiveTestBackend()
    const dashboard = createMockDashboardService({ authStore: store })
    const scope = { merchantId: SAMPLE_MERCHANT_ID }
    expect((await dashboard.getSummary(scope)).activeCashierCount).toBe(1) // only Aline is an ACTIVE cashier

    store.saveMemberships(
      store.loadMemberships().map((m) => (m.id === 'mem-005' ? { ...m, status: 'ACTIVE' } : m)),
    )
    expect((await dashboard.getSummary(scope)).activeCashierCount).toBe(2)
    // Another business has no cashiers of its own (the owner there is a different person).
    expect(
      (await dashboard.getSummary({ merchantId: SAMPLE_SECOND_MERCHANT_ID })).activeCashierCount,
    ).toBe(1)
  })

  it('refreshes the dashboard figure after a staff change, without a reload', async () => {
    const user = userEvent.setup()
    const { router } = await renderAppAt('/')
    await screen.findByText('Active cashiers')
    await waitFor(() => expect(activeCashiersFigure()).toHaveTextContent('1'))

    await go(router, '/cashiers', 'Cashiers & staff')
    await screen.findByRole('table')
    await user.click(table().getByRole('button', { name: 'Actions for Aline Uwase' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Suspend' }))
    await user.click(await screen.findByRole('button', { name: 'Suspend access' }))
    await screen.findByText('Aline Uwase was suspended.')

    await go(router, '/', 'Dashboard')
    await screen.findByText('Active cashiers')
    // The dashboard query was cached for a minute; only invalidation can have refreshed it.
    await waitFor(() => expect(activeCashiersFigure()).toHaveTextContent('0'))
  })
})

describe('business switching', () => {
  /** Makes the demo owner a manager at the cafe, so both businesses allow branch and staff screens. */
  function makeOwnerAManagerAtTheCafe() {
    const { store } = getActiveTestBackend()
    store.saveMemberships(
      store.loadMemberships().map((m) => (m.id === 'mem-002' ? { ...m, role: 'MANAGER' } : m)),
    )
  }

  async function switchTo(user: ReturnType<typeof userEvent.setup>, businessName: RegExp) {
    await user.click(screen.getByRole('button', { name: /Account menu for/ }))
    const menu = await screen.findByRole('menu')
    await user.click(await within(menu).findByRole('menuitemradio', { name: businessName }))
  }

  it('replaces branch and staff data with the newly selected business’s, never mixing them', async () => {
    const user = userEvent.setup()
    makeOwnerAManagerAtTheCafe()
    const { router } = await renderAppAt('/branches')
    await screen.findByRole('table')
    expect(table().getByText('Remera Main')).toBeInTheDocument()
    expect(table().queryByText('Cafe Nyamirambo')).not.toBeInTheDocument()

    await switchTo(user, /Sample Corner Cafe/)
    await heading('Dashboard')
    await go(router, '/branches', 'Branches')
    await screen.findByRole('table')
    await waitFor(() => expect(table().getByText('Cafe Nyamirambo')).toBeInTheDocument())
    expect(table().queryByText('Remera Main')).not.toBeInTheDocument()

    await go(router, '/cashiers', 'Cashiers & staff')
    await screen.findByRole('table')
    expect(table().getByText('Claudine Mukashema')).toBeInTheDocument()
    expect(table().queryByText('Aline Uwase')).not.toBeInTheDocument()

    // And back again: the first business's data returns, not the cafe's.
    await switchTo(user, /Sample Shop/)
    await heading('Dashboard')
    await go(router, '/cashiers', 'Cashiers & staff')
    await screen.findByRole('table')
    await waitFor(() => expect(table().getByText('Aline Uwase')).toBeInTheDocument())
    expect(table().queryByText('Claudine Mukashema')).not.toBeInTheDocument()
  })

  it('changes the available actions when the role changes with the business', async () => {
    const user = userEvent.setup()
    makeOwnerAManagerAtTheCafe()
    const { router } = await renderAppAt('/cashiers')
    await screen.findByRole('table')
    // As owner of Sample Shop: the role-change action exists.
    await user.click(table().getByRole('button', { name: 'Actions for Aline Uwase' }))
    expect(await screen.findByRole('menuitem', { name: 'Change role' })).toBeInTheDocument()
    await user.keyboard('{Escape}')

    await switchTo(user, /Sample Corner Cafe/)
    await heading('Dashboard')
    await go(router, '/cashiers', 'Cashiers & staff')
    await screen.findByRole('table')
    // As a manager at the cafe, the same screen offers no role changes, and no actions on owners.
    expect(
      table().queryByRole('button', { name: 'Actions for Claudine Mukashema' }),
    ).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Invite staff' })).toBeInTheDocument()
  })

  it('shows a 403 for branch pages after switching to a business where the user is a cashier', async () => {
    const user = userEvent.setup()
    const { router } = await renderAppAt('/branches')
    await screen.findByRole('table')
    await switchTo(user, /Sample Corner Cafe/)
    await heading('Dashboard')
    await router.navigate('/branches')
    expect(await heading('Access denied')).toBeInTheDocument()
    expect(screen.queryByText('Remera Main')).not.toBeInTheDocument()
  })

  it('never lets a cached business leak: assignment options only list the current business’s branches', async () => {
    const user = userEvent.setup()
    makeOwnerAManagerAtTheCafe()
    await renderAppAt('/cashiers', { signedInAs: 'cafeOwner' })
    await screen.findByRole('table')
    await user.click(table().getByRole('button', { name: 'Actions for Sample Owner' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Manage branches' }))
    const dialog = await screen.findByRole('dialog', { name: 'Manage branches' })
    expect(await within(dialog).findByRole('checkbox', { name: /Cafe Nyamirambo/ })).toBeChecked()
    expect(within(dialog).queryByRole('checkbox', { name: /Remera Main/ })).not.toBeInTheDocument()
  })
})

describe('merchant-aware query keys and invalidation', () => {
  it('puts the merchant in every key', () => {
    expect(organizationKeys.branchList('m1')).not.toEqual(organizationKeys.branchList('m2'))
    expect(organizationKeys.staff('m1')).toEqual(['staff', 'm1'])
    expect(organizationKeys.branchDetail('m1', 'b1')).toEqual(['branches', 'm1', 'detail', 'b1'])
  })

  it('invalidates only the affected merchant’s branches, staff and dashboard queries', async () => {
    const client = new QueryClient()
    const seed = (key: readonly unknown[]) => client.setQueryData(key, 'cached')
    seed(organizationKeys.branchList('m1'))
    seed(organizationKeys.branchDetail('m1', 'b1'))
    seed(organizationKeys.staff('m1'))
    seed(['dashboard', 'summary', { merchantId: 'm1' }])
    seed(organizationKeys.branchList('m2'))
    seed(organizationKeys.staff('m2'))
    seed(['dashboard', 'summary', { merchantId: 'm2' }])
    seed(['merchants', 'user-1'])

    await invalidateMerchantOrganization(client, 'm1')

    const invalidated = (key: readonly unknown[]) => client.getQueryState(key)?.isInvalidated
    expect(invalidated(organizationKeys.branchList('m1'))).toBe(true)
    expect(invalidated(organizationKeys.branchDetail('m1', 'b1'))).toBe(true)
    expect(invalidated(organizationKeys.staff('m1'))).toBe(true)
    expect(invalidated(['dashboard', 'summary', { merchantId: 'm1' }])).toBe(true)
    expect(invalidated(organizationKeys.branchList('m2'))).toBe(false)
    expect(invalidated(organizationKeys.staff('m2'))).toBe(false)
    expect(invalidated(['dashboard', 'summary', { merchantId: 'm2' }])).toBe(false)
    expect(invalidated(['merchants', 'user-1'])).toBe(false)
  })

  it('refreshes the branch list staff counts after assigning someone', async () => {
    const user = userEvent.setup()
    const { router } = await renderAppAt('/branches')
    await screen.findByRole('table')
    expect(
      within(table().getByRole('row', { name: /City Centre/ })).getByText('1'),
    ).toBeInTheDocument()

    await go(router, '/cashiers', 'Cashiers & staff')
    await screen.findByRole('table')
    await user.click(table().getByRole('button', { name: 'Actions for Aline Uwase' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Manage branches' }))
    const dialog = await screen.findByRole('dialog', { name: 'Manage branches' })
    await user.click(within(dialog).getByRole('checkbox', { name: /City Centre/ }))
    await user.click(within(dialog).getByRole('button', { name: 'Save branches' }))
    await screen.findByText('Branches updated for Aline Uwase.')

    await go(router, '/branches', 'Branches')
    await screen.findByRole('table')
    await waitFor(() =>
      expect(
        within(table().getByRole('row', { name: /City Centre/ })).getByText('0'),
      ).toBeInTheDocument(),
    )
  })
})

describe('revoked access takes effect', () => {
  it('lets a revoked cashier lose the business as soon as the session refreshes', async () => {
    const { fastStaff, signInAs } = getActiveTestBackend()
    signInAs('owner')
    await fastStaff.revokeMembership(SAMPLE_MERCHANT_ID, 'mem-004')
    signInAs('cashier')
    await renderAppAt('/', { signedInAs: null })
    expect(await heading('No business access right now')).toBeInTheDocument()
    expect(screen.getByText(/access to your business is revoked/)).toBeInTheDocument()
  })

  it('keeps unrelated users’ memberships untouched', async () => {
    const { store, fastStaff, signInAs } = getActiveTestBackend()
    signInAs('owner')
    await fastStaff.revokeMembership(SAMPLE_MERCHANT_ID, 'mem-004')
    const others = store.loadMemberships().filter((m) => m.userId !== DEMO_USER_IDS.cashier)
    expect(others.filter((m) => m.status === 'REVOKED').map((m) => m.id)).toEqual(['mem-006'])
  })
})
