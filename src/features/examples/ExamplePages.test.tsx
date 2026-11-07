import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// Aliased: it installs a fresh in-memory backend (it is not a React hook), so it may be called again inside a loop.
import { useFastBackend as freshBackend } from '@/test/merchantTestDouble'
import { renderAppAt } from '@/test/renderApp'

/**
 * The examples inside the REAL pages, signed in to the ordinary application (here the sample "Sample Shop" and "Sample Corner Cafe" stand for two
 * different real businesses). The examples must be there for everyone, be recognisably not the business's own data, and change nothing real.
 */
const PAGES = [
  ['/', 'dashboard'],
  ['/branches', 'branches'],
  ['/cashiers', 'staff'],
  ['/catalog', 'catalog'],
  ['/inventory', 'inventory'],
  ['/pos', 'pos'],
  ['/payments', 'payments'],
  ['/invoices', 'invoices'],
  ['/entry-devices', 'paymentPoints'],
  ['/reports', 'reports'],
] as const

beforeEach(() => {
  freshBackend()
})
afterEach(() => {
  vi.restoreAllMocks()
})

const sectionFor = async (topic: string) => {
  await waitFor(() => expect(document.querySelector(`[data-example-data="${topic}"]`)).not.toBeNull(), { timeout: 8_000 })
  return document.querySelector(`[data-example-data="${topic}"]`) as HTMLElement
}

/** The real page: everything in <main> except the example sections. */
const realTextOf = () => {
  const copy = document.querySelector('main')!.cloneNode(true) as HTMLElement
  copy.querySelectorAll('[data-example-data]').forEach((node) => node.remove())
  return copy.textContent ?? ''
}

const openIt = async (section: HTMLElement) => {
  const user = userEvent.setup()
  await user.click(within(section).getByRole('button', { name: /EXAMPLE DATA/ }))
  return section
}

describe('every page of the ordinary application has its example section', () => {
  it.each(PAGES)('%s shows a labelled, closed EXAMPLE DATA section below the real content', async (route, topic) => {
    await renderAppAt(route)
    const section = await sectionFor(topic)
    expect(within(section).getByRole('button', { name: /EXAMPLE DATA/ })).toHaveAttribute('aria-expanded', 'false')
    // It is the last thing on the page: the real content comes first.
    const main = document.querySelector('main')!
    expect(main.lastElementChild === section || main.lastElementChild!.contains(section)).toBe(true)
  })

  it.each(['owner', 'manager', 'cafeOwner'] as const)('is available to a signed-in %s, whichever business they belong to', async (who) => {
    await renderAppAt('/branches', { signedInAs: who })
    const section = await openIt(await sectionFor('branches'))
    expect(within(section).getByText('Kigali Main')).toBeInTheDocument()
    expect(within(section).getByText('Remera')).toBeInTheDocument()
  })

  it('is available to a cashier on the pages a cashier can open', async () => {
    await renderAppAt('/pos', { signedInAs: 'cashier' })
    const section = await openIt(await sectionFor('pos'))
    expect(within(section).getByText(/Weekly groceries|Rice 2 kg/)).toBeInTheDocument()
  })
})

describe('examples never leak or replace the real business', () => {
  it('shows exactly the same example text to different businesses, and none of either business’s own details', async () => {
    const texts: string[] = []
    for (const who of ['owner', 'cafeOwner'] as const) {
      const view = await renderAppAt('/branches', { signedInAs: who })
      const section = await openIt(await sectionFor('branches'))
      texts.push(section.textContent!)
      view.unmount()
      freshBackend()
    }
    expect(texts[0]).toBe(texts[1])
    expect(texts[0]).not.toMatch(/Sample Shop|Sample Corner Cafe|Sample Business|Remera Main|Cafe Nyamirambo|mrc-sample|owner@|usr-/)
  })

  it('keeps real and example records in separate places: the real branch table is untouched when the examples are opened', async () => {
    await renderAppAt('/branches')
    await screen.findAllByText('Remera Main')
    const realTable = screen.getAllByRole('table')[0]!
    const before = realTable.textContent
    const rowsBefore = within(realTable).getAllByRole('row').length
    const section = await openIt(await sectionFor('branches'))

    expect(realTable.textContent).toBe(before)
    expect(within(realTable).getAllByRole('row')).toHaveLength(rowsBefore)
    expect(realTable.closest('[data-example-data]')).toBeNull()
    expect(within(realTable).queryByText('Kigali Main')).not.toBeInTheDocument()
    // The real records appear nowhere inside the examples.
    expect(within(section).queryByText('Remera Main')).not.toBeInTheDocument()
    expect(section).toHaveTextContent('EXAMPLE DATA')
  })

  it('leaves the real dashboard totals exactly as they were, and the example totals only inside the labelled section', async () => {
    await renderAppAt('/')
    await screen.findByText('Recent transactions')
    await screen.findAllByText('Confirmed')
    const before = realTextOf()
    expect(before).toContain('Verified incoming')
    const section = await openIt(await sectionFor('dashboard'))
    expect(section).toHaveTextContent('RWF 356,120')
    // Everything outside the examples is character-for-character the same, and the example money is nowhere in it.
    expect(realTextOf()).toBe(before)
    expect(realTextOf()).not.toContain('356,120')
  })

  it('leaves the real invoice list and its totals alone', async () => {
    await renderAppAt('/invoices')
    await waitFor(() => expect(screen.getAllByRole('table').length).toBeGreaterThan(0))
    const before = realTextOf()
    expect(before).not.toContain('KDS-INV')
    const section = await openIt(await sectionFor('invoices'))
    expect(section).toHaveTextContent('KDS-INV-2001')
    expect(realTextOf()).toBe(before)
  })

  it('leaves the real payments and report pages alone', async () => {
    for (const [route, topic] of [['/payments', 'payments'], ['/reports', 'reports']] as const) {
      const view = await renderAppAt(route)
      await waitFor(() => expect(realTextOf().length).toBeGreaterThan(50))
      const before = realTextOf()
      await openIt(await sectionFor(topic))
      expect(realTextOf()).toBe(before)
      view.unmount()
      freshBackend()
    }
  })
})

describe('examples can not be acted on from the real pages', () => {
  it.each(PAGES)('%s: nothing inside the open example is a button, link or input for a record', async (route, topic) => {
    await renderAppAt(route)
    const section = await openIt(await sectionFor(topic))
    expect(within(section).getAllByRole('button')).toHaveLength(1)
    expect(section.querySelector('a, input, select, textarea, form')).toBeNull()
  })
})
