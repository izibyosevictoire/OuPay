import { Link2, Loader2, Plus } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { EmptyState } from '@/components/common/EmptyState'
import { FormField } from '@/components/common/FormField'
import { PageHeader } from '@/components/common/PageHeader'
import { QueryBoundary } from '@/components/common/QueryBoundary'
import { SimulatedBadge, PaymentProfileStatusBadge } from '@/components/common/StatusBadge'
import { useToast } from '@/components/common/Toaster'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input, Select } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { PermissionGuard } from '@/features/auth/permissions/PermissionGuard'
import { usePermission } from '@/features/auth/permissions/usePermission'
import {
  useCreatePaymentProfile,
  usePaymentProfileOptions,
  usePaymentProfiles,
} from '@/features/payments/paymentQueries'
import { buildProfileUrl } from '@/lib/paymentLinks'
import { PaymentServiceError } from '@/services/paymentServiceError'

function CreateLinkDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const { notify } = useToast()
  const optionsQuery = usePaymentProfileOptions(open)
  const create = useCreatePaymentProfile()
  const [label, setLabel] = useState('')
  const [destinationId, setDestinationId] = useState('')
  const [branchId, setBranchId] = useState('')
  const [cashierId, setCashierId] = useState('')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setErrorMessage(null)
    try {
      await create.mutateAsync({
        label,
        paymentDestinationId: destinationId || optionsQuery.data?.destinations[0]?.id || '',
        branchId: branchId || null,
        assignedCashierId: cashierId || null,
      })
      notify('success', `Payment link "${label.trim()}" was created.`)
      setLabel('')
      setBranchId('')
      setCashierId('')
      onOpenChange(false)
    } catch (error) {
      setErrorMessage(
        error instanceof PaymentServiceError ? error.message : 'The link could not be created.',
      )
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !create.isPending && onOpenChange(next)}>
      <DialogContent>
        <form onSubmit={(event) => void submit(event)} noValidate className="flex min-h-0 flex-col">
          <DialogHeader>
            <DialogTitle>New payment link</DialogTitle>
            <DialogDescription>
              A public link customers open by scanning a QR code or tapping an NFC tag.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <QueryBoundary
              query={optionsQuery}
              loadingFallback={<Skeleton className="h-32 w-full" />}
              errorMessage="Options could not be loaded."
            >
              {(options) =>
                options.destinations.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Connect a bank account under Banking first. A link needs somewhere to send
                    money.
                  </p>
                ) : (
                  <>
                    <FormField label="Name" required hint="Shown to you only, e.g. Shop counter.">
                      {(control) => (
                        <Input
                          {...control}
                          value={label}
                          onChange={(e) => setLabel(e.target.value)}
                        />
                      )}
                    </FormField>
                    <FormField label="Pays into" required>
                      {(control) => (
                        <Select
                          {...control}
                          value={destinationId || options.destinations[0]?.id}
                          onChange={(e) => setDestinationId(e.target.value)}
                        >
                          {options.destinations.map((d) => (
                            <option key={d.id} value={d.id}>
                              {d.label} {d.maskedAccount}
                              {d.isSimulated ? ' (demo)' : ''}
                            </option>
                          ))}
                        </Select>
                      )}
                    </FormField>
                    <FormField label="Branch">
                      {(control) => (
                        <Select
                          {...control}
                          value={branchId}
                          onChange={(e) => setBranchId(e.target.value)}
                        >
                          <option value="">Whole business</option>
                          {options.branches.map((b) => (
                            <option key={b.id} value={b.id}>
                              {b.name}
                            </option>
                          ))}
                        </Select>
                      )}
                    </FormField>
                    <FormField label="Cashier" hint="Only cashiers assigned to the chosen branch.">
                      {(control) => (
                        <Select
                          {...control}
                          value={cashierId}
                          onChange={(e) => setCashierId(e.target.value)}
                        >
                          <option value="">No specific cashier</option>
                          {options.cashiers
                            .filter((c) => !branchId || c.branchIds.includes(branchId))
                            .map((c) => (
                              <option key={c.userId} value={c.userId}>
                                {c.fullName}
                              </option>
                            ))}
                        </Select>
                      )}
                    </FormField>
                  </>
                )
              }
            </QueryBoundary>
            {errorMessage && (
              <p
                role="alert"
                className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger"
              >
                {errorMessage}
              </p>
            )}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending && <Loader2 className="animate-spin" aria-hidden="true" />}
              Create link
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function PaymentLinksPage() {
  const profilesQuery = usePaymentProfiles()
  const { scope } = usePermission('payment_profiles:view')
  const [creating, setCreating] = useState(false)

  return (
    <div className="space-y-4 sm:space-y-6">
      <PageHeader
        title="Payment links"
        description={
          scope === 'limited'
            ? 'QR codes and NFC links assigned to you.'
            : 'QR codes and NFC tags that open a customer payment page.'
        }
        actions={
          <PermissionGuard permission="payment_profiles:manage">
            <Button onClick={() => setCreating(true)}>
              <Plus aria-hidden="true" /> New link
            </Button>
          </PermissionGuard>
        }
      />
      <QueryBoundary
        query={profilesQuery}
        loadingFallback={<Skeleton className="h-40 w-full" />}
        errorMessage="Payment links could not be loaded."
      >
        {(profiles) =>
          profiles.length === 0 ? (
            <Card>
              <EmptyState
                icon={Link2}
                title="No payment links yet"
                description="Create a link to get a QR code customers can scan to pay."
              />
            </Card>
          ) : (
            <ul className="grid gap-3 sm:gap-4 md:grid-cols-2">
              {profiles.map((profile) => (
                <li key={profile.id}>
                  <Card className="space-y-2 p-4 sm:p-5">
                    <div className="flex items-start justify-between gap-2">
                      <Link
                        to={`/payment-links/${profile.id}`}
                        className="min-w-0 break-words rounded-sm font-medium text-primary hover:underline"
                      >
                        {profile.label}
                      </Link>
                      <PaymentProfileStatusBadge status={profile.status} />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {profile.branchName ?? 'Whole business'}
                      {profile.cashierName && ` · ${profile.cashierName}`}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Pays into {profile.destinationLabel} {profile.destinationMasked}
                    </p>
                    <p className="break-all text-xs">{buildProfileUrl(profile.paymentProfileId)}</p>
                    {profile.isSimulated && <SimulatedBadge />}
                  </Card>
                </li>
              ))}
            </ul>
          )
        }
      </QueryBoundary>
      {creating && <CreateLinkDialog open onOpenChange={() => setCreating(false)} />}
    </div>
  )
}
