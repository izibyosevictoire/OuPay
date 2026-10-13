import { CheckCircle2, Circle, Copy, FlaskConical, Loader2 } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { useParams } from 'react-router-dom'
import { QueryBoundary } from '@/components/common/QueryBoundary'
import { CustomerStageBadge } from '@/components/common/StatusBadge'
import { useToast } from '@/components/common/Toaster'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { DEMO_TOOLS_BUILD } from '@/lib/demoTools'
import { formatDateTime, formatRwf } from '@/lib/format'
import { PaymentServiceError } from '@/services/paymentServiceError'
import type { CustomerPaymentStage, PublicRequestView } from '@/types/paymentProfile'
import { MerchantHeading, UnavailablePayment } from './PublicProfilePage'
import {
  demoSimulatorAvailable,
  usePublicRequest,
  useRecordCustomerAction,
  useSimulateBankPayment,
} from './publicPaymentQueries'

/** What each stage means, in plain words. None of them ever says "paid" unless the bank confirmed. */
const STAGE_MESSAGES: Record<CustomerPaymentStage, string> = {
  AWAITING_PAYMENT: 'We are waiting for your payment. Nothing has been confirmed yet.',
  BANK_CONFIRMATION_PENDING: 'The bank has your payment but has not confirmed it yet. Please wait.',
  CONFIRMED_AND_RECONCILED:
    'The bank confirmed your payment and the business has matched it. Thank you.',
  CONFIRMED_UNMATCHED:
    'The bank confirmed your payment to the business. It has not been applied to an invoice yet.',
  PARTIALLY_SETTLED: 'The bank confirmed part of the amount. The rest is still to pay.',
  FAILED: 'The bank reported that this payment failed. No money was taken. You can try again.',
  EXPIRED: 'This payment request has expired. Ask the business for a new one.',
  REVERSED: 'The bank reversed this payment. Contact the business if you were charged.',
  CANCELLED: 'This payment request was cancelled by the business.',
}

const isFinalForBank = (stage: CustomerPaymentStage) =>
  stage === 'CONFIRMED_AND_RECONCILED' || stage === 'CONFIRMED_UNMATCHED'

function Step({ done, label, detail }: { done: boolean; label: string; detail: string }) {
  const Icon = done ? CheckCircle2 : Circle
  return (
    <li className="flex items-start gap-2 text-sm">
      <Icon
        className={
          done
            ? 'mt-0.5 size-4 shrink-0 text-success'
            : 'mt-0.5 size-4 shrink-0 text-muted-foreground'
        }
        aria-hidden="true"
      />
      <span>
        <span className="font-medium">{label}</span>
        <span className="block text-xs text-muted-foreground">
          {detail}
          <span className="sr-only">{done ? ' (done)' : ' (not yet)'}</span>
        </span>
      </span>
    </li>
  )
}

function DemoControls({ token, reference }: { token: string; reference: string }) {
  const simulate = useSimulateBankPayment(token, reference)
  if (!demoSimulatorAvailable()) return null
  return (
    <Card className="border-dashed border-warning/60">
      <CardHeader>
        <CardTitle as="h2" className="flex items-center gap-2 text-sm">
          <FlaskConical className="size-4" aria-hidden="true" /> Demo only: simulate the bank
        </CardTitle>
        <CardDescription>
          Only in demo builds. These send SIMULATED bank events; a real customer never sees this.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        {(
          [
            ['success', 'Bank confirms'],
            ['pending', 'Bank pending'],
            ['failed', 'Bank fails'],
            ['reversal', 'Confirm then reverse'],
          ] as const
        ).map(([kind, label]) => (
          <Button
            key={kind}
            variant="outline"
            size="sm"
            disabled={simulate.isPending}
            onClick={() => simulate.mutate(kind)}
          >
            {label}
          </Button>
        ))}
        {simulate.isError && (
          <p role="alert" className="w-full text-xs text-danger">
            {simulate.error instanceof PaymentServiceError
              ? simulate.error.message
              : 'The simulation failed.'}
          </p>
        )}
      </CardContent>
    </Card>
  )
}

