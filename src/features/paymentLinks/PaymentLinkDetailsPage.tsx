import { ArrowLeft, Copy, Download, ExternalLink, FileSearch, Printer } from 'lucide-react'
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { DescriptionList } from '@/components/common/DescriptionList'
import { EmptyState } from '@/components/common/EmptyState'
import { PageHeader } from '@/components/common/PageHeader'
import { QueryBoundary } from '@/components/common/QueryBoundary'
import { PaymentProfileStatusBadge, SimulatedBadge } from '@/components/common/StatusBadge'
import { useToast } from '@/components/common/Toaster'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { PermissionGuard } from '@/features/auth/permissions/PermissionGuard'
import {
  useReissueProfile,
  useSetProfileActive,
  usePaymentProfile,
} from '@/features/payments/paymentQueries'
import {
  NFC_TAG_REQUIREMENTS,
  buildLocalProfilePath,
  buildProfileUrl,
  describeNdefUriRecord,
} from '@/lib/paymentLinks'
import type { PaymentProfileView } from '@/services/paymentProfileService'
import { PaymentServiceError } from '@/services/paymentServiceError'
import { QrCode } from './QrCode'
import { qrPngDataUrl } from './qrPng'

const messageOf = (error: unknown) =>
  error instanceof PaymentServiceError ? error.message : 'Something went wrong. Please try again.'

