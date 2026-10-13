import { screen } from '@testing-library/react'
import { useFastBackend } from '@/test/merchantTestDouble'
import { renderAppAt } from '@/test/renderApp'

describe('dashboard', () => {
  beforeEach(() => {
    useFastBackend()
  })

  it('flags the data as sample data and shows loading placeholders first', async () => {
    await renderAppAt('/')
    expect(screen.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeInTheDocument()
    expect(screen.getByRole('note')).toHaveTextContent('not bank-verified')
    expect(screen.getAllByRole('status').length).toBeGreaterThan(0)
  })

  it('renders key figures in RWF and every payment status with a text label', async () => {
    await renderAppAt('/')
    expect(await screen.findByText('Verified incoming')).toBeInTheDocument()
    expect(screen.getByText('Active cashiers')).toBeInTheDocument()
    expect(screen.getAllByText(/RWF/).length).toBeGreaterThan(0)

    // Recent transactions render both a mobile list and a desktop table; each shows labels.
    for (const label of ['Confirmed', 'Pending', 'Failed', 'Reversed', 'Unmatched']) {
      expect((await screen.findAllByText(label)).length).toBeGreaterThan(0)
    }
    expect(screen.getAllByRole('link', { name: 'Create invoice' }).length).toBeGreaterThan(0)
  })
})
