import { Loader2 } from 'lucide-react'
import { useState } from 'react'
import { FormField } from '@/components/common/FormField'
import { useToast } from '@/components/common/Toaster'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input, Select, Textarea } from '@/components/ui/input'
import { formatRwf } from '@/lib/format'
import { EntryDeviceServiceError } from '@/services/entryDeviceService'
import {
  ENTRY_DEVICE_TYPES,
  type EntryDevice,
  type EntryDeviceOptions,
  type EntryDeviceType,
} from '@/types/entryDevices'
import {
  useAssignDevice,
  useBindSale,
  useChangeDeviceStatus,
  useEligibleSales,
  useRegisterDevice,
  useUnbindSale,
  type DeviceStatusAction,
} from './entryDeviceQueries'
import {
  DEVICE_TYPE_HELP,
  DEVICE_TYPE_LABELS,
  MAX_DEVICE_NAME,
  MAX_REASON,
  SALE_STATUS_LABELS,
} from './entryDeviceLabels'

/** A message a person can act on. A stale version tells them to reload; anything else keeps the server's own words. */
function describe(error: unknown, fallback: string): string {
  if (error instanceof EntryDeviceServiceError) {
    if (error.code === 'version_conflict') {
      return `${error.message} Close this window, look at the device again, and retry.`
    }
    return error.message
  }
  return fallback
}

function ErrorAlert({ message }: { message: string | null }) {
  if (!message) return null
  return (
    <div
      role="alert"
      className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger"
    >
      {message}
    </div>
  )
}

function Submit({ pending, label, destructive = false }: { pending: boolean; label: string; destructive?: boolean }) {
  return (
    <Button
      type="submit"
      className={destructive ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90' : undefined}
      disabled={pending}
      aria-busy={pending}
    >
      {pending && <Loader2 className="animate-spin" aria-hidden="true" />}
      {pending ? 'Working…' : label}
    </Button>
  )
}

interface ShellProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  children: React.ReactNode
}

/** Mounted only while open, so every opening starts with fresh values (and a fresh request identity). */
function Shell({ open, onOpenChange, children }: ShellProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>{children}</DialogContent>
    </Dialog>
  )
}

// ---- register -------------------------------------------------------------------------------------------------------

export function RegisterDeviceDialog({
  open,
  onOpenChange,
  options,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  options: EntryDeviceOptions
}) {
  return (
    <Shell open={open} onOpenChange={onOpenChange}>
      <RegisterForm options={options} onDone={() => onOpenChange(false)} />
    </Shell>
  )
}

