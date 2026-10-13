import { BadgeCheck, Loader2, ShieldAlert } from 'lucide-react'
import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { FormField } from '@/components/common/FormField'
import { QueryBoundary } from '@/components/common/QueryBoundary'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import {
  MAXIMUM_OPEN_PAYMENT_AMOUNT,
  MINIMUM_OPEN_PAYMENT_AMOUNT,
} from '@/constants/paymentMethods'
import { formatRwf } from '@/lib/format'
import { buildLocalRequestPath } from '@/lib/paymentLinks'
import { PaymentServiceError } from '@/services/paymentServiceError'
import type { PublicProfileView } from '@/types/paymentProfile'
import { useCreateOpenRequest, usePublicProfile } from './publicPaymentQueries'

export function UnavailablePayment({ title, message }: { title: string; message: string }) {
  return (
    <Card role="alert" className="space-y-2 p-6 text-center">
      <span className="mx-auto flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <ShieldAlert className="size-5" aria-hidden="true" />
      </span>
      <h1 className="text-lg font-semibold">{title}</h1>
      <p className="text-sm text-muted-foreground">{message}</p>
    </Card>
  )
}

/** Name, optional branch and cashier, and a verified mark ONLY when the business really is verified. */
export function MerchantHeading({ profile }: { profile: PublicProfileView }) {
  return (
    <div className="space-y-1 text-center">
      <h1 className="text-xl font-semibold">{profile.merchantDisplayName}</h1>
      {profile.isMerchantVerified && (
        <p className="inline-flex items-center gap-1 text-xs font-medium text-success">
          <BadgeCheck className="size-4" aria-hidden="true" /> Verified business
        </p>
      )}
      {(profile.branchName || profile.cashierDisplayName) && (
        <p className="text-sm text-muted-foreground">
          {[
            profile.branchName,
            profile.cashierDisplayName && `Served by ${profile.cashierDisplayName}`,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      )}
    </div>
  )
}

function OpenPaymentForm({ token, profile }: { token: string; profile: PublicProfileView }) {
  const navigate = useNavigate()
  const create = useCreateOpenRequest(token)
  const [amount, setAmount] = useState('')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const usable = profile.paymentMethods.some((method) => method.isUsable)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setErrorMessage(null)
    const value = Number(amount)
    if (
      !Number.isInteger(value) ||
      value < MINIMUM_OPEN_PAYMENT_AMOUNT ||
      value > MAXIMUM_OPEN_PAYMENT_AMOUNT
    ) {
      return setErrorMessage(
        `Enter a whole amount between ${formatRwf(MINIMUM_OPEN_PAYMENT_AMOUNT)} and ${formatRwf(MAXIMUM_OPEN_PAYMENT_AMOUNT)}.`,
      )
    }
    try {
      const request = await create.mutateAsync(value)
      navigate(buildLocalRequestPath(token, request.publicReference))
    } catch (error) {
      setErrorMessage(
        error instanceof PaymentServiceError ? error.message : 'Something went wrong. Try again.',
      )
    }
  }

  if (!usable) {
    return (
      <p className="text-sm text-muted-foreground">
        This business cannot take payments through OuPay right now.
      </p>
    )
  }
  return (
    <form onSubmit={(event) => void submit(event)} noValidate className="space-y-4">
      <FormField label="Amount to pay (RWF)" required>
        {(control) => (
          <Input
            {...control}
            inputMode="numeric"
            autoComplete="off"
            placeholder="e.g. 5000"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ''))}
          />
        )}
      </FormField>
      {errorMessage && (
        <p role="alert" className="text-sm font-medium text-danger">
          {errorMessage}
        </p>
      )}
      <Button type="submit" className="h-12 w-full text-base" disabled={create.isPending}>
        {create.isPending && <Loader2 className="animate-spin" aria-hidden="true" />}
        Continue
      </Button>
    </form>
  )
}

export function PublicProfilePage() {
  const { paymentProfileId = '' } = useParams()
  const query = usePublicProfile(paymentProfileId)

  if (query.error instanceof PaymentServiceError && query.error.code === 'not_found') {
    return (
      <UnavailablePayment
        title="Payment page not found"
        message="Check the link or QR code, or ask the business for a new one."
      />
    )
  }
  return (
    <QueryBoundary
      query={query}
      loadingFallback={<Skeleton className="h-64 w-full" />}
      errorMessage="This payment page could not be loaded."
    >
      {(profile) =>
        profile.status === 'UNAVAILABLE' ? (
          <UnavailablePayment
            title="This payment link is not available"
            message="It may have been switched off or replaced. Please ask the business for a current link."
          />
        ) : (
          <Card>
            <CardHeader>
              <MerchantHeading profile={profile} />
              <CardTitle as="h2" className="pt-2 text-center text-base">
                Pay in Rwandan francs
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <OpenPaymentForm token={paymentProfileId} profile={profile} />
              <p className="text-xs text-muted-foreground">
                You will get a payment reference next. A payment only counts once the bank confirms
                it.
              </p>
            </CardContent>
          </Card>
        )
      }
    </QueryBoundary>
  )
}
