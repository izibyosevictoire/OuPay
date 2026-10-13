import { zodResolver } from '@hookform/resolvers/zod'
import { useQuery } from '@tanstack/react-query'
import { Loader2, MailX } from 'lucide-react'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '@/app/providers/AuthProvider'
import { useBusinessContext } from '@/app/providers/BusinessContextProvider'
import { CheckboxField } from '@/components/common/CheckboxField'
import { FormField } from '@/components/common/FormField'
import { useToast } from '@/components/common/Toaster'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { PasswordInput } from '@/components/ui/password-input'
import { BUSINESS_ROLE_LABELS } from '@/constants/auth'
import { registerSchema } from '@/features/auth/authSchemas'
import { normalizeRwandanPhoneNumber } from '@/features/merchants/merchantSchemas'
import { staffService } from '@/services'
import { AuthServiceError } from '@/services/authService'
import { API_MODE } from '@/services/http/apiConfig'
import { OrganizationServiceError } from '@/services/organizationService'
import type { InvitationPreview } from '@/types/staff'
import { z } from 'zod'

// The email comes from the invitation, so the form only collects the rest.
const newAccountSchema = registerSchema.safeExtend({ email: z.string() })
type NewAccountValues = z.infer<typeof newAccountSchema>

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="space-y-3 p-5 sm:p-6">
        <span className="flex size-10 items-center justify-center rounded-full bg-danger-soft text-danger">
          <MailX className="size-5" aria-hidden="true" />
        </span>
        <h1 className="text-section-title">{title}</h1>
        {children}
      </CardContent>
    </Card>
  )
}

/**
 * DEMO acceptance flow. A real product would email a single-use expiring link. Existing
 * users sign in and the invitation links to their User; new emails create their account
 * here, which turns the placeholder user from "pending" into an active account.
 */
