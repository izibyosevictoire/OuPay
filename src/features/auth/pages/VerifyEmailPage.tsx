import { useQuery } from '@tanstack/react-query'
import { CheckCircle2, Loader2, TimerOff, XCircle } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { authService } from '@/services'
import { AuthServiceError } from '@/services/authService'

function StatusCard({
  icon,
  title,
  children,
}: {
  icon: ReactNode
  title: string
  children: ReactNode
}) {
  return (
    <Card>
      <CardContent className="space-y-3 p-5 sm:p-6">
        {icon}
        <h1 className="text-section-title">{title}</h1>
        {children}
      </CardContent>
    </Card>
  )
}

const iconClass = 'flex size-10 items-center justify-center rounded-full'

/**
 * The page behind the link in the "confirm your email address" message. The link works once, so the
 * confirmation runs a single time (no retries, never re-run by a refetch).
 */
export function VerifyEmailPage() {
  const { token = '' } = useParams()

  const confirmation = useQuery({
    queryKey: ['auth', 'verify-email', token],
    queryFn: () => authService.confirmEmailVerification(token).then(() => true),
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })

  if (confirmation.isPending) {
    return (
      <Card>
        <CardContent
          role="status"
          className="flex items-center gap-2 p-6 text-sm text-muted-foreground"
        >
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          Confirming your email address…
        </CardContent>
      </Card>
    )
  }

  if (confirmation.isError) {
    const isExpired =
      confirmation.error instanceof AuthServiceError && confirmation.error.code === 'expired_token'
    return (
      <StatusCard
        title={isExpired ? 'This link has expired' : 'This link is not valid'}
        icon={
          <span className={`${iconClass} bg-danger-soft text-danger`}>
            {isExpired ? (
              <TimerOff className="size-5" aria-hidden="true" />
            ) : (
              <XCircle className="size-5" aria-hidden="true" />
            )}
          </span>
        }
      >
        <p className="text-sm text-muted-foreground">
          The link may have expired, been mistyped or already been used. Sign in and request a new
          confirmation email.
        </p>
        <Button asChild className="w-full">
          <Link to="/login">Go to sign in</Link>
        </Button>
      </StatusCard>
    )
  }

  return (
    <StatusCard
      title="Email address confirmed"
      icon={
        <span className={`${iconClass} bg-success-soft text-success`}>
          <CheckCircle2 className="size-5" aria-hidden="true" />
        </span>
      }
    >
      <p className="text-sm text-muted-foreground">Thank you. Your email address is confirmed.</p>
      <Button asChild className="w-full">
        <Link to="/">Continue</Link>
      </Button>
    </StatusCard>
  )
}
