/* eslint-disable react-refresh/only-export-components -- factory is shared with test utilities */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { ToastProvider } from '@/components/common/Toaster'
import { AuthProvider } from './AuthProvider'
import { BusinessContextProvider } from './BusinessContextProvider'

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { staleTime: 60_000, retry: 1, refetchOnWindowFocus: false } },
  })
}

/** Order matters: business context depends on auth, never the reverse. */
export function AppProviders({ children }: { children: ReactNode }) {
  const [queryClient] = useState(createQueryClient)
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <AuthProvider>
          <BusinessContextProvider>{children}</BusinessContextProvider>
        </AuthProvider>
      </ToastProvider>
    </QueryClientProvider>
  )
}