export function AcceptInvitationPage() {
  const { token = '' } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const { notify } = useToast()
  const { status, user, register: registerAccount, logout, refreshSession } = useAuth()
  const { selectMerchant } = useBusinessContext()
  const [isWorking, setIsWorking] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const previewQuery = useQuery({
    queryKey: ['invitations', 'preview', token],
    queryFn: () => staffService.getInvitationPreview(token),
    retry: false,
    staleTime: 0,
  })

  const accountForm = useForm<NewAccountValues>({
    resolver: zodResolver(newAccountSchema),
    defaultValues: {
      fullName: '',
      email: '',
      phoneNumber: '',
      password: '',
      confirmPassword: '',
      acceptedTerms: false,
    },
  })

  const accept = async (preview: InvitationPreview) => {
    const membership = await staffService.acceptInvitation(token)
    await refreshSession()
    selectMerchant(membership.merchantId)
    notify('success', `You joined ${preview.businessName}.`)
    navigate('/', { replace: true })
  }

  const runAccept = async (preview: InvitationPreview, beforeAccept?: () => Promise<void>) => {
    if (isWorking) return
    setIsWorking(true)
    setErrorMessage(null)
    try {
      await beforeAccept?.()
      if (beforeAccept && API_MODE === 'http') {
        // Server mode: registering through the link already activated the membership in the same step, and the
        // link is single-use, so accepting again would be refused. Just load the new session and go in.
        await refreshSession()
        notify('success', `You joined ${preview.businessName}.`)
        navigate('/', { replace: true })
      } else {
        await accept(preview)
      }
    } catch (error) {
      setErrorMessage(
        error instanceof OrganizationServiceError || error instanceof AuthServiceError
          ? error.message
          : 'Something went wrong. Please try again.',
      )
      setIsWorking(false)
    }
  }

  if (previewQuery.isPending || status === 'loading') {
    return (
      <Card>
        <CardContent
          role="status"
          className="flex items-center gap-2 p-6 text-sm text-muted-foreground"
        >
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          Checking your invitation…
        </CardContent>
      </Card>
    )
  }

  if (previewQuery.isError) {
    return (
      <Notice title="This invitation is not valid">
        <p className="text-sm text-muted-foreground">
          The link may be mistyped. Ask the business to send a new invitation.
        </p>
        <Button asChild variant="outline" className="w-full">
          <Link to="/login">Go to sign in</Link>
        </Button>
      </Notice>
    )
  }

  const preview = previewQuery.data
  if (preview.status !== 'PENDING') {
    return (
      <Notice
        title={
          preview.status === 'ACCEPTED'
            ? 'Invitation already accepted'
            : preview.status === 'EXPIRED'
              ? 'Invitation expired'
              : 'Invitation cancelled'
        }
      >
        <p className="text-sm text-muted-foreground">
          {preview.status === 'ACCEPTED'
            ? 'This invitation was already used. Sign in to open the business.'
            : preview.status === 'EXPIRED'
              ? 'This invitation has expired. Ask the business to send a new one.'
              : 'The business cancelled this invitation. Ask them to send a new one.'}
        </p>
        <Button asChild variant="outline" className="w-full">
          <Link to="/login">Go to sign in</Link>
        </Button>
      </Notice>
    )
  }

  const summary = (
    <p className="mb-5 mt-1 text-sm text-muted-foreground">
      You are invited to join <strong className="text-foreground">{preview.businessName}</strong> as{' '}
      {BUSINESS_ROLE_LABELS[preview.role].toLowerCase()}.
    </p>
  )
  const errorBox = errorMessage && (
    <p
      role="alert"
      className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger"
    >
      {errorMessage}
    </p>
  )
  const demoNote =
    API_MODE === 'http' ? null : (
      <p className="mt-4 rounded-md bg-info-soft px-3 py-2 text-xs text-info">
        Demo mode: invitations are simulated and demo links are not secure.
      </p>
    )

  // Signed in as the invited person: one click to accept.
  if (status === 'authenticated' && user?.email.toLowerCase() === preview.email) {
    return (
      <Card>
        <CardContent className="space-y-4 p-5 sm:p-6">
          <h1 className="text-section-title">Join {preview.businessName}</h1>
          {summary}
          {errorBox}
          <Button
            className="w-full"
            disabled={isWorking}
            aria-busy={isWorking}
            onClick={() => void runAccept(preview)}
          >
            {isWorking && <Loader2 className="animate-spin" aria-hidden="true" />}
            Accept invitation
          </Button>
          {demoNote}
        </CardContent>
      </Card>
    )
  }

  // Signed in as someone else: the invitation is tied to an email address.
  if (status === 'authenticated' && user) {
    return (
      <Notice title="This invitation is for a different account">
        <p className="text-sm text-muted-foreground">
          You are signed in as {user.email}, but this invitation was sent to another email address.
          Sign out and use the invited account.
        </p>
        <Button variant="outline" className="w-full" onClick={() => void logout()}>
          Sign out
        </Button>
      </Notice>
    )
  }

  // Signed out, and the invited email already has an account: sign in, then come back.
  if (preview.inviteeHasActiveAccount) {
    return (
      <Card>
        <CardContent className="space-y-4 p-5 sm:p-6">
          <h1 className="text-section-title">Join {preview.businessName}</h1>
          {summary}
          <Button asChild className="w-full">
            <Link to="/login" state={{ from: location.pathname }}>
              Sign in to accept
            </Link>
          </Button>
          {demoNote}
        </CardContent>
      </Card>
    )
  }

  // Signed out, brand-new email: create the account, then accept.
  const createAccountAndAccept = accountForm.handleSubmit((values) =>
    runAccept(preview, () =>
      registerAccount({
        fullName: values.fullName,
        email: preview.email,
        phoneNumber: normalizeRwandanPhoneNumber(values.phoneNumber),
        password: values.password,
        invitationToken: token,
      }),
    ),
  )
  const {
    register,
    formState: { errors },
  } = accountForm

  return (
    <Card>
      <CardContent className="p-5 sm:p-6">
        <h1 className="text-section-title">Join {preview.businessName}</h1>
        {summary}
        <form noValidate onSubmit={createAccountAndAccept} className="space-y-4">
          <FormField label="Email address">
            {(field) => <Input {...field} value={preview.email} readOnly aria-readonly="true" />}
          </FormField>
          <FormField label="Full name" required error={errors.fullName?.message}>
            {(field) => <Input autoComplete="name" {...field} {...register('fullName')} />}
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
          {errorBox}
          <Button type="submit" className="w-full" disabled={isWorking} aria-busy={isWorking}>
            {isWorking && <Loader2 className="animate-spin" aria-hidden="true" />}
            {isWorking ? 'Joining…' : 'Create account and join'}
          </Button>
        </form>
        {demoNote}
      </CardContent>
    </Card>
  )
}
