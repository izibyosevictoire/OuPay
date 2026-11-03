import { Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { PublicSaleView } from '@/features/codeCheckout/PublicCodeSalePage'
import type { PublicEntry } from '@/types/entryDevices'
import { useClaimEntry, usePublicEntry, useReleaseEntry } from './entryDeviceQueries'

const claimKey = (token: string) => `oupay.entry.claim.${token}`

/** The customer's own session secret lives in this tab only (sessionStorage), never in the URL, a cookie or localStorage. */
function readClaim(token: string): string | null {
  try {
    return window.sessionStorage.getItem(claimKey(token))
  } catch {
    return null
  }
}
/**
 * The browser PROPOSES its own claim token (256 random bits, base64url) and stores it in this tab BEFORE the request is sent. If the answer
 * is lost, repeating the very same request finds the same claim: nothing has to be guessed or shared, and nobody else can use it.
 */
function newClaimProposal(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function writeClaim(token: string, claim: string | null) {
  try {
    if (claim) window.sessionStorage.setItem(claimKey(token), claim)
    else window.sessionStorage.removeItem(claimKey(token))
  } catch {
    /* Storage can be unavailable (private mode): the session then lasts until the page is closed. */
  }
}

function Notice({ title, message, tone = 'neutral', children }: { title: string; message: string; tone?: 'neutral' | 'busy'; children?: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="space-y-3 p-4 text-center text-sm sm:p-6" role="status" aria-live="polite" data-tone={tone}>
        <h1 className="text-base font-semibold">{title}</h1>
        <p className="text-muted-foreground">{message}</p>
        {children}
      </CardContent>
    </Card>
  )
}

/**
 * The page a static QR code or an NFC tap opens. MOBILE FIRST, anonymous and honest:
 *  - merely opening it only READS (a phone or app may pre-fetch the link, so nothing is taken by looking);
 *  - the customer takes the bill by choosing "Show my bill"; only then is the amount, reference and code shown, and only to them;
 *  - while someone else holds the device it says "Payment in progress", with no detail of their bill;
 *  - it never says a payment happened: the status shown is the bank-verified one, and a timeout is never called a failure;
 *  - it offers no payment simulator and never asks for a PIN, password or one-time code.
 */
export function PublicEntryPage() {
  const { token = '' } = useParams()
  const [claim, setClaim] = useState<string | null>(() => readClaim(token))
  const query = usePublicEntry(token, claim)
  const take = useClaimEntry(token)
  const release = useReleaseEntry(token)

  // A claim for a device the server no longer serves (revoked, or not this device) is forgotten in storage too.
  const unavailable = query.data?.state === 'UNAVAILABLE'
  useEffect(() => {
    if (unavailable) writeClaim(token, null)
  }, [unavailable, token])

  /** Takes the bill. The proposal is stored first, so a lost answer is recovered by repeating this same request. */
  const takeBill = () => {
    const proposal = claim ?? newClaimProposal()
    writeClaim(token, proposal)
    setClaim(proposal)
    take.mutate(proposal, {
      onSuccess: (entry: PublicEntry) => {
        // The server minted its own token (the proposal was already in use): that is the one to keep, shown once.
        const issued = entry.claim?.claimToken ?? null
        if (issued) {
          writeClaim(token, issued)
          setClaim(issued)
        } else if (entry.state !== 'CLAIMED' && entry.state !== 'SESSION_ENDED') {
          // Someone else holds the device, or there is nothing to take: this tab holds nothing, so it keeps nothing.
          writeClaim(token, null)
          setClaim(null)
        }
      },
    })
  }

  if (query.isPending) {
    return (
      <Card>
        <CardContent className="p-4 text-sm" role="status" aria-live="polite">
          <p className="flex items-center gap-2">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            Opening this payment point…
          </p>
        </CardContent>
      </Card>
    )
  }
  const entry = query.data
  if (query.isError || !entry) {
    return (
      <Card>
        <CardContent className="space-y-3 p-4 text-sm" role="alert">
          <h1 className="text-base font-semibold">This payment point could not be opened</h1>
          <p>Check your connection and try again.</p>
          <Button type="button" variant="outline" onClick={() => void query.refetch()}>
            Try again
          </Button>
        </CardContent>
      </Card>
    )
  }

  switch (entry.state) {
    case 'UNAVAILABLE':
      return <Notice title="This payment point is not available" message={entry.message} />
    case 'IDLE':
      return (
        <Notice title={entry.merchantDisplayName ?? 'Payment point'} message={entry.message}>
          <Button type="button" variant="outline" onClick={() => void query.refetch()}>
            Check again
          </Button>
        </Notice>
      )
    case 'BUSY':
      return (
        <Notice title="Payment in progress" message={entry.message} tone="busy">
          <Button type="button" variant="outline" onClick={() => void query.refetch()}>
            Check again
          </Button>
        </Notice>
      )
    case 'READY':
      return (
        <Notice title={entry.merchantDisplayName ?? 'Payment point'} message={entry.message}>
          {take.isError && (
            <p role="alert" className="text-danger">
              Something went wrong. Please try again.
            </p>
          )}
          <Button
            type="button"
            className="w-full"
            disabled={take.isPending}
            aria-busy={take.isPending}
            onClick={takeBill}
          >
            {take.isPending && <Loader2 className="animate-spin" aria-hidden="true" />}
            Show my bill
          </Button>
        </Notice>
      )
    case 'CLAIMED':
    case 'SESSION_ENDED':
      return (
        <div className="space-y-3">
          {entry.sale && <PublicSaleView sale={entry.sale} />}
          <p role="status" className="px-1 text-center text-xs text-muted-foreground">
            {entry.message}
          </p>
          <p className="px-1 text-center text-xs text-muted-foreground">
            The QR code or tag you used is a permanent payment point: it stays the same for every customer. The sale reference above belongs to
            this bill only.
          </p>
          {entry.state === 'CLAIMED' ? (
            <Button
              type="button"
              variant="outline"
              className="w-full"
              disabled={release.isPending}
              onClick={() =>
                release.mutate(claim, {
                  onSuccess: () => void query.refetch(),
                })
              }
            >
              I am finished: free this payment point
            </Button>
          ) : (
            <Button type="button" variant="outline" className="w-full" onClick={takeBill} disabled={take.isPending}>
              Show the bill now ready at this payment point
            </Button>
          )}
        </div>
      )
  }
}
