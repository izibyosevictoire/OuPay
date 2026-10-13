import { screen, within } from '@testing-library/react'
import { afterEach } from 'vitest'
import { isDemoToolsEnabled } from '@/lib/demoTools'
import { PERMISSION_DEFINITIONS } from '@/features/auth/permissions/permissionDefinitions'
import { hasPermission } from '@/features/auth/permissions/permissions'
import { useFastBackend } from '@/test/merchantTestDouble'
import { renderAppAt } from '@/test/renderApp'

beforeEach(() => {
  useFastBackend()
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('route protection for the payment screens', () => {
  it.each([
    '/transactions',
    '/payments',
    '/payment-links',
    '/banking',
    '/payment-links/pp-sample-001/print',
  ])('sends a signed-out visitor from %s to sign in', async (path) => {
    await renderAppAt(path, { signedInAs: null })
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument()
  })

  it.each(['suspended', 'revoked'] as const)(
    'shows a %s member no payment data at all',
    async (user) => {
      await renderAppAt('/transactions', { signedInAs: user })
      expect(
        await screen.findByRole('heading', { level: 1, name: 'No business access right now' }),
      ).toBeInTheDocument()
      expect(screen.queryByText('SMP-INV-1042')).not.toBeInTheDocument()
    },
  )

  it('gives managers the payment screens but not banking, and cashiers read-only access', async () => {
    expect(hasPermission('MANAGER', 'payments:reconcile')).toBe(true)
    expect(hasPermission('MANAGER', 'payment_profiles:manage')).toBe(true)
    expect(hasPermission('MANAGER', 'banking:manage')).toBe(false)
    expect(hasPermission('CASHIER', 'payments:reconcile')).toBe(false)
    expect(hasPermission('CASHIER', 'payment_profiles:manage')).toBe(false)
    expect(hasPermission('CASHIER', 'banking:manage')).toBe(false)
    expect(PERMISSION_DEFINITIONS['payments:reconcile']).toMatchObject({
      OWNER: 'all',
      MANAGER: 'all',
    })
  })

  it('offers the demo simulator to people who may reconcile, and not to cashiers', async () => {
    const cashier = await renderAppAt('/demo/bank-simulator', { signedInAs: 'cashier' })
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Access denied' }),
    ).toBeInTheDocument()
    cashier.unmount()
    await renderAppAt('/demo/bank-simulator', { signedInAs: 'manager' })
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Bank simulator' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('note')).toHaveTextContent(/Demo tool/)
  })
})

describe('demo tooling is never part of a normal build', () => {
  it('is on in development and when explicitly enabled, and off otherwise', () => {
    expect(isDemoToolsEnabled()).toBe(true)
    vi.stubEnv('DEV', false)
    vi.stubEnv('VITE_ENABLE_DEMO_TOOLS', '')
    expect(isDemoToolsEnabled()).toBe(false)
    vi.stubEnv('VITE_ENABLE_DEMO_TOOLS', 'true')
    expect(isDemoToolsEnabled()).toBe(true)
  })

  it('exposes no event-creating method on any service ordinary code can call', async () => {
    const services = await import('@/services')
    const names = [
      'reconciliationService',
      'paymentProfileService',
      'publicPaymentService',
      'notificationService',
      'bankingService',
      'invoiceService',
      'dashboardService',
    ] as const
    for (const name of names) {
      const methods = Object.keys(services[name])
      expect(
        methods.filter((m) =>
          /processEvent|ingest|webhook|confirmPayment|markPaid|simulate/i.test(m),
        ),
      ).toEqual([])
    }
    // The only way in is the demo simulator, which is a separate, optional export.
    expect(Object.keys(services)).not.toContain('bankEventProcessor')
  })
})

describe('responsive structure', () => {
  it('renders a phone list and a desktop table for transactions, so nothing scrolls sideways', async () => {
    await renderAppAt('/transactions')
    const table = await screen.findByRole('table', { name: 'Bank transactions' })
    expect(table.className).toMatch(/\bhidden\b.*lg:table/)
    const phoneList = table.parentElement!.querySelector('ul')!
    expect(phoneList.className).toMatch(/lg:hidden/)
    expect(within(phoneList).getAllByRole('listitem').length).toBe(8)
  })

  it('keeps the public payment page to one narrow column', async () => {
    await renderAppAt('/p/Rk4mQ8vTz2Xn', { signedInAs: null })
    const main = await screen.findByRole('main')
    expect(main.className).toMatch(/max-w-md/)
  })
})
