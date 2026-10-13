import { zodResolver } from '@hookform/resolvers/zod'
import { Loader2 } from 'lucide-react'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { Link } from 'react-router-dom'
import { useAuth } from '@/app/providers/AuthProvider'
import { CheckboxField } from '@/components/common/CheckboxField'
import { FormField } from '@/components/common/FormField'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { PasswordInput } from '@/components/ui/password-input'
import { AuthServiceError } from '@/services/authService'
import { normalizeRwandanPhoneNumber } from '@/features/merchants/merchantSchemas'
import { registerSchema, type RegisterFormValues } from '../authSchemas'

export function RegisterPage() {
  const { register: registerAccount } = useAuth()
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<RegisterFormValues>({
    resolver: zodResolver(registerSchema),
    defaultValues: {
      fullName: '',
      email: '',
      phoneNumber: '',
      password: '',
      confirmPassword: '',
      acceptedTerms: false,
    },
  })

  const submit = handleSubmit(async (values) => {
    setErrorMessage(null)
    try {
      await registerAccount({
        fullName: values.fullName,
        email: values.email,
        phoneNumber: normalizeRwandanPhoneNumber(values.phoneNumber),
        password: values.password,
      })
      // New users have no business yet, so the route guards continue to onboarding.
    } catch (error) {
      if (error instanceof AuthServiceError && error.code === 'email_taken') {
        setError('email', { message: error.message }, { shouldFocus: true })
      } else {
        setErrorMessage(
          error instanceof AuthServiceError
            ? error.message
            : 'We could not create your account. Please try again.',
        )
      }
    }
  })

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-5 sm:p-6">
          <h1 className="text-section-title">Create your account</h1>
          <p className="mb-5 mt-1 text-sm text-muted-foreground">
            Then register your business in a few steps.
          </p>

          <form noValidate onSubmit={submit} className="space-y-4">
            <FormField label="Full name" required error={errors.fullName?.message}>
              {(field) => <Input autoComplete="name" {...field} {...register('fullName')} />}
            </FormField>
            <FormField label="Email address" required error={errors.email?.message}>
              {(field) => (
                <Input type="email" autoComplete="email" {...field} {...register('email')} />
              )}
            </FormField>
            <FormField
              label="Phone number"
              required
              hint="Rwandan mobile number, e.g. 0788 123 456."
              error={errors.phoneNumber?.message}
            >
              {(field) => (
                <Input
                  type="tel"
                  autoComplete="tel"
                  inputMode="tel"
                  {...field}
                  {...register('phoneNumber')}
                />
              )}
            </FormField>
            <FormField
              label="Password"
              required
              hint="At least 8 characters, with a letter and a number."
              error={errors.password?.message}
            >
              {(field) => (
                <PasswordInput autoComplete="new-password" {...field} {...register('password')} />
              )}
            </FormField>
            <FormField label="Confirm password" required error={errors.confirmPassword?.message}>
              {(field) => (
                <PasswordInput
                  autoComplete="new-password"
                  {...field}
                  {...register('confirmPassword')}
                />
              )}
            </FormField>
            <CheckboxField
              label="I agree to the OuPay terms of use and privacy notice."
              error={errors.acceptedTerms?.message}
              {...register('acceptedTerms')}
            />

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
              {isSubmitting ? 'Creating account…' : 'Create account'}
            </Button>
          </form>
        </CardContent>
      </Card>
      <p className="text-center text-sm text-muted-foreground">
        Already have an account?{' '}
        <Link to="/login" className="rounded-sm font-medium text-primary hover:underline">
          Sign in
        </Link>
      </p>
    </div>
  )
}
