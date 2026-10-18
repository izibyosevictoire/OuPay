import { screen, within } from '@testing-library/react'
import { PRIMARY_NAVIGATION } from '@/constants/navigation'
import { useFastBackend } from '@/test/merchantTestDouble'
import { renderAppAt } from '@/test/renderApp'

describe('application shell', () => {
  beforeEach(() => {
    useFastBackend()
  })

  it('lists every primary navigation destination for an owner', async () => {
    await renderAppAt('/')
    const navigation = screen.getAllByRole('navigation', { name: 'Primary' })[0]!
    for (const { label } of PRIMARY_NAVIGATION) {
      expect(within(navigation).getByRole('link', { name: label })).toBeInTheDocument()
    }
  })

  it('shows the Reports page without presenting mock financial figures', async () => {
    await renderAppAt('/reports')
    expect(screen.getByRole('heading', { level: 1, name: 'Reports' })).toBeInTheDocument()
    expect(screen.getByText(/Demo mode does not display financial reports/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeDisabled()
  })

  it('shows a not-found page for unknown addresses', async () => {
    await renderAppAt('/nothing-here')
    expect(screen.getByRole('heading', { level: 1, name: 'Page not found' })).toBeInTheDocument()
  })
})