function Details({ profile }: { profile: PaymentProfileView }) {
  const { notify } = useToast()
  const setActive = useSetProfileActive()
  const reissue = useReissueProfile()
  const [dialog, setDialog] = useState<'toggle' | 'reissue' | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const url = buildProfileUrl(profile.paymentProfileId)
  const ndef = describeNdefUriRecord(url)
  const isRevoked = profile.status === 'REVOKED'
  const isActive = profile.status === 'ACTIVE'

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text)
      notify('success', `${what} copied.`)
    } catch {
      notify('error', 'Your browser blocked copying. Select the text and copy it manually.')
    }
  }

  const downloadPng = async () => {
    const link = document.createElement('a')
    link.href = await qrPngDataUrl(url)
    link.download = `oupay-${profile.label.replace(/\W+/g, '-').toLowerCase()}-qr.png`
    link.click()
  }

  return (
    <>
      <PageHeader
        title={profile.label}
        description={`${profile.merchantDisplayName} · ${profile.branchName ?? 'Whole business'}`}
        actions={
          !isRevoked && isActive ? (
            <Button asChild variant="outline">
              <Link to={`/payment-links/${profile.id}/print`}>
                <Printer aria-hidden="true" /> Print QR code
              </Link>
            </Button>
          ) : undefined
        }
      />

      <Card className="space-y-2 p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-2">
          <PaymentProfileStatusBadge status={profile.status} />
          {profile.isSimulated && <SimulatedBadge />}
        </div>
        <p className="text-sm text-muted-foreground">
          {isRevoked
            ? 'This link was replaced. Anyone who scans the old code sees an "unavailable" page.'
            : isActive
              ? 'Customers who scan the QR code or tap an NFC tag can open the payment page.'
              : 'This link is switched off. The QR code and any NFC tag show an "unavailable" page.'}
        </p>
        <p className="text-xs text-muted-foreground">
          The link is public. It contains an unguessable code and no banking details, but anyone
          holding it can open the page. If it leaks, replace it.
        </p>
        <PermissionGuard permission="payment_profiles:manage">
          {!isRevoked && (
            <div className="flex flex-wrap gap-2 pt-1">
              <Button variant="outline" onClick={() => setDialog('toggle')}>
                {isActive ? 'Switch off' : 'Switch on'}
              </Button>
              <Button variant="outline" onClick={() => setDialog('reissue')}>
                Replace link
              </Button>
            </div>
          )}
        </PermissionGuard>
        {isRevoked && profile.replacedByProfileId && (
          <Link
            to={`/payment-links/${profile.replacedByProfileId}`}
            className="text-sm font-medium text-primary hover:underline"
          >
            View the replacement link
          </Link>
        )}
        {errorMessage && (
          <p role="alert" className="text-sm text-danger">
            {errorMessage}
          </p>
        )}
      </Card>

      {!isRevoked && (
        <Card>
          <CardHeader>
            <CardTitle>QR code</CardTitle>
            <CardDescription>The code contains exactly this link and nothing else.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="mx-auto w-full max-w-xs rounded-lg border bg-white p-2">
              <QrCode
                value={url}
                label={`QR code for ${profile.label}: ${url}`}
                className="h-auto w-full"
              />
            </div>
            <p className="break-all text-center text-sm" data-testid="payment-url">
              {url}
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              <Button variant="outline" onClick={() => void copy(url, 'Link')}>
                <Copy aria-hidden="true" /> Copy link
              </Button>
              <Button variant="outline" onClick={() => void downloadPng()}>
                <Download aria-hidden="true" /> Download PNG
              </Button>
              <Button asChild variant="outline">
                <Link to={buildLocalProfilePath(profile.paymentProfileId)} target="_blank">
                  <ExternalLink aria-hidden="true" /> Open customer page
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {!isRevoked && (
        <Card>
          <CardHeader>
            <CardTitle>NFC tag</CardTitle>
            <CardDescription>
              Prepare a tag (or later a card or bracelet) that opens the same page when tapped.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <DescriptionList
              rows={[
                { label: 'Record type', value: ndef.recordType },
                { label: 'URL to write', value: ndef.url },
                { label: 'Approx. size', value: `${ndef.payloadBytes} bytes` },
                {
                  label: 'Tag works while',
                  value: isActive
                    ? 'This link is switched on'
                    : 'This link is switched on (currently off)',
                },
              ]}
            />
            <Button variant="outline" onClick={() => void copy(ndef.url, 'NDEF URL')}>
              <Copy aria-hidden="true" /> Copy URL for NFC writing
            </Button>
            <div>
              <h3 className="text-sm font-medium">Tag requirements</h3>
              <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
                {NFC_TAG_REQUIREMENTS.map((requirement) => (
                  <li key={requirement}>{requirement}</li>
                ))}
              </ul>
            </div>
            <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
              OuPay cannot scan or write NFC hardware from this web app, and a tag&apos;s hardware
              ID is never trusted as proof of payment or identity. Switching the link off disables
              the tag too. Cards and bracelets will attach to this link in a later release.
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <DescriptionList
          rows={[
            { label: 'Branch', value: profile.branchName ?? 'Whole business' },
            { label: 'Cashier', value: profile.cashierName ?? 'No specific cashier' },
            {
              label: 'Pays into',
              value: `${profile.destinationLabel} ${profile.destinationMasked}`,
            },
          ]}
        />
      </Card>

      <ConfirmDialog
        open={dialog === 'toggle'}
        onOpenChange={(open) => !open && setDialog(null)}
        title={isActive ? 'Switch this link off?' : 'Switch this link on?'}
        description={
          isActive
            ? 'Customers who scan the QR code or tap the NFC tag will see an unavailable page until you switch it back on.'
            : 'Customers will be able to open the payment page again.'
        }
        confirmLabel={isActive ? 'Switch off' : 'Switch on'}
        isDestructive={isActive}
        isPending={setActive.isPending}
        onConfirm={async () => {
          try {
            await setActive.mutateAsync({ profileId: profile.id, isActive: !isActive })
            notify('success', isActive ? 'The link is switched off.' : 'The link is switched on.')
          } catch (error) {
            setErrorMessage(messageOf(error))
          }
          setDialog(null)
        }}
      />
      <ConfirmDialog
        open={dialog === 'reissue'}
        onOpenChange={(open) => !open && setDialog(null)}
        title="Replace this link?"
        description="A new link and QR code are created. The old link stops working for good, so printed codes and tags using it must be replaced."
        confirmLabel="Replace link"
        isDestructive
        isPending={reissue.isPending}
        onConfirm={async () => {
          try {
            await reissue.mutateAsync(profile.id)
            notify('success', 'A new link was created. The old one no longer works.')
          } catch (error) {
            setErrorMessage(messageOf(error))
          }
          setDialog(null)
        }}
      />
    </>
  )
}

export function PaymentLinkDetailsPage() {
  const { profileId = '' } = useParams()
  const query = usePaymentProfile(profileId)
  if (query.error instanceof PaymentServiceError && query.error.code === 'not_found') {
    return (
      <div className="space-y-4 sm:space-y-6">
        <PageHeader title="Payment link not found" />
        <Card>
          <EmptyState
            icon={FileSearch}
            title="We could not find that link"
            description="It may belong to a different business, or it is not assigned to you."
          />
          <div className="flex justify-center pb-8">
            <Button asChild variant="outline">
              <Link to="/payment-links">All payment links</Link>
            </Button>
          </div>
        </Card>
      </div>
    )
  }
  return (
    <div className="space-y-4 sm:space-y-6">
      <Link
        to="/payment-links"
        className="inline-flex items-center gap-1 rounded-sm text-sm font-medium text-primary hover:underline"
      >
        <ArrowLeft className="size-4" aria-hidden="true" /> All payment links
      </Link>
      <QueryBoundary
        query={query}
        loadingFallback={<Skeleton className="h-96 w-full" />}
        errorMessage="This payment link could not be loaded."
      >
        {(profile) => <Details profile={profile} />}
      </QueryBoundary>
    </div>
  )
}
