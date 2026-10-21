import { Info } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { PageHeader } from '@/components/common/PageHeader'
import { QueryBoundary } from '@/components/common/QueryBoundary'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { useAuth } from '@/app/providers/AuthProvider'
import { PermissionGuard } from '@/features/auth/permissions/PermissionGuard'
import { useSelectedMerchantId } from '@/features/branches/useBranchQueries'
import { DEMO_TOOLS_BUILD } from '@/lib/demoTools'
import { API_MODE } from '@/services/http/apiConfig'
import type { SimpleCheckoutOptions, SimpleCheckoutResult } from '@/types/checkout'
import { useSimpleCheckoutOptions } from './checkoutQueries'
import { forgetSale, loadSale } from './checkoutSession'
import { CollectForm } from './CollectForm'
import { SaleReceipt } from './SaleReceipt'

/** Demo mode is never mistaken for real banking: a clear label, and no claim of real confirmation. */
function DemoNotice() {
  if (API_MODE === 'http') return null
  return (
    <div
      role="note"
      className="flex items-start gap-2 rounded-lg border border-info/20 bg-info-soft px-3 py-2 text-xs text-info"
    >
      <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <p>
        <strong className="font-semibold">Demo mode.</strong> Nothing here moves real money. A
        payment shows as confirmed only after a (simulated) bank event is verified
        {DEMO_TOOLS_BUILD && (
          <>
            , which you can send from the{' '}
            <Link to="/demo/bank-simulator" className="font-medium underline">
              demo bank simulator
            </Link>
          </>
        )}
        .
      </p>
    </div>
  )
}

const linkClass = 'font-medium text-primary hover:underline'

function SetupRequired({ options }: { options: SimpleCheckoutOptions }) {
  let title = 'Collect Payment is not set up yet'
  let body: ReactNode = null
  switch (options.readiness) {
    case 'NOT_SIMPLIFIED':
      title = 'Collect Payment is for simplified businesses'
      body = (
        <>
          <p>
            This business works in full business mode, so payments are collected through invoices.
          </p>
          <p>
            <Link to="/invoices/new" className={linkClass}>
              Create an invoice
            </Link>
            . An owner can change the business mode in{' '}
            <Link to="/settings" className={linkClass}>
              Settings
            </Link>
            .
          </p>
        </>
      )
      break
    case 'NO_BRANCH':
      title = 'You need a branch to collect payments'
      body = (
        <>
          <p>
            Payments are billed at a branch, by someone assigned to it, and you are not assigned to
            an active branch yet. Nothing is created for you automatically.
          </p>
          <PermissionGuard
            permission="branches:manage"
            fallback={<p>Ask your manager or the business owner to assign you to a branch.</p>}
          >
            <p>
              <Link to="/branches" className={linkClass}>
                Create or review branches
              </Link>
              , then{' '}
              <Link to="/cashiers" className={linkClass}>
                assign yourself to one
              </Link>
              .
            </p>
          </PermissionGuard>
        </>
      )
      break
    case 'NO_PAYMENT_LINK':
      title = 'A payment link is needed first'
      body = (
        <>
          <p>
            Customers pay through a payment link connected to your bank account, and there is no
            active one that can collect for you yet.
          </p>
          <PermissionGuard
            permission="payment_profiles:manage"
            fallback={<p>Ask your manager or the business owner to set up a payment link.</p>}
          >
            <p>
              <Link to="/payment-links" className={linkClass}>
                Set up a payment link
              </Link>
              . A connected bank link is required (see{' '}
              <Link to="/banking" className={linkClass}>
                Banking
              </Link>
              ).
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
      </CardContent>
    </Card>
  )
}

function CheckoutBody({ scope }: { scope: string }) {
  const options = useSimpleCheckoutOptions()
  const [sale, setSale] = useState<SimpleCheckoutResult | undefined>(() => loadSale(scope))

  // The sale on screen does not depend on the checkout options: it keeps working if setup changes meanwhile.
  if (sale) {
    return (
      <SaleReceipt
        sale={sale}
        onNewPayment={() => {
          forgetSale(scope)
          setSale(undefined)
        }}
        onGone={() => {
          // The server no longer shows this sale to this person (another account, another business): drop it.
          forgetSale(scope)
          setSale(undefined)
        }}
      />
    )
  }
  return (
    <QueryBoundary
      query={options}
      loadingFallback={<Skeleton className="h-72 w-full" />}
      errorMessage="Collect Payment could not be loaded."
    >
      {(data) =>
        data.readiness === 'READY' ? (
          <CollectForm scope={scope} options={data} onBilled={setSale} />
        ) : (
          <SetupRequired options={data} />
        )
      }
    </QueryBoundary>
  )
}

export function SimplifiedCheckoutPage() {
  const merchantId = useSelectedMerchantId()
  const { user } = useAuth()
  // A remembered sale belongs to one person in one business.
  const scope = `${merchantId}.${user?.id ?? 'anonymous'}`
  return (
    <div className="mx-auto max-w-xl space-y-4">
      <PageHeader
        title="Collect Payment"
        description="Enter an amount and bill. The customer pays by scanning the QR code or opening the link."
      />
      <DemoNotice />
      {/* Keyed by business and person: switching either never shows another's sale or form. */}
      <CheckoutBody key={scope} scope={scope} />
    </div>
  )
}
