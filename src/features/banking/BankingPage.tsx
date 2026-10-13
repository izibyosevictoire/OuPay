import { AlertTriangle, FlaskConical, Landmark, Loader2, ShieldAlert } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { EmptyState } from '@/components/common/EmptyState'
import { FormField } from '@/components/common/FormField'
import { PageHeader } from '@/components/common/PageHeader'
import { QueryBoundary } from '@/components/common/QueryBoundary'
import { BankConnectionStatusBadge, SimulatedBadge } from '@/components/common/StatusBadge'
import { useToast } from '@/components/common/Toaster'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { PROVIDER_LABELS } from '@/constants/payment'
import { DEMO_TOOLS_BUILD } from '@/lib/demoTools'
import { CAPABILITY_LABELS, REAL_EQUITY_READINESS } from '@/services/banking/providerRegistry'
import { PaymentServiceError } from '@/services/paymentServiceError'
import type { ProviderOverview } from '@/services/bankingService'
import type { BankConnection, CapabilityKey, CapabilityStatus } from '@/types/banking'
import {
  useBankConnections,
  useCompleteAccountLink,
  useDisableConnection,
  usePaymentDestinations,
  useProviders,
  useStartAccountLink,
} from '@/features/payments/paymentQueries'

const CAPABILITY_TEXT: Record<CapabilityStatus, string> = {
  SUPPORTED: 'Supported',
  NOT_SUPPORTED: 'Not supported',
  UNCONFIRMED: 'Not confirmed',
}

const messageOf = (error: unknown) =>
  error instanceof PaymentServiceError ? error.message : 'Something went wrong. Please try again.'

