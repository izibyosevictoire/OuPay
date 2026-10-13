import { Link, Outlet } from 'react-router-dom'
import { useAuth } from '@/app/providers/AuthProvider'
import { useBusinessContext } from '@/app/providers/BusinessContextProvider'
import { BrandLogo } from '@/components/layout/BrandLogo'

const linkClassName = 'rounded-sm text-sm font-medium text-primary hover:underline'

/** Requires sign-in but not a business, because onboarding is how a first business is created. */
export function OnboardingLayout() {
  const { logout } = useAuth()
  const { availableMemberships } = useBusinessContext()

  return (
    <div className="min-h-screen">
      <header className="flex h-14 items-center justify-between gap-3 border-b bg-card px-4 sm:px-6">
        <BrandLogo />
        <div className="flex items-center gap-4">
          {availableMemberships.length > 0 && (
            <Link to="/" className={linkClassName}>
              Back to dashboard
            </Link>
          )}
          <button type="button" className={linkClassName} onClick={() => void logout()}>
            Sign out
          </button>
        </div>
      </header>
      <main className="mx-auto w-full max-w-2xl p-4 sm:p-6">
        <Outlet />
      </main>
    </div>
  )
}
