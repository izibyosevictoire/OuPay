import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatRwf } from '@/lib/format'
import { findAccessibilityViolations } from '@/test/axe'
import { ExampleData } from './ExampleData'
import { exampleView, type ExampleTopic } from './exampleViews'

const TOPICS: ExampleTopic[] = ['dashboard', 'branches', 'staff', 'catalog', 'inventory', 'pos', 'payments', 'invoices', 'paymentPoints', 'reports']

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('what the examples show (the Kigali Demo Supermarket fixtures, nothing else)', () => {
  const rows = (topic: ExampleTopic) => exampleView(topic).tables.flatMap((t) => t.rows)

  it('has an example for every page', () => {
    for (const topic of TOPICS) {
      const view = exampleView(topic)
      expect(view.summary.length, topic).toBeGreaterThan(10)
      expect(view.stats.length + view.tables.length, topic).toBeGreaterThan(0)
    }
  })

  it('matches the R9c example business: three branches, three people, twelve catalog entries, two carts, four invoices, six simulated payments, three payment points', () => {
    expect(rows('branches')).toHaveLength(3)
    expect(rows('staff')).toHaveLength(3)
    expect(rows('catalog')).toHaveLength(12)
    expect(rows('pos')).toHaveLength(2)
    expect(rows('invoices')).toHaveLength(4)
    expect(rows('payments')).toHaveLength(6)
    expect(rows('paymentPoints')).toHaveLength(3)
    expect(rows('inventory').length).toBeGreaterThanOrEqual(20)
    const kinds = rows('paymentPoints').map((r) => r.cells.type)
    expect(kinds.filter((k) => k === 'Static QR code')).toHaveLength(2)
    expect(kinds.filter((k) => k === 'NFC bracelet')).toHaveLength(1)
  })

  it('shows dashboard and report figures that are the example ledger’s, and agree with each other', () => {
    const dashboard = Object.fromEntries(exampleView('dashboard').stats.map((s) => [s.label, s.value]))
    expect(dashboard['Verified incoming']).toBe(formatRwf(356_120))
    expect(dashboard['Applied to invoices']).toBe(formatRwf(295_520))
    expect(dashboard['Unmatched collections']).toBe(formatRwf(60_600))
    expect(dashboard['Outstanding balances']).toBe(formatRwf(242_000))
    const report = Object.fromEntries(exampleView('reports').stats.map((s) => [s.label, s.value]))
    expect(report['Confirmed incoming']).toBe(dashboard['Verified incoming'])
    expect(report.Outstanding).toBe(dashboard['Outstanding balances'])
  })

  it('never puts a QR link, an NFC token, a bank account or a record identifier on the screen', async () => {
    const user = userEvent.setup()
    for (const topic of TOPICS) {
      const { container, unmount } = render(<ExampleData topic={topic} />)
      await user.click(screen.getByRole('button', { name: /EXAMPLE DATA/ }))
      expect(container.innerHTML, topic).not.toMatch(/\/e\/|KdDemo|\u2022\u2022\u2022\u2022|bacc-|dst-|kd-[a-z]|inv-kds/i)
      unmount()
    }
  })
})

