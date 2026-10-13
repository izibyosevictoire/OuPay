import { Outlet } from 'react-router-dom'
import { BrandLogo } from '@/components/layout/BrandLogo'

/** Shared frame for sign-in, registration and password screens. */
export function AuthLayout() {
  return (
    <div className="flex min-h-screen flex-col items-center px-4 py-8 sm:justify-center sm:py-12">
      <div className="mb-6">
        <BrandLogo />
      </div>
      <main className="w-full max-w-md">
        <Outlet />
      </main>
    </div>
  )
}
