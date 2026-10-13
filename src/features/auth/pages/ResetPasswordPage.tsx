import { zodResolver } from '@hookform/resolvers/zod'
import { useQuery } from '@tanstack/react-query'
import { CheckCircle2, Loader2, TimerOff, XCircle } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useForm } from 'react-hook-form'
import { Link, useParams } from 'react-router-dom'
import { FormField } from '@/components/common/FormField'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { PasswordInput } from '@/components/ui/password-input'
import { authService } from '@/services'
import { AuthServiceError } from '@/services/authService'
import { resetPasswordSchema, type ResetPasswordFormValues } from '../authSchemas'

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

export function ResetPasswordPage() {
  const { token = '' } = useParams()
  const [isDone, setIsDone] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const tokenCheck = useQuery({
    queryKey: ['auth', 'reset-token', token],
    // Query functions must not resolve undefined, so map success to true.
    queryFn: () => authService.verifyPasswordResetToken(token).then(() => true),
    retry: false,
    staleTime: Infinity,
  })

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ResetPasswordFormValues>({
    resolver: zodResolver(resetPasswordSchema),
    defaultValues: { newPassword: '', confirmPassword: '' },
  })

  const submit = handleSubmit(async ({ newPassword }) => {
    setErrorMessage(null)
    try {
      await authService.resetPassword({ token, newPassword })
      setIsDone(true)
    } catch (error) {
      setErrorMessage(
        error instanceof AuthServiceError
          ? error.message
          : 'We could not reset your password. Please try again.',
      )
    }
  })

  if (isDone) {
    return (
      <StatusCard
        title="Password updated"
        icon={
          <span className={`${iconClass} bg-success-soft text-success`}>
            <CheckCircle2 className="size-5" aria-hidden="true" />
          </span>
        }
      >
        <p className="text-sm text-muted-foreground">You can now sign in with your new password.</p>
        <Button asChild className="w-full">
          <Link to="/login">Go to sign in</Link>
        </Button>
      </StatusCard>
    )
  }

  if (tokenCheck.isPending) {
    return (
      <Card>
        <CardContent
          role="status"
          className="flex items-center gap-2 p-6 text-sm text-muted-foreground"
        >
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          Checking your reset link…
        </CardContent>
      </Card>
    )
  }

  if (tokenCheck.isError) {
    const isExpired =
      tokenCheck.error instanceof AuthServiceError && tokenCheck.error.code === 'expired_token'
    return (
      <StatusCard
        title={isExpired ? 'This reset link has expired' : 'This reset link is not valid'}
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
          {isExpired
            ? 'Reset links only work for a short time.'
            : 'The link may be mistyped or already used.'}{' '}
          Request a new one to continue.
        </p>
        <Button asChild className="w-full">
          <Link to="/forgot-password">Request a new link</Link>
        </Button>
      </StatusCard>
    )
  }

  return (
    <Card>
      <CardContent className="p-5 sm:p-6">
        <h1 className="text-section-title">Choose a new password</h1>
        <p className="mb-5 mt-1 text-sm text-muted-foreground">
          Use at least 8 characters, with a letter and a number.
        </p>
        <form noValidate onSubmit={submit} className="space-y-4">
          <FormField label="New password" required error={errors.newPassword?.message}>
            {(field) => (
              <PasswordInput autoComplete="new-password" {...field} {...register('newPassword')} />
            )}
          </FormField>
          <FormField label="Confirm new password" required error={errors.confirmPassword?.message}>
            {(field) => (
              <PasswordInput
                autoComplete="new-password"
                {...field}
                {...register('confirmPassword')}
              />
            )}
          </FormField>
          {errorMessage && (
            <p
              role="alert"
              className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger"
            >
              {errorMessage}
            </p>
          )}
          <Button type="submit" className="w-full" disabled={isSubmitting} aria-busy={isSubmitting}>
            {isSubmitting && <Loader2 className="animate-spin" aria-hidden="true" />}
            {isSubmitting ? 'Saving…' : 'Reset password'}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}
