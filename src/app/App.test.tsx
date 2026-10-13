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

  it('shows a placeholder page for modules that are not built yet', async () => {
    await renderAppAt('/reports')
    expect(screen.getByRole('heading', { level: 1, name: 'Reports' })).toBeInTheDocument()
    expect(screen.getByText('Reports is coming soon')).toBeInTheDocument()
  })

  it('shows a not-found page for unknown addresses', async () => {
    await renderAppAt('/nothing-here')
    expect(screen.getByRole('heading', { level: 1, name: 'Page not found' })).toBeInTheDocument()
  })
})