function RegisterForm({ options, onDone }: { options: EntryDeviceOptions; onDone: () => void }) {
  const { notify } = useToast()
  const register = useRegisterDevice()
  // One identity per opening: a retry after a lost answer returns the same device instead of a second one.
  const [clientRequestId] = useState(() => crypto.randomUUID())
  const [deviceType, setDeviceType] = useState<EntryDeviceType>('STATIC_QR')
  const [displayName, setDisplayName] = useState('')
  const [branchId, setBranchId] = useState(options.branches[0]?.id ?? '')
  const [cashierId, setCashierId] = useState('')
  const [error, setError] = useState<string | null>(null)
  const cashiers = options.cashiers.filter((c) => c.branchIds.includes(branchId))
  const nameProblem =
    displayName.trim().length === 0
      ? 'Give the device a name.'
      : displayName.trim().length > MAX_DEVICE_NAME
        ? `Use at most ${MAX_DEVICE_NAME} characters.`
        : undefined
  const braceletProblem =
    deviceType === 'NFC_BRACELET' && !cashierId ? 'A bracelet belongs to one cashier.' : undefined

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)
    if (nameProblem || braceletProblem || !branchId) {
      setError(nameProblem ?? braceletProblem ?? 'Choose a branch.')
      return
    }
    register.mutate(
      {
        clientRequestId,
        deviceType,
        displayName: displayName.trim(),
        branchId,
        assignedCashierUserId: cashierId || null,
      },
      {
        onSuccess: () => {
          notify('success', 'The payment point was registered.')
          onDone()
        },
        onError: (e) => setError(describe(e, 'The payment point could not be registered.')),
      },
    )
  }

  return (
    <form onSubmit={submit} noValidate>
      <DialogHeader>
        <DialogTitle>Register a payment point</DialogTitle>
        <DialogDescription>
          A payment point is a permanent doorway. It never holds a bank code, an amount or a person: it only opens
          the bill you prepare for it.
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-4">
        <ErrorAlert message={error} />
        <FormField label="Kind" required hint={DEVICE_TYPE_HELP[deviceType]}>
          {(props) => (
            <Select {...props} value={deviceType} onChange={(e) => setDeviceType(e.target.value as EntryDeviceType)}>
              {ENTRY_DEVICE_TYPES.map((type) => (
                <option key={type} value={type}>
                  {DEVICE_TYPE_LABELS[type]}
                </option>
              ))}
            </Select>
          )}
        </FormField>
        <FormField label="Name" required error={error && nameProblem ? nameProblem : undefined} hint="How staff will recognise it, for example “Counter 1”.">
          {(props) => (
            <Input {...props} value={displayName} maxLength={MAX_DEVICE_NAME + 10} onChange={(e) => setDisplayName(e.target.value)} />
          )}
        </FormField>
        <FormField label="Branch" required>
          {(props) => (
            <Select
              {...props}
              value={branchId}
              onChange={(e) => {
                setBranchId(e.target.value)
                setCashierId('')
              }}
            >
              {options.branches.map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.name} ({branch.code})
                </option>
              ))}
            </Select>
          )}
        </FormField>
        <FormField
          label="Cashier"
          required={deviceType === 'NFC_BRACELET'}
          error={error && braceletProblem ? braceletProblem : undefined}
          hint="Leave empty for a shared counter: then each cashier gives it their own bill."
        >
          {(props) => (
            <Select {...props} value={cashierId} onChange={(e) => setCashierId(e.target.value)}>
              <option value="">No fixed cashier</option>
              {cashiers.map((cashier) => (
                <option key={cashier.userId} value={cashier.userId}>
                  {cashier.fullName}
                </option>
              ))}
            </Select>
          )}
        </FormField>
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Submit pending={register.isPending} label="Register" />
      </DialogFooter>
    </form>
  )
}

// ---- assign ---------------------------------------------------------------------------------------------------------

export function AssignDeviceDialog({
  open,
  onOpenChange,
  device,
  options,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  device: EntryDevice
  options: EntryDeviceOptions
}) {
  return (
    <Shell open={open} onOpenChange={onOpenChange}>
      <AssignForm device={device} options={options} onDone={() => onOpenChange(false)} />
    </Shell>
  )
}

function AssignForm({ device, options, onDone }: { device: EntryDevice; options: EntryDeviceOptions; onDone: () => void }) {
  const { notify } = useToast()
  const assign = useAssignDevice(device.id)
  const [branchId, setBranchId] = useState(device.branchId)
  const [cashierId, setCashierId] = useState(device.assignedCashierUserId ?? '')
  const [reason, setReason] = useState('')
  const [confirm, setConfirm] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const cashiers = options.cashiers.filter((c) => c.branchIds.includes(branchId))
  const sessionNeedsConfirmation = error?.includes('looking at this bill') ?? false

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)
    if (device.deviceType === 'NFC_BRACELET' && !cashierId) {
      setError('A bracelet always keeps a cashier.')
      return
    }
    assign.mutate(
      {
        expectedVersion: device.version,
        branchId,
        assignedCashierUserId: cashierId || null,
        reason: reason.trim() || null,
        confirmActiveSession: confirm,
      },
      {
        onSuccess: () => {
          notify('success', 'The payment point was reassigned. The history keeps the earlier assignment.')
          onDone()
        },
        onError: (e) => setError(describe(e, 'The payment point could not be reassigned.')),
      },
    )
  }

  return (
    <form onSubmit={submit} noValidate>
      <DialogHeader>
        <DialogTitle>Change branch or cashier</DialogTitle>
        <DialogDescription>
          “{device.displayName}” keeps its link. A bill that no longer fits the new cashier or branch is closed, never carried over.
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-4">
        <ErrorAlert message={error} />
        <FormField label="Branch" required>
          {(props) => (
            <Select {...props} value={branchId} onChange={(e) => { setBranchId(e.target.value); setCashierId('') }}>
              {options.branches.map((branch) => (
                <option key={branch.id} value={branch.id}>{branch.name} ({branch.code})</option>
              ))}
            </Select>
          )}
        </FormField>
        <FormField label="Cashier" required={device.deviceType === 'NFC_BRACELET'}>
          {(props) => (
            <Select {...props} value={cashierId} onChange={(e) => setCashierId(e.target.value)}>
              <option value="">No fixed cashier</option>
              {cashiers.map((cashier) => (
                <option key={cashier.userId} value={cashier.userId}>{cashier.fullName}</option>
              ))}
            </Select>
          )}
        </FormField>
        <FormField label="Reason" hint="Kept in the assignment history.">
          {(props) => <Input {...props} value={reason} maxLength={MAX_REASON} onChange={(e) => setReason(e.target.value)} />}
        </FormField>
        {sessionNeedsConfirmation && (
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
            <span>Close the bill anyway, although a customer is looking at it.</span>
          </label>
        )}
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>Cancel</Button>
        <Submit pending={assign.isPending} label="Save change" />
      </DialogFooter>
    </form>
  )
}

