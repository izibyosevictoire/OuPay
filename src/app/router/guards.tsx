import { Loader2 } from 'lucide-react'
import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { ErrorState } from '@/components/common/ErrorState'
import { AccessUnavailablePage } from '@/features/auth/pages/AccessUnavailablePage'
import { ForbiddenPage } from '@/features/auth/pages/ForbiddenPage'
import type { Permission } from '@/features/auth/permissions/permissionDefinitions'
import { usePermission } from '@/features/auth/permissions/usePermission'
import { useAuth } from '../providers/AuthProvider'
import { useBusinessContext } from '../providers/BusinessContextProvider'

export interface LoginRedirectState {
  from?: string
  reason?: 'expired'
}

function FullPageLoading() {
  return (
    <div
      role="status"
      className="flex min-h-screen items-center justify-center gap-2 text-sm text-muted-foreground"
    >
      <Loader2 className="size-5 animate-spin" aria-hidden="true" />
      Checking your session…
    </div>
  )
}

/**
 * Requires a signed-in user. Redirects to /login (remembering where they were going),
 * and shows a retryable error if the session check itself failed.
 */
export function ProtectedRoute() {
  const { status, retrySessionCheck, didSignOutOnPurpose } = useAuth()
  const location = useLocation()

  if (status === 'loading') return <FullPageLoading />
  if (status === 'error') {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <ErrorState message="We could not check your session." onRetry={retrySessionCheck} />
      </div>
    )
  }
  if (status === 'unauthenticated' || status === 'expired') {
    const state: LoginRedirectState = {
      // After a deliberate sign-out there is nothing to resume for whoever signs in next.
      from: didSignOutOnPurpose ? undefined : `${location.pathname}${location.search}`,
      reason: status === 'expired' ? 'expired' : undefined,
    }
    return <Navigate to="/login" replace state={state} />
  }
  return <Outlet />
}

/** Sign-in and registration pages: signed-in users are sent on to where they were going. */
export function PublicOnlyRoute() {
  const { status } = useAuth()
  const location = useLocation()

  if (status === 'loading') return <FullPageLoading />
  if (status === 'authenticated') {
    const from = (location.state as LoginRedirectState | null)?.from
    return <Navigate to={from && !from.startsWith('/login') ? from : '/'} replace />
  }
  return <Outlet />
}

/**
 * Business-scoped pages. Users with no memberships go to onboarding; users whose memberships
 * are all suspended, revoked or only invited see an explanation instead of a redirect, which
 * avoids bouncing between pages. Pending-verification businesses stay accessible.
 */
export function BusinessRoute() {
  const { memberships } = useAuth()
  const { availableMemberships } = useBusinessContext()

  if (memberships.length === 0) return <Navigate to="/onboarding" replace />
  if (availableMemberships.length === 0) return <AccessUnavailablePage />
  return <Outlet />
}

/** Page-level permission check. Renders a 403 in place rather than redirecting. */
export function PermissionRoute({ permission }: { permission: Permission }) {
  const { isAllowed } = usePermission(permission)
  return isAllowed ? <Outlet /> : <ForbiddenPage />
}
