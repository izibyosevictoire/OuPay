import { render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { AppProviders } from '@/app/providers/AppProviders'
import { appRoutes } from '@/app/router/routes'
import { getActiveTestBackend, type DemoUserKey } from './merchantTestDouble'

interface RenderAppOptions {
  /** Demo user to start signed in as; null renders signed out. Defaults to the owner. */
  signedInAs?: DemoUserKey | null
}

/** Renders the whole app (providers + routes) and waits for the session check to finish. */
export async function renderAppAt(path: string, { signedInAs = 'owner' }: RenderAppOptions = {}) {
  if (signedInAs) getActiveTestBackend().signInAs(signedInAs)
  const router = createMemoryRouter(appRoutes, { initialEntries: [path] })
  const result = render(
    <AppProviders>
      <RouterProvider router={router} />
    </AppProviders>,
  )
  await waitFor(() => expect(screen.queryByText('Checking your session…')).not.toBeInTheDocument())
  return { ...result, router }
}
