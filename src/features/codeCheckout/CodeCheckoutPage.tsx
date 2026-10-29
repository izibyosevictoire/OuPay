import { Info } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { PageHeader } from '@/components/common/PageHeader'
import { QueryBoundary } from '@/components/common/QueryBoundary'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { useAuth } from '@/app/providers/AuthProvider'
import { PermissionGuard } from '@/features/auth/permissions/PermissionGuard'
import { useSelectedMerchantId } from '@/features/branches/useBranchQueries'
import type { CodeCheckoutOptions } from '@/types/codeCheckout'
import { useCodeCheckoutOptions } from './codeCheckoutQueries'
import { forgetSale, loadSale } from './codeCheckoutSession'
import { CodeSaleForm } from './CodeSaleForm'
import { CodeSaleReceipt } from './CodeSaleReceipt'

const linkClass = 'font-medium text-primary hover:underline'

function SetupRequired({ options }: { options: CodeCheckoutOptions }) {
  let title = 'Code checkout is not set up yet'
  let body = null
  switch (options.readiness) {
    case 'NO_ASSIGNED_CODE':
      title = 'You are not assigned a collection code'
      body = (
        <>
          <p>
            Sales are billed through a collection code, and only the person it is assigned to can
            bill with it. Nothing is assigned to you automatically.
          </p>
          <PermissionGuard
            permission="collection_codes:assign"
            fallback={<p>Ask your manager or the business owner to assign you a code.</p>}
          >
            <p>
              <Link to="/collection-codes" className={linkClass}>
                Review collection codes
              </Link>{' '}
              and assign one to the person who will bill.
            </p>
          </PermissionGuard>
        </>
      )
      break
    case 'CODE_NOT_AVAILABLE':
      title = 'Your code cannot bill right now'
      body = (
        <>
          <p>
            Your code is not eligible for billing at the moment (for example it is suspended, its
            branch or bank account is unavailable, or live collection is not enabled yet).
          </p>
          <ul className="list-disc space-y-1 pl-5">
            {options.codes.map((code) => (
              <li key={code.id}>
                <strong className="font-medium">{code.label}:</strong>{' '}
                {code.reason ?? 'Not available.'}
              </li>
            ))}
          </ul>
        </>
      )
      break
    case 'NO_PAYMENT_LINK':
      title = 'A payment link is needed first'
      body = (
        <>
          <p>
            A sale rides on a payment link connected to the same bank account as your code, and
            there is no active one yet.
          </p>
          <PermissionGuard
            permission="payment_profiles:manage"
            fallback={<p>Ask your manager or the business owner to set up a payment link.</p>}
          >
            <p>
              <Link to="/payment-links" className={linkClass}>
                Set up a payment link
              </Link>
              .
            </p>
          </PermissionGuard>
        </>
      )
      break
    case 'READY':
      break
  }
  return (
    <Card>
      <CardContent className="space-y-3 p-4 text-sm sm:p-6">
        <h2 className="text-base font-semibold">{title}</h2>
        {body}
        {options.note && <p className="text-muted-foreground">{options.note}</p>}
      </CardContent>
    </Card>
  )
}

function CheckoutBody({ scope }: { scope: string }) {
  const options = useCodeCheckoutOptions()
  const [remembered, setRemembered] = useState(() => loadSale(scope))

  // A remembered sale is read again from the server, so a refresh or a lost response always lands on the same sale.
  if (remembered) {
    return (
      <CodeSaleReceipt
        saleId={remembered.saleId}
        onNewSale={() => {
          forgetSale(scope)
          setRemembered(undefined)
        }}
        onGone={() => {
          forgetSale(scope)
          setRemembered(undefined)
        }}
      />
    )
  }
  return (
    <QueryBoundary
      query={options}
      loadingFallback={<Skeleton className="h-72 w-full" />}
      errorMessage="Code checkout could not be loaded."
    >
      {(data) =>
        data.readiness === 'READY' ? (
          <CodeSaleForm
            scope={scope}
            options={data}
            onBilled={(sale) =>
              setRemembered({ saleId: sale.saleId, saleReference: sale.saleReference })
            }
          />
        ) : (
          <SetupRequired options={data} />
        )
      }
    </QueryBoundary>
  )
}

export function CodeCheckoutPage() {
  const merchantId = useSelectedMerchantId()
  const { user } = useAuth()
  // A remembered sale belongs to one person in one business.
  const scope = `${merchantId}.${user?.id ?? 'anonymous'}`
  return (
    <div className="mx-auto max-w-xl space-y-4">
      <PageHeader
        title="Code checkout"
        description="Enter an amount and bill. The customer pays with the merchant code and the sale reference."
      />
      <div
        role="note"
        className="flex items-start gap-2 rounded-lg border border-info/20 bg-info-soft px-3 py-2 text-xs text-info"
      >
        <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <p>
          A sale is <strong className="font-semibold">live</strong> only when its code is approved
          by the bank and live collection is enabled. Until then a simulated code makes a clearly
          labelled <strong className="font-semibold">demonstration</strong>, and a payment shows as
          confirmed only after the bank reports it and it is applied to the sale.
        </p>
      </div>
      <CheckoutBody key={scope} scope={scope} />
    </div>
  )
}
