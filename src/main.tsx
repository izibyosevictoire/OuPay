import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import { AppProviders } from '@/app/providers/AppProviders'
import { appRoutes } from '@/app/router/routes'
import '@/styles/globals.css'

const router = createBrowserRouter(appRoutes)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppProviders>
      <RouterProvider router={router} />
    </AppProviders>
  </StrictMode>,
)
