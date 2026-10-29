import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMockDashboardService } from '@/services/mock/mockDashboardService'
import { DEMO_USER_IDS } from '@/services/mock/sampleAccounts'
import { SAMPLE_BRANCH_IDS } from '@/services/mock/sampleOrganization'
import { SAMPLE_MERCHANT_ID, SAMPLE_SECOND_MERCHANT_ID } from '@/services/mock/sampleMerchants'
import { getActiveTestBackend, useFastBackend } from '@/test/merchantTestDouble'
import { renderAppAt } from '@/test/renderApp'
import { pinSeedClock, restoreClock } from '@/test/seedClock'

/** The value shown on the KPI card with this label. */
const kpi = (label: string) => screen.getByText(label).closest('div')!.parentElement!

async function openDashboard(options: Parameters<typeof renderAppAt>[1] = {}) {
  const result = await renderAppAt('/', options)
  await screen
    .findByText('Verified incoming', {}, { timeout: 5000 })
    .catch(() => screen.findByText('My verified payments'))
  return result
}

beforeEach(() => {
  pinSeedClock()
  useFastBackend()
})

afterEach(() => {
  restoreClock()
})

describe('dashboard figures keep their sources apart', () => {
  it('shows bank-verified payments, issued invoices and outstanding amounts as three different figures', async () => {
    await openDashboard()
    // Hand-computed from the seeds: confirmed transactions, issued invoices, and what is still owed
    // after subtracting ACTIVE allocations (72,000 on 1042 and 100,000 on 1043).
    expect(kpi('Verified incoming')).toHaveTextContent(/RWF\s*486,500/) // confirmed bank transactions
    expect(kpi('Issued invoices')).toHaveTextContent(/RWF\s*1,099,840/) // issued invoices, billed
    expect(kpi('Outstanding balances')).toHaveTextContent(/RWF\s*927,840/) // actual remaining balances
    expect(kpi('Verified incoming')).not.toHaveTextContent('1,099,840')
    // verified incoming = allocated + unmatched collections: nothing is counted twice.
    expect(kpi('Allocated to invoices')).toHaveTextContent(/RWF\s*172,000/)
    expect(kpi('Unmatched collections')).toHaveTextContent(/RWF\s*314,500/)
    expect(kpi('Partly paid invoices')).toHaveTextContent('1')
    expect(kpi('Needs review')).toHaveTextContent('2')
  })

  it('names the source of each figure', async () => {
    await openDashboard()
    expect(kpi('Verified incoming')).toHaveTextContent('Bank-confirmed, each payment counted once')
    expect(kpi('Issued invoices')).toHaveTextContent('billed, not received')
    expect(kpi('Issued invoices')).toHaveTextContent('4 issued')
    expect(kpi('Outstanding balances')).toHaveTextContent('1 overdue')
    expect(kpi('Outstanding balances')).toHaveTextContent('Remaining on issued invoices')
  })

  it('does not count drafts, cancelled or voided invoices as issued or outstanding', async () => {
    await openDashboard()
    // The draft (295,000), cancelled (3,000) and voided (8,000) invoices are in none of the totals.
    expect(kpi('Issued invoices')).not.toHaveTextContent('295,000')
    expect(kpi('Issued invoices')).toHaveTextContent(/RWF\s*1,099,840/)
  })

  it('shows a cashier only their own invoice figures, under different labels', async () => {
    await openDashboard({ signedInAs: 'cashier' })
    // Aline: 221,840 + 72,000 + 98,000 issued; 121,840 + 98,000 still owed after confirmed money.
    expect(kpi('My issued invoices')).toHaveTextContent(/RWF\s*391,840/)
    expect(kpi('My outstanding balances')).toHaveTextContent(/RWF\s*219,840/)
    expect(kpi('My verified payments')).toHaveTextContent(/RWF\s*172,000/)
    // Business-wide figures are never shown to a cashier.
    expect(screen.queryByText('Unmatched collections')).not.toBeInTheDocument()
    expect(screen.queryByText('Needs review')).not.toBeInTheDocument()
    expect(screen.queryByText('Outstanding balances')).not.toBeInTheDocument()
    expect(screen.queryByText('Issued invoices')).not.toBeInTheDocument()
  })

  it('lists recent invoices from the invoice service, with lifecycle and payment labels', async () => {
    await openDashboard()
    const card = screen
      .getByRole('heading', { name: 'Recent invoices' })
      .closest('div')!.parentElement!
    expect(await within(card).findByText(/SMP-INV-1040/)).toBeInTheDocument()
    const row = within(card)
      .getByText(/SMP-INV-1043/)
      .closest('li')!
    expect(within(row).getByText('Umuhuza Hardware')).toBeInTheDocument()
    expect(within(row).getByText('Issued')).toBeInTheDocument()
    expect(within(row).getByText('Partially paid')).toBeInTheDocument()
  })

  it('updates the invoice figures after an invoice is issued, but leaves verified payments alone', async () => {
    const user = userEvent.setup()
    const { router } = await openDashboard()
    expect(kpi('Issued invoices')).toHaveTextContent(/RWF\s*1,099,840/)

    await router.navigate('/invoices/new')
    await screen.findByRole('heading', { level: 1, name: 'New invoice' })
    await user.type(await screen.findByLabelText(/Customer name/), 'New Customer')
    await user.selectOptions(screen.getByLabelText(/^Branch/), SAMPLE_BRANCH_IDS.remera)
    await user.selectOptions(screen.getByLabelText(/Assigned cashier/), DEMO_USER_IDS.cashier)
    const item = within(screen.getByRole('group', { name: 'Item 1' }))
    await user.type(item.getByLabelText(/Description/), 'Service')
    await user.type(item.getByLabelText(/Unit price/), '5000')
    await user.click(screen.getByRole('button', { name: 'Issue invoice' }))
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Issue invoice' }),
    )
    await screen.findByText('Invoice INV-1047 issued.')

    await router.navigate('/')
    await waitFor(() => expect(kpi('Issued invoices')).toHaveTextContent(/RWF\s*1,104,840/))
    expect(kpi('Outstanding balances')).toHaveTextContent(/RWF\s*932,840/)
    // Issuing is not payment: the bank-verified figure does not move.
    expect(kpi('Verified incoming')).toHaveTextContent(/RWF\s*486,500/)
  })

  it('shows only the selected business’s figures after switching, with nothing stale', async () => {
    const user = userEvent.setup()
    await openDashboard()
    await user.click(screen.getByRole('button', { name: /Account menu for/ }))
    const menu = await screen.findByRole('menu')
    await user.click(await within(menu).findByRole('menuitemradio', { name: /Sample Corner Cafe/ }))
    // As a cashier at the cafe, the owner sees only their assigned invoice there.
    await screen.findByText('My issued invoices')
    await waitFor(() => expect(kpi('My issued invoices')).toHaveTextContent(/RWF\s*48,000/))
    expect(kpi('My issued invoices')).not.toHaveTextContent('1,099,840')
  })
})