// ---- suspend, reactivate, revoke ------------------------------------------------------------------------------------

const STATUS_COPY: Record<DeviceStatusAction, { title: string; body: string; button: string; destructive: boolean; done: string }> = {
  suspend: {
    title: 'Suspend this payment point?',
    body: 'Customers who open its link will see that it is not available, and it cannot be given a new bill until you switch it on again.',
    button: 'Suspend',
    destructive: false,
    done: 'The payment point was suspended.',
  },
  reactivate: {
    title: 'Switch this payment point on again?',
    body: 'Its permanent link works again.',
    button: 'Switch on',
    destructive: false,
    done: 'The payment point is active again.',
  },
  revoke: {
    title: 'Revoke this payment point for good?',
    body: 'Its link stops working at once and this cannot be undone. Sales and history stay exactly as they were. A lost or copied tag should be revoked and replaced.',
    button: 'Revoke',
    destructive: true,
    done: 'The payment point was revoked.',
  },
}

export function DeviceStatusDialog({
  open,
  onOpenChange,
  device,
  action,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  device: EntryDevice
  action: DeviceStatusAction
}) {
  return (
    <Shell open={open} onOpenChange={onOpenChange}>
      <StatusForm device={device} action={action} onDone={() => onOpenChange(false)} />
    </Shell>
  )
}

function StatusForm({ device, action, onDone }: { device: EntryDevice; action: DeviceStatusAction; onDone: () => void }) {
  const { notify } = useToast()
  const change = useChangeDeviceStatus(device.id)
  const copy = STATUS_COPY[action]
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)
    if (reason.trim().length === 0) {
      setError('Write a short reason. It is kept with the change.')
      return
    }
    change.mutate(
      { action, input: { expectedVersion: device.version, reason: reason.trim() } },
      {
        onSuccess: () => {
          notify('success', copy.done)
          onDone()
        },
        onError: (e) => setError(describe(e, 'The change could not be made.')),
      },
    )
  }

  return (
    <form onSubmit={submit} noValidate>
      <DialogHeader>
        <DialogTitle>{copy.title}</DialogTitle>
        <DialogDescription>{copy.body}</DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-4">
        <ErrorAlert message={error} />
        <FormField label="Reason" required>
          {(props) => <Textarea {...props} value={reason} maxLength={MAX_REASON} onChange={(e) => setReason(e.target.value)} />}
        </FormField>
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>Cancel</Button>
        <Submit pending={change.isPending} label={copy.button} destructive={copy.destructive} />
      </DialogFooter>
    </form>
  )
}

// ---- give a bill ----------------------------------------------------------------------------------------------------

export function BindSaleDialog({ open, onOpenChange, device }: { open: boolean; onOpenChange: (open: boolean) => void; device: EntryDevice }) {
  return (
    <Shell open={open} onOpenChange={onOpenChange}>
      <BindForm device={device} onDone={() => onOpenChange(false)} />
    </Shell>
  )
}

