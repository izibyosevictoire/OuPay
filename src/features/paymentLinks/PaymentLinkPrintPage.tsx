import { ArrowLeft, Printer } from 'lucide-react'
import { Link, useParams } from 'react-router-dom'
import { QueryBoundary } from '@/components/common/QueryBoundary'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { usePaymentProfile } from '@/features/payments/paymentQueries'
import { buildProfileUrl } from '@/lib/paymentLinks'
import { QrCode } from './QrCode'

/** A printable sign for the counter: the merchant name, a large QR code and the plain link. */
export function PaymentLinkPrintPage() {
  const { profileId = '' } = useParams()
  const query = usePaymentProfile(profileId)

  return (
    <div className="mx-auto w-full max-w-[210mm] space-y-3">
      <div className="flex items-center justify-between gap-2 print:hidden">
        <Link
          to={`/payment-links/${profileId}`}
          className="inline-flex items-center gap-1 rounded-sm text-sm font-medium text-primary hover:underline"
        >
          <ArrowLeft className="size-4" aria-hidden="true" /> Back to link
        </Link>
        <Button onClick={() => window.print()}>
          <Printer aria-hidden="true" /> Print
        </Button>
      </div>
      <QueryBoundary
        query={query}
        loadingFallback={<Skeleton className="h-96 w-full" />}
        errorMessage="This payment link could not be loaded."
      >
        {(profile) => {
          if (profile.status !== 'ACTIVE') {
            return (
              <p role="alert" className="rounded-lg bg-card p-6 text-center text-sm">
                This link is not active, so there is nothing to print. Switch it on first.
              </p>
            )
          }
          const url = buildProfileUrl(profile.paymentProfileId)
          return (
            <article
              aria-label={`Payment sign for ${profile.label}`}
              className="space-y-6 bg-white p-8 text-center text-black shadow-card print:p-0 print:shadow-none"
            >
              <header>
                <h1 className="text-2xl font-bold">{profile.merchantDisplayName}</h1>
                {profile.branchName && <p className="text-lg">{profile.branchName}</p>}
                <p className="mt-2 text-xl font-semibold">Scan to pay</p>
              </header>
              <QrCode
                value={url}
                label={`QR code for ${profile.label}: ${url}`}
                className="mx-auto h-auto w-full max-w-sm"
              />
              <p className="break-all text-sm">{url}</p>
              <p className="text-xs">
                Pay only what the page shows. Never share a PIN, password or one-time code.
              </p>
              {profile.isSimulated && (
                <p className="text-xs font-semibold">DEMO: simulated bank connection</p>
              )}
            </article>
          )
        }}
      </QueryBoundary>
    </div>
  )
}