describe('active cashier figure', () => {
  const dashboard = () => {
    const { store } = getActiveTestBackend()
    return { store, service: createMockDashboardService({ authStore: store }) }
  }
  const count = async (merchantId = SAMPLE_MERCHANT_ID) =>
    (await dashboard().service.getSummary({ merchantId })).activeCashierCount

  it('counts only ACTIVE cashiers with an active account', async () => {
    // Seed: Aline is ACTIVE; Eric is SUSPENDED; the new hire is INVITED; the managers are not cashiers.
    expect(await count()).toBe(1)
  })

  it.each([
    [
      'suspending the membership',
      (store: ReturnType<typeof dashboard>['store']) =>
        store.saveMemberships(
          store
            .loadMemberships()
            .map((m) => (m.id === 'mem-004' ? { ...m, status: 'SUSPENDED' as const } : m)),
        ),
    ],
    [
      'revoking the membership',
      (store: ReturnType<typeof dashboard>['store']) =>
        store.saveMemberships(
          store
            .loadMemberships()
            .map((m) => (m.id === 'mem-004' ? { ...m, status: 'REVOKED' as const } : m)),
        ),
    ],
    [
      'suspending the user account',
      (store: ReturnType<typeof dashboard>['store']) =>
        store.saveUsers(
          store
            .loadUsers()
            .map((u) =>
              u.id === DEMO_USER_IDS.cashier ? { ...u, status: 'SUSPENDED' as const } : u,
            ),
        ),
    ],
  ])('drops to zero after %s', async (_label, change) => {
    change(dashboard().store)
    expect(await count()).toBe(0)
  })

  it('rises when a suspended cashier is reactivated, and is counted per business', async () => {
    const { store } = dashboard()
    store.saveMemberships(
      store
        .loadMemberships()
        .map((m) => (m.id === 'mem-005' ? { ...m, status: 'ACTIVE' as const } : m)),
    )
    expect(await count()).toBe(2)
    // The cafe has its own, separate count: its only cashier-role member is the demo owner.
    expect(await count(SAMPLE_SECOND_MERCHANT_ID)).toBe(1)
  })
})
