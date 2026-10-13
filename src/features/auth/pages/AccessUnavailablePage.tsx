import { LockKeyhole } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useAuth } from '@/app/providers/AuthProvider'
import { BrandLogo } from '@/components/layout/BrandLogo'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { MEMBERSHIP_STATUS_LABELS } from '@/constants/auth'

/**
 * Shown to a signed-in user whose memberships are all suspended, revoked or only invited.
 * It is a terminal page (no redirects), so it cannot loop.
 */
export function AccessUnavailablePage() {
  const { user, memberships, logout } = useAuth()
  const statuses = [
    ...new Set(memberships.map((m) => MEMBERSHIP_STATUS_LABELS[m.status].toLowerCase())),
  ]
  const onlyInvitations = memberships.every((membership) => membership.status === 'INVITED')

  return (
    <div className="flex min-h-screen flex-col items-center px-4 py-8 sm:justify-center">
      <div className="mb-6">
        <BrandLogo />
      </div>
      <main className="w-full max-w-md">
        <Card>
          <CardContent className="space-y-3 p-5 text-center sm:p-6">
            <span className="mx-auto flex size-10 items-center justify-center rounded-full bg-warning-soft text-warning">
              <LockKeyhole className="size-5" aria-hidden="true" />
            </span>
            <h1 className="text-section-title">No business access right now</h1>
            <p className="text-sm text-muted-foreground">
              {onlyInvitations
                ? `${user?.fullName ?? 'You'}, you have been invited to a business. Open the invitation link you were sent to accept it. Until then you have no access.`
                : `${user ? `${user.fullName}, your` : 'Your'} access to your business is ${statuses.join(' or ')}. Contact the business owner or OuPay support to restore it.`}{' '}
              You can also register a different business of your own.
            </p>
            <div className="flex flex-col gap-2 pt-2">
              <Button asChild>
                <Link to="/onboarding">Register a business</Link>
              </Button>
              <Button variant="outline" onClick={() => void logout()}>
                Sign out
              </Button>
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  )
}