function CapabilityTable({
  caption,
  capabilities,
}: {
  caption: string
  capabilities: Record<CapabilityKey, CapabilityStatus>
}) {
  return (
    <table className="w-full text-left text-sm">
      <caption className="sr-only">{caption}</caption>
      <thead className="text-xs text-muted-foreground">
        <tr className="border-b">
          <th scope="col" className="pb-2 font-medium">
            Capability
          </th>
          <th scope="col" className="pb-2 font-medium">
            Status
          </th>
        </tr>
      </thead>
      <tbody className="divide-y">
        {(Object.keys(CAPABILITY_LABELS) as CapabilityKey[]).map((key) => (
          <tr key={key}>
            <th scope="row" className="py-2 pr-3 font-normal">
              {CAPABILITY_LABELS[key]}
            </th>
            <td className="py-2 text-muted-foreground">{CAPABILITY_TEXT[capabilities[key]]}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function LinkForm({ provider }: { provider: ProviderOverview }) {
  const { notify } = useToast()
  const start = useStartAccountLink()
  const [nickname, setNickname] = useState('')
  const [reference, setReference] = useState('')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setErrorMessage(null)
    try {
      const connection = await start.mutateAsync({
        providerId: provider.id,
        accountNickname: nickname,
        accountReference: reference,
      })
      if (connection.status === 'ERROR') {
        setErrorMessage(connection.lastError ?? 'The link could not be validated.')
      } else {
        notify('success', 'Demo link started. Complete it below to switch it on.')
        setNickname('')
        setReference('')
      }
    } catch (error) {
      setErrorMessage(messageOf(error))
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-3" noValidate>
      <FormField
        label="Account name"
        required
        hint="A label only you will see, e.g. Main collections."
      >
        {(control) => (
          <Input {...control} value={nickname} onChange={(e) => setNickname(e.target.value)} />
        )}
      </FormField>
      <FormField
        label="Demo account reference"
        required
        hint="Use a demo reference such as SIM-1234 (SIM-ERROR simulates a provider error). Never enter a PIN, password, one-time code or real account number."
      >
        {(control) => (
          <Input
            {...control}
            autoComplete="off"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
          />
        )}
      </FormField>
      {errorMessage && (
        <p
          role="alert"
          className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger"
        >
          {errorMessage}
        </p>
      )}
      <Button type="submit" disabled={start.isPending} aria-busy={start.isPending}>
        {start.isPending && <Loader2 className="animate-spin" aria-hidden="true" />}
        Start demo link
      </Button>
    </form>
  )
}

function ConnectionRow({ connection }: { connection: BankConnection }) {
  const { notify } = useToast()
  const complete = useCompleteAccountLink()
  const disable = useDisableConnection()
  const [confirmDisable, setConfirmDisable] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  return (
    <li className="space-y-2 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium">{connection.accountNickname}</p>
          <p className="text-xs text-muted-foreground">
            {PROVIDER_LABELS[connection.providerId]}
            {connection.maskedAccount && ` · ${connection.maskedAccount}`}
          </p>
        </div>
        <span className="flex flex-wrap items-center gap-1">
          <BankConnectionStatusBadge status={connection.status} />
          {connection.isSimulated && <SimulatedBadge />}
        </span>
      </div>
      {connection.lastError && (
        <p className="flex items-start gap-1.5 text-sm text-danger">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {connection.lastError}
        </p>
      )}
      {errorMessage && (
        <p role="alert" className="text-sm text-danger">
          {errorMessage}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {connection.status === 'PENDING' && (
          <Button
            size="sm"
            disabled={complete.isPending}
            onClick={async () => {
              setErrorMessage(null)
              try {
                await complete.mutateAsync(connection.id)
                notify('success', `${connection.accountNickname} is now connected (demo).`)
              } catch (error) {
                setErrorMessage(messageOf(error))
              }
            }}
          >
            Complete demo link<span className="sr-only"> for {connection.accountNickname}</span>
          </Button>
        )}
        {connection.status !== 'DISABLED' && (
          <Button size="sm" variant="outline" onClick={() => setConfirmDisable(true)}>
            Disable<span className="sr-only"> {connection.accountNickname}</span>
          </Button>
        )}
      </div>
      <ConfirmDialog
        open={confirmDisable}
        onOpenChange={setConfirmDisable}
        title={`Disable ${connection.accountNickname}?`}
        description="Payment links that use this account stop working, and new bank events for it are refused. Existing records are kept."
        confirmLabel="Disable connection"
        isDestructive
        isPending={disable.isPending}
        onConfirm={async () => {
          try {
            await disable.mutateAsync(connection.id)
            notify('success', `${connection.accountNickname} was disabled.`)
            setConfirmDisable(false)
          } catch (error) {
            setErrorMessage(messageOf(error))
            setConfirmDisable(false)
          }
        }}
      />
    </li>
  )
}

export function BankingPage() {
  const providersQuery = useProviders()
  const connectionsQuery = useBankConnections()
  const destinationsQuery = usePaymentDestinations()

  return (
    <div className="space-y-4 sm:space-y-6">
      <PageHeader
        title="Banking"
        description="Where customer money is paid, and what each provider can do."
        actions={
          DEMO_TOOLS_BUILD ? (
            <Button asChild variant="outline">
              <Link to="/demo/bank-simulator">
                <FlaskConical aria-hidden="true" /> Bank simulator (demo)
              </Link>
            </Button>
          ) : undefined
        }
      />

      <div
        role="note"
        className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-xs text-warning"
      >
        <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <p>
          <strong className="font-semibold">Demo connections only.</strong> Nothing here is a
          verified bank connection. OuPay never asks for a PIN, password, one-time code or
          online-banking login, and neither does this page.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Connections</CardTitle>
        </CardHeader>
        <CardContent>
          <QueryBoundary
            query={connectionsQuery}
            loadingFallback={<Skeleton className="h-24 w-full" />}
            errorMessage="Connections could not be loaded."
          >
            {(connections) =>
              connections.length === 0 ? (
                <EmptyState
                  icon={Landmark}
                  title="Not configured"
                  description="No account is linked yet. Link a demo account below."
                />
              ) : (
                <ul className="divide-y">
                  {connections.map((connection) => (
                    <ConnectionRow key={connection.id} connection={connection} />
                  ))}
                </ul>
              )
            }
          </QueryBoundary>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Payment destinations</CardTitle>
          <CardDescription>
            Accounts that payment links can pay into. Masked for safety.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <QueryBoundary
            query={destinationsQuery}
            loadingFallback={<Skeleton className="h-16 w-full" />}
            errorMessage="Payment destinations could not be loaded."
          >
            {(destinations) =>
              destinations.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Destinations appear once a connection is completed.
                </p>
              ) : (
                <ul className="divide-y">
                  {destinations.map((destination) => (
                    <li
                      key={destination.id}
                      className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm"
                    >
                      <span>
                        {destination.label}{' '}
                        <span className="text-muted-foreground">{destination.maskedAccount}</span>
                      </span>
                      {destination.isSimulated && <SimulatedBadge />}
                    </li>
                  ))}
                </ul>
              )
            }
          </QueryBoundary>
        </CardContent>
      </Card>

      <QueryBoundary
        query={providersQuery}
        loadingFallback={<Skeleton className="h-48 w-full" />}
        errorMessage="Providers could not be loaded."
      >
        {(providers) => (
          <>
            {providers.map((provider) => (
              <Card key={provider.id}>
                <CardHeader>
                  <div className="flex flex-wrap items-center gap-2">
                    <CardTitle>{provider.displayName}</CardTitle>
                    {provider.isSimulated && <SimulatedBadge />}
                    {!provider.isAvailable && (
                      <span className="text-xs text-muted-foreground">Not available yet</span>
                    )}
                  </div>
                  <CardDescription>
                    {provider.isSimulated
                      ? 'A simulator for development. Its capabilities are invented and say nothing about a real bank.'
                      : 'No integration exists yet, so no capability is assumed.'}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <CapabilityTable
                    caption={`${provider.displayName} capabilities`}
                    capabilities={provider.capabilities}
                  />
                  {provider.isAvailable && provider.capabilities.accountLinking === 'SUPPORTED' && (
                    <LinkForm provider={provider} />
                  )}
                </CardContent>
              </Card>
            ))}
            <Card>
              <CardHeader>
                <CardTitle>{REAL_EQUITY_READINESS.displayName}</CardTitle>
                <CardDescription>{REAL_EQUITY_READINESS.status}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Every capability below is still an open question for the bank. OuPay assumes none
                  of them.
                </p>
                <CapabilityTable
                  caption="Real Equity Bank Rwanda capabilities"
                  capabilities={REAL_EQUITY_READINESS.capabilities}
                />
              </CardContent>
            </Card>
          </>
        )}
      </QueryBoundary>
    </div>
  )
}
