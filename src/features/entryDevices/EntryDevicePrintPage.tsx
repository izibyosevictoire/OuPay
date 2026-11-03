import { ArrowLeft, Download, Printer } from 'lucide-react'
import { Link, useParams } from 'react-router-dom'
import { QueryBoundary } from '@/components/common/QueryBoundary'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useCurrentMerchant } from '@/features/merchants/useMerchantQueries'
import { QrCode } from '@/features/paymentLinks/QrCode'
import { qrPngDataUrl } from '@/features/paymentLinks/qrPng'
import { buildEntryUrl } from '@/lib/paymentLinks'
import { useEntryDevice } from './entryDeviceQueries'

/**
 * A printable sign for ONE payment point: the business name, a large QR code and the plain permanent link. The QR code encodes exactly the
 * same string an NFC tag of this device carries, and nothing else: no amount, no bank detail, no person. The sign never changes between
 * customers; only the bill the payment point opens does.
 */
export function EntryDevicePrintPage() {
  const { deviceId = '' } = useParams()
  const query = useEntryDevice(deviceId)
  const merchant = useCurrentMerchant()

  return (
    <div className="mx-auto w-full max-w-[210mm] space-y-3">
      <div className="flex items-center justify-between gap-2 print:hidden">
        <Link
          to="/entry-devices"
          className="inline-flex items-center gap-1 rounded-sm text-sm font-medium text-primary hover:underline"
        >
          <ArrowLeft className="size-4" aria-hidden="true" /> Back to payment points
        </Link>
        <div className="flex gap-2">
          <Button
            variant="outline"
            className="min-h-11"
            onClick={async () => {
              const name = query.data?.displayName ?? 'payment-point'
              const link = document.createElement('a')
              link.href = await qrPngDataUrl(buildEntryUrl(query.data?.entryPath ?? ''))
              link.download = `oupay-${name.replace(/\W+/g, '-').toLowerCase()}-qr.png`
              link.click()
            }}
            disabled={!query.data || query.data.status === 'REVOKED'}
          >
            <Download aria-hidden="true" /> Download PNG
          </Button>
          <Button className="min-h-11" onClick={() => window.print()}>
            <Printer aria-hidden="true" /> Print
          </Button>
        </div>
      </div>
      <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground print:hidden">
        For a readable code: print black on white, keep the white border, make it at least 3 cm by 3
        cm (larger for a counter sign), do not stretch or recolour it, and test it with a phone
        camera before you laminate or mount it. The same code works for every sale: print it once.
      </p>
      <QueryBoundary
        query={query}
        loadingFallback={<Skeleton className="h-96 w-full" />}
        errorMessage="This payment point could not be loaded."
      >
        {(device) => {
          if (device.status === 'REVOKED') {
            return (
              <p role="alert" className="rounded-lg bg-card p-6 text-center text-sm">
                This payment point was revoked, so there is nothing to print. Register a new one.
              </p>
            )
          }
          const url = buildEntryUrl(device.entryPath)
          return (
            <article
              aria-label={`Sign for ${device.displayName}`}
              className="space-y-6 bg-white p-8 text-center text-black shadow-card print:p-0 print:shadow-none"
            >
              <header>
                <h1 className="text-2xl font-bold">
                  {merchant.data?.tradingName?.trim() || merchant.data?.legalName || 'Pay here'}
                </h1>
                <p className="text-lg">{device.branchName}</p>
                <p className="mt-2 text-xl font-semibold">
                  {device.deviceType === 'STATIC_QR'
                    ? 'Scan to see your bill'
                    : 'Tap or scan to see your bill'}
                </p>
              </header>
              <QrCode
                value={url}
                label={`QR code for ${device.displayName}: ${url}`}
                className="mx-auto h-auto w-full max-w-sm"
              />
              <p className="break-all text-sm">{url}</p>
              <p className="text-xs">
                Scanning only opens your bill. Pay it with the code shown there, and pay only what
                the bill shows. Never share a PIN, password or one-time code.
              </p>
              {device.status === 'SUSPENDED' && (
                <p className="text-xs font-semibold print:hidden">
                  This payment point is suspended: customers will see that it is not available.
                </p>
              )}
            </article>
          )
        }}
      </QueryBoundary>
    </div>
  )
}