describe('the example section', () => {
  it('is closed at first, labelled EXAMPLE DATA, and opens to a clear "not your data" notice', async () => {
    const user = userEvent.setup()
    render(<ExampleData topic="branches" />)
    const section = screen.getByRole('region', { name: /EXAMPLE DATA/ })
    const toggle = within(section).getByRole('button', { name: /EXAMPLE DATA/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(within(section).queryByRole('table')).not.toBeInTheDocument()

    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(within(section).getByRole('note')).toHaveTextContent(/EXAMPLE DATA\.\s*Kigali Demo Supermarket is a made-up shop/)
    expect(within(section).getByRole('note')).toHaveTextContent(/not yours/)
    expect(within(section).getByRole('note')).toHaveTextContent(/not counted in any of your totals/)
    expect(within(section).getByRole('table', { name: /Example branches/ })).toBeInTheDocument()
    expect(within(section).getByText('Kigali Main')).toBeInTheDocument()
  })

  it.each(TOPICS)('is read-only on the %s page: only the open/close control, no link, form or input, whatever is open', async (topic) => {
    const user = userEvent.setup()
    render(<ExampleData topic={topic} />)
    await user.click(screen.getByRole('button', { name: /EXAMPLE DATA/ }))
    const section = screen.getByRole('region', { name: /EXAMPLE DATA/ })
    expect(within(section).getAllByRole('button')).toHaveLength(1)
    expect(within(section).queryByRole('link')).not.toBeInTheDocument()
    expect(section.querySelector('input, select, textarea, form, a[href]')).toBeNull()
    // Payments are always marked simulated.
    if (topic === 'payments' || topic === 'dashboard') expect(within(section).getAllByText('Simulated').length).toBeGreaterThan(0)
  })

  it('needs nothing from the application: no providers, no signed-in business, no service', () => {
    // Rendered bare, with no router, query client or auth, and it still works: it reads nothing that belongs to a business.
    expect(() => render(<ExampleData topic="inventory" />)).not.toThrow()
    expect(ExampleData.length).toBe(1)
  })

  it('has no accessibility violations, closed or open', async () => {
    const user = userEvent.setup()
    const { container } = render(<ExampleData topic="payments" />)
    expect(await findAccessibilityViolations(container)).toEqual([])
    await user.click(screen.getByRole('button', { name: /EXAMPLE DATA/ }))
    expect(await findAccessibilityViolations(container)).toEqual([])
  })

  it('is laid out for a phone: each row becomes a labelled card, and the touch target is large', async () => {
    const user = userEvent.setup()
    render(<ExampleData topic="catalog" />)
    const toggle = screen.getByRole('button', { name: /EXAMPLE DATA/ })
    expect(toggle.className).toContain('min-h-12')
    await user.click(toggle)
    const table = screen.getByRole('table')
    // Below `sm` the table is block-level (no sideways scrolling); from `sm` it is a real table.
    expect(table.className).toContain('block')
    expect(table.className).toContain('sm:table')
    const cells = within(table).getAllByRole('cell')
    // Every cell carries its column name, which the phone layout prints before the value.
    expect(cells.every((c) => c.getAttribute('data-label'))).toBe(true)
    expect(cells[0]!.className).toContain('before:content-[attr(data-label)]')
    expect(cells[0]!.className).toContain('sm:table-cell')
    // Headers stay available to screen readers on a phone.
    expect(table.querySelector('thead')!.className).toContain('sr-only')
  })

  it('is absent from the separate demo build, which is already a demonstration', async () => {
    vi.stubEnv('VITE_API_MODE', 'mock')
    vi.stubEnv('VITE_DEMO_EXPERIENCE', 'true')
    vi.resetModules()
    const { ExampleData: DemoBuildExampleData } = await import('./ExampleData')
    const { container } = render(<DemoBuildExampleData topic="branches" />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('the examples are static: they import nothing that could touch real data or money', () => {
  const dir = path.resolve(import.meta.dirname)
  const sources = readdirSync(dir).filter((f) => /\.(ts|tsx)$/.test(f) && !f.includes('.test.')).map((f) => [f, readFileSync(path.join(dir, f), 'utf8')] as const)

  it('imports no service, no query, no storage and no mock logic: only fixtures, formatting and shared UI', () => {
    expect(sources.length).toBeGreaterThanOrEqual(2)
    for (const [file, text] of sources) {
      const imports = [...text.matchAll(/from '([^']+)'/g)].map((m) => m[1]!)
      for (const spec of imports) {
        expect(spec, `${file} imports ${spec}`).not.toMatch(/^@\/services$|^@\/services\/(http|index|[a-z]+Service)|react-query|^@\/app\/providers|\/mock\/(mock|ledger|seeds|demoData|sample)/)
        // The only mock-folder code allowed is the plain-data fixtures.
        if (spec.startsWith('@/services/mock/')) expect(spec, file).toMatch(/^@\/services\/mock\/kigaliDemo\//)
      }
      expect(text, file).not.toMatch(/localStorage|sessionStorage|fetch\(|XMLHttpRequest|useQuery|useMutation|useBusiness|useAuth|useCurrentMerchant/)
    }
  })

  it('has no way to act on a record: no mutation handler, no navigation to a record', () => {
    for (const [file, text] of sources) {
      expect(text, file).not.toMatch(/onSubmit|<form|<Link|<a |href=|navigate\(|\.post\(|\.put\(|\.delete\(/)
    }
  })
})
