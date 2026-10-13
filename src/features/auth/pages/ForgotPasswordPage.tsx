import { zodResolver } from '@hookform/resolvers/zod'
import { Loader2, MailCheck } from 'lucide-react'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { Link } from 'react-router-dom'
import { FormField } from '@/components/common/FormField'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { authService } from '@/services'
import { API_MODE } from '@/services/http/apiConfig'
import { DEMO_VALID_RESET_TOKEN } from '@/services/mock/sampleAccounts'
import { forgotPasswordSchema, type ForgotPasswordFormValues } from '../authSchemas'

export function ForgotPasswordPage() {
  const [isSubmitted, setIsSubmitted] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ForgotPasswordFormValues>({
    resolver: zodResolver(forgotPasswordSchema),
    defaultValues: { email: '' },
  })

  const submit = handleSubmit(async ({ email }) => {
    setErrorMessage(null)
    try {
      await authService.requestPasswordReset(email)
      setIsSubmitted(true)
    } catch {
      setErrorMessage('We could not process your request. Please try again.')
    }
  })

  if (isSubmitted) {
    return (
      <Card>
        <CardContent className="space-y-3 p-5 sm:p-6">
          <span className="flex size-10 items-center justify-center rounded-full bg-success-soft text-success">
            <MailCheck className="size-5" aria-hidden="true" />
          </span>
          <h1 className="text-section-title">Check your email</h1>
          {/* Identical wording whether or not an account exists. */}
          <p className="text-sm text-muted-foreground">
            If an account exists for that email address, we have sent instructions to reset the
            password.
          </p>
          {API_MODE !== 'http' && (
            <p className="rounded-md bg-info-soft px-3 py-2 text-xs text-info">
              Demo mode: no email is sent. To try the reset screen, open{' '}
              <Link
                to={`/reset-password/${DEMO_VALID_RESET_TOKEN}`}
                className="font-medium underline"
              >
                the demo reset link
              </Link>
              . Demo links are not secure.
            </p>
          )}
          <Button asChild variant="outline" className="w-full">
            <Link to="/login">Back to sign in</Link>
          </Button>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardContent className="p-5 sm:p-6">
        <h1 className="text-section-title">Forgot your password?</h1>
        <p className="mb-5 mt-1 text-sm text-muted-foreground">
          Enter your email address and we will send reset instructions.
        </p>
        <form noValidate onSubmit={submit} className="space-y-4">
          <FormField label="Email address" required error={errors.email?.message}>
            {(field) => (
              <Input type="email" autoComplete="email" {...field} {...register('email')} />
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
            {isSubmitting ? 'Sending…' : 'Send reset instructions'}
          </Button>
        </form>
        <p className="mt-4 text-center text-sm">
          <Link to="/login" className="rounded-sm font-medium text-primary hover:underline">
            Back to sign in
          </Link>
        </p>
      </CardContent>
    </Card>
  )
}
