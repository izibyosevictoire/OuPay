import { zodResolver } from '@hookform/resolvers/zod'
import { Loader2 } from 'lucide-react'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { Link, useLocation } from 'react-router-dom'
import type { LoginRedirectState } from '@/app/router/guards'
import { useAuth } from '@/app/providers/AuthProvider'
import { CheckboxField } from '@/components/common/CheckboxField'
import { FormField } from '@/components/common/FormField'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { PasswordInput } from '@/components/ui/password-input'
import { AuthServiceError } from '@/services/authService'
import { loginSchema, type LoginFormValues } from '../authSchemas'
import { DemoAccountsNotice } from '../components/DemoAccountsNotice'

export function LoginPage() {
  const { login } = useAuth()
  const location = useLocation()
  const redirectState = location.state as LoginRedirectState | null
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '', rememberMe: false },
  })

  const submit = handleSubmit(async ({ email, password, rememberMe }) => {
    setErrorMessage(null)
    try {
      await login({ email, password }, { rememberMe })
      // On success the public-route guard sends the user on to where they were headed.
    } catch (error) {
      setErrorMessage(
        error instanceof AuthServiceError
          ? error.message
          : 'We could not sign you in. Please try again.',
      )
    }
  })

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-5 sm:p-6">
          <h1 className="text-section-title">Sign in</h1>
          <p className="mb-5 mt-1 text-sm text-muted-foreground">Welcome back to OuPay Business.</p>

          {redirectState?.reason === 'expired' && (
            <p
              role="status"
              className="mb-4 rounded-md bg-warning-soft px-3 py-2 text-sm text-warning"
            >
              Your session expired. Please sign in again.
            </p>
          )}

          <form noValidate onSubmit={submit} className="space-y-4">
            <FormField label="Email address" required error={errors.email?.message}>
              {(field) => (
                <Input type="email" autoComplete="username" {...field} {...register('email')} />
              )}
            </FormField>
            <FormField label="Password" required error={errors.password?.message}>
              {(field) => (
                <PasswordInput
                  autoComplete="current-password"
                  {...field}
                  {...register('password')}
                />
              )}
            </FormField>

            <div className="flex flex-wrap items-center justify-between gap-x-4">
              <CheckboxField label="Keep me signed in" {...register('rememberMe')} />
              <Link
                to="/forgot-password"
                className="rounded-sm text-sm font-medium text-primary hover:underline"
              >
                Forgot password?
              </Link>
            </div>

            {errorMessage && (
              <p
                role="alert"
                className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger"
              >
                {errorMessage}
              </p>
            )}

            <Button
              type="submit"
              className="w-full"
              disabled={isSubmitting}
              aria-busy={isSubmitting}
            >
              {isSubmitting && <Loader2 className="animate-spin" aria-hidden="true" />}
              {isSubmitting ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>
        </CardContent>
      </Card>

      <p className="text-center text-sm text-muted-foreground">
        New to OuPay?{' '}
        <Link to="/register" className="rounded-sm font-medium text-primary hover:underline">
          Create an account
        </Link>
      </p>
      <DemoAccountsNotice />
    </div>
  )
}