function RequestView({
  token,
  reference,
  view,
}: {
  token: string
  reference: string
  view: PublicRequestView
}) {
  const { notify } = useToast()
  const { markOpened, claimPaid } = useRecordCustomerAction(token, reference)
  const didMarkOpened = useRef(false)

  // Opening this page counts as opening the instructions; recorded once, never as a payment.
  useEffect(() => {
    if (!didMarkOpened.current && !view.instructionsOpened) {
      didMarkOpened.current = true
      markOpened.mutate()
    }
  }, [view.instructionsOpened, markOpened])

  const usableMethods = view.profile.paymentMethods.filter((method) => method.isUsable)
  const canStillPay = ![
    'EXPIRED',
    'CANCELLED',
    'CONFIRMED_AND_RECONCILED',
    'CONFIRMED_UNMATCHED',
  ].includes(view.stage)

  const copyReference = async () => {
    try {
      await navigator.clipboard.writeText(view.publicReference)
      notify('success', 'Reference copied.')
    } catch {
      notify('error', 'Copying was blocked. Select the reference and copy it manually.')
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <MerchantHeading profile={view.profile} />
        </CardHeader>
        <CardContent className="space-y-4">
          {view.isSimulated && (
            <p role="note" className="rounded-md bg-warning-soft px-3 py-2 text-xs text-warning">
              <strong>Demo:</strong> this page uses a simulated bank connection. No real money
              moves.
            </p>
          )}
          <div className="text-center">
            {view.invoiceReference && (
              <p className="text-sm text-muted-foreground">Invoice {view.invoiceReference}</p>
            )}
            <p className="text-3xl font-semibold tabular-nums">
              {formatRwf(canStillPay ? view.amountDue : view.requestedAmount)}
            </p>
            <p className="text-xs text-muted-foreground">
              {canStillPay && view.confirmedAmount > 0
                ? `Still to pay of ${formatRwf(view.requestedAmount)}. The bank confirmed ${formatRwf(view.confirmedAmount)}.`
                : 'Fixed amount in Rwandan francs (RWF)'}
            </p>
          </div>
          <div className="rounded-lg bg-muted p-3 text-center">
            <p className="text-xs text-muted-foreground">Payment reference</p>
            <p
              className="break-all text-lg font-semibold tracking-wide"
              data-testid="payment-reference"
            >
              {view.publicReference}
            </p>
            <Button variant="ghost" size="sm" onClick={() => void copyReference()}>
              <Copy aria-hidden="true" /> Copy reference
            </Button>
          </div>
          {canStillPay && (
            <section aria-label="How to pay" className="space-y-2">
              <h2 className="text-sm font-semibold">How to pay</h2>
              {usableMethods.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No payment method is available for this business right now.
                </p>
              ) : (
                usableMethods.map((method) => (
                  <div key={method.id} className="space-y-1">
                    <p className="text-sm font-medium">{method.label}</p>
                    <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
                      {method.instructions.map((step) => (
                        <li key={step}>{step}</li>
                      ))}
                    </ol>
                  </div>
                ))
              )}
            </section>
          )}
        </CardContent>
      </Card>

      <Card aria-live="polite">
        <CardHeader>
          <CardTitle as="h2" className="flex flex-wrap items-center gap-2 text-base">
            Payment status <CustomerStageBadge stage={view.stage} />
          </CardTitle>
          <CardDescription>{STAGE_MESSAGES[view.stage]}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ul className="space-y-2.5" aria-label="Progress">
            <Step
              done={view.instructionsOpened}
              label="You opened the instructions"
              detail="Only means you viewed this page."
            />
            <Step
              done={view.customerClaimedPayment}
              label="You said you paid"
              detail="Your word only. It does not confirm anything."
            />
            <Step
              done={view.confirmedAmount > 0 || view.stage === 'BANK_CONFIRMATION_PENDING'}
              label="Bank confirmation"
              detail={
                view.confirmedAmount > 0
                  ? `The bank confirmed ${formatRwf(view.confirmedAmount)}.`
                  : view.stage === 'BANK_CONFIRMATION_PENDING'
                    ? 'The bank has it, but has not confirmed yet.'
                    : 'Only the bank can confirm a payment.'
              }
            />
            <Step
              done={view.stage === 'CONFIRMED_AND_RECONCILED'}
              label="Matched by the business"
              detail="The business applies confirmed money to your request."
            />
          </ul>
          {canStillPay && !view.customerClaimedPayment && usableMethods.length > 0 && (
            <div className="space-y-1">
              <Button
                variant="outline"
                className="h-11 w-full"
                disabled={claimPaid.isPending}
                onClick={() => claimPaid.mutate()}
              >
                {claimPaid.isPending && <Loader2 className="animate-spin" aria-hidden="true" />}I
                have started my payment
              </Button>
              <p className="text-xs text-muted-foreground">
                This does not confirm your payment. The status above changes only when the bank
                confirms it.
              </p>
            </div>
          )}
          {!isFinalForBank(view.stage) &&
            view.stage !== 'EXPIRED' &&
            view.stage !== 'CANCELLED' && (
              <p className="text-xs text-muted-foreground">
                Valid until {formatDateTime(view.expiresAt)}. This page refreshes on its own.
              </p>
            )}
        </CardContent>
      </Card>

      {DEMO_TOOLS_BUILD && <DemoControls token={token} reference={reference} />}
    </div>
  )
}

export function PublicRequestPage() {
  const { paymentProfileId = '', publicReference = '' } = useParams()
  const query = usePublicRequest(paymentProfileId, publicReference)

  if (query.error instanceof PaymentServiceError && query.error.code === 'not_found') {
    return (
      <UnavailablePayment
        title="Payment request not found"
        message="Check the link, or ask the business for a new payment request."
      />
    )
  }
  return (
    <QueryBoundary
      query={query}
      loadingFallback={<Skeleton className="h-96 w-full" />}
      errorMessage="This payment request could not be loaded."
    >
      {(view) =>
        view.profile.status === 'UNAVAILABLE' ? (
          <UnavailablePayment
            title="This payment link is not available"
            message="It may have been switched off or replaced. Please ask the business for a current link."
          />
        ) : (
          <RequestView token={paymentProfileId} reference={publicReference} view={view} />
        )
      }
    </QueryBoundary>
  )
}