function BindForm({ device, onDone }: { device: EntryDevice; onDone: () => void }) {
  const { notify } = useToast()
  const eligible = useEligibleSales(device.id)
  const bind = useBindSale(device.id)
  const [saleId, setSaleId] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)
    if (!saleId) {
      setError('Choose the bill this payment point should open.')
      return
    }
    bind.mutate(
      { saleId, expectedVersion: device.version },
      {
        onSuccess: () => {
          notify('success', 'The payment point now opens this bill. Nothing is paid by this step.')
          onDone()
        },
        onError: (e) => setError(describe(e, 'The bill could not be given to the payment point.')),
      },
    )
  }

  return (
    <form onSubmit={submit} noValidate>
      <DialogHeader>
        <DialogTitle>Give “{device.displayName}” a bill</DialogTitle>
        <DialogDescription>
          Choose one prepared bill. The payment point never picks one for itself, and giving it a bill creates no invoice and
          takes no payment.
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-3">
        <ErrorAlert message={error} />
        {eligible.isPending && (
          <p role="status" className="text-sm text-muted-foreground">Loading prepared bills…</p>
        )}
        {eligible.isError && <ErrorAlert message="The prepared bills could not be loaded." />}
        {eligible.data && eligible.data.length === 0 && (
          <p className="text-sm text-muted-foreground">
            There is no open bill for this branch{device.assignedCashierName ? ` and ${device.assignedCashierName}` : ''} right now. Prepare
            one in POS billing or Code checkout first.
          </p>
        )}
        {eligible.data && eligible.data.length > 0 && (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Prepared bills</legend>
            {eligible.data.map((sale) => (
              <label key={sale.saleId} className="flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm has-[:checked]:border-primary">
                <input type="radio" name="sale" className="mt-1" value={sale.saleId} checked={saleId === sale.saleId} onChange={() => setSaleId(sale.saleId)} />
                <span className="min-w-0">
                  <span className="block font-medium">{formatRwf(sale.amountRwf)} · {sale.saleReference}</span>
                  <span className="block text-muted-foreground">
                    {sale.description} · {sale.agentName} · {SALE_STATUS_LABELS[sale.status] ?? sale.status}
                    {sale.presentationMode === 'DEMONSTRATION' ? ' · DEMONSTRATION' : ''}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
        )}
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>Cancel</Button>
        <Submit pending={bind.isPending} label="Give this bill" />
      </DialogFooter>
    </form>
  )
}

// ---- close the current bill -----------------------------------------------------------------------------------------

export function UnbindSaleDialog({ open, onOpenChange, device }: { open: boolean; onOpenChange: (open: boolean) => void; device: EntryDevice }) {
  return (
    <Shell open={open} onOpenChange={onOpenChange}>
      <UnbindForm device={device} onDone={() => onOpenChange(false)} />
    </Shell>
  )
}

function UnbindForm({ device, onDone }: { device: EntryDevice; onDone: () => void }) {
  const { notify } = useToast()
  const unbind = useUnbindSale(device.id)
  const [reason, setReason] = useState('Customer finished')
  const [confirm, setConfirm] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const active = device.binding?.customerSessionActive ?? false

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)
    if (reason.trim().length === 0) {
      setError('Write a short reason.')
      return
    }
    unbind.mutate(
      { reason: reason.trim(), confirmActiveSession: confirm },
      {
        onSuccess: () => {
          notify('success', 'The payment point no longer opens that bill. The bill itself is untouched.')
          onDone()
        },
        onError: (e) => setError(describe(e, 'The bill could not be closed.')),
      },
    )
  }

  return (
    <form onSubmit={submit} noValidate>
      <DialogHeader>
        <DialogTitle>Stop opening this bill?</DialogTitle>
        <DialogDescription>
          The payment point goes idle. The bill {device.binding?.saleReference} stays exactly as it is and can still be paid with its code.
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-4">
        <ErrorAlert message={error} />
        {active && (
          <p role="status" className="rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-sm text-warning">
            A customer is looking at this bill right now. They keep seeing their own bill, but confirm before you close it.
          </p>
        )}
        <FormField label="Reason" required>
          {(props) => <Input {...props} value={reason} maxLength={MAX_REASON} onChange={(e) => setReason(e.target.value)} />}
        </FormField>
        {active && (
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
            <span>Close it anyway, although a customer is looking at it.</span>
          </label>
        )}
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>Cancel</Button>
        <Submit pending={unbind.isPending} label="Stop opening this bill" />
      </DialogFooter>
    </form>
  )
}
