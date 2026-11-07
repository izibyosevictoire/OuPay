import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import { AppProviders } from '@/app/providers/AppProviders'
import { appRoutes } from '@/app/router/routes'
import { DemoModeBanner } from '@/features/demo/DemoModeBanner'
import { DEMO_EXPERIENCE } from '@/lib/demoExperience'
import '@/styles/globals.css'

const router = createBrowserRouter(appRoutes)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppProviders>
      {DEMO_EXPERIENCE && <DemoModeBanner />}
      <RouterProvider router={router} />
    </AppProviders>
  </StrictMode>,
)
