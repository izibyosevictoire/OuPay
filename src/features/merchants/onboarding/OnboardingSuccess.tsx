import { CheckCircle2 } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { MerchantStatusBadge } from '@/components/common/StatusBadge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { MERCHANT_STATUS_DESCRIPTIONS } from '@/constants/merchant'
import type { Merchant } from '@/types/merchant'

export function OnboardingSuccess({ merchant }: { merchant: Merchant }) {
  const headingRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => headingRef.current?.focus(), [])

  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 p-6 text-center sm:p-8">
        <span className="flex size-12 items-center justify-center rounded-full bg-success-soft text-success">
          <CheckCircle2 className="size-6" aria-hidden="true" />
        </span>
        <h1 ref={headingRef} tabIndex={-1} className="text-section-title outline-none">
          Registration submitted
        </h1>
        <p className="text-sm text-muted-foreground">
          {merchant.tradingName ?? merchant.legalName} has been registered with the merchant ID{' '}
          <strong className="font-semibold text-foreground">{merchant.id}</strong>.
        </p>
        <MerchantStatusBadge status={merchant.status} />
        <p className="max-w-md text-sm text-muted-foreground">
          {MERCHANT_STATUS_DESCRIPTIONS[merchant.status]} Payment verification features stay
          unavailable until the business is approved.
        </p>
        <div className="mt-2 flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
          <Button asChild>
            <Link to="/profile">View business profile</Link>
          </Button>
          <Button asChild variant="outline">
            <Link to="/">Go to dashboard</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
