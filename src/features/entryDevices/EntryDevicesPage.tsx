import { ChevronDown, ChevronUp, Copy, Nfc, Plus, Printer, QrCode as QrIcon } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { EmptyState } from '@/components/common/EmptyState'
import { PageHeader } from '@/components/common/PageHeader'
import { QueryBoundary } from '@/components/common/QueryBoundary'
import { useToast } from '@/components/common/Toaster'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Select } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { usePermission } from '@/features/auth/permissions/usePermission'
import { formatDateTime, formatRwf } from '@/lib/format'
import { ENTRY_NFC_STEPS, buildEntryUrl, describeNdefUriRecord } from '@/lib/paymentLinks'
import { cn } from '@/lib/utils'
import type { EntryDevice, EntryDeviceStatus } from '@/types/entryDevices'
import {
  AssignDeviceDialog,
  BindSaleDialog,
  DeviceStatusDialog,
  RegisterDeviceDialog,
  UnbindSaleDialog,
} from './EntryDeviceDialogs'
import {
  BINDING_END_LABELS,
  DEVICE_STATUS_LABELS,
  DEVICE_STATUS_STYLES,
  DEVICE_TYPE_LABELS,
  SALE_STATUS_LABELS,
} from './entryDeviceLabels'
import {
  useDeviceAssignments,
  useDeviceBindings,
  useEntryDeviceOptions,
  useEntryDevices,
  type DeviceStatusAction,
} from './entryDeviceQueries'

type Dialog =
  | { kind: 'assign' | 'bind' | 'unbind'; device: EntryDevice }
  | { kind: 'status'; device: EntryDevice; action: DeviceStatusAction }
  | { kind: 'register' }
  | null

/**
 * Payment points: persistent static QR codes, NFC tags and bracelets. They are ENTRY methods only. Scanning or tapping opens the
 * prepared bill (never a payment); the bill is paid with the bank-approved collection code and confirmed only by the bank.
 */
export function EntryDevicesPage() {
  const [status, setStatus] = useState<EntryDeviceStatus | ''>('')
  const [dialog, setDialog] = useState<Dialog>(null)
  const devices = useEntryDevices(status || undefined)
  const optionsQuery = useEntryDeviceOptions()
  const manage = usePermission('entry_devices:manage')
  const close = (open: boolean) => !open && setDialog(null)

  return (
    <div className="space-y-4">
      <PageHeader
        title="Payment points"
        description="Static QR codes, NFC tags and bracelets that open the bill you prepared."
        actions={
          manage.isAllowed && (
            <Button onClick={() => setDialog({ kind: 'register' })} disabled={!optionsQuery.data}>
              <Plus aria-hidden="true" /> Register a payment point
            </Button>
          )
        }
      />

      <p className="rounded-lg border border-info/30 bg-info-soft px-4 py-3 text-sm text-info">
        A QR code or NFC tag only <strong>opens</strong> a bill. Scanning or tapping does not move
        money. The customer still pays with the bank-approved collection code shown on the bill, and
        a payment counts only after the bank confirms it.
      </p>

      <div className="max-w-xs">
        <label htmlFor="device-status" className="mb-1 block text-sm font-medium">
          Show
        </label>
        <Select
          id="device-status"
          className="min-h-11"
          value={status}
          onChange={(e) => setStatus(e.target.value as EntryDeviceStatus | '')}
        >
          <option value="">All payment points</option>
          <option value="ACTIVE">Active</option>
          <option value="SUSPENDED">Suspended</option>
          <option value="REVOKED">Revoked</option>
        </Select>
      </div>

      <QueryBoundary
        query={devices}
        loadingFallback={<Skeleton className="h-40 w-full" />}
        errorMessage="The payment points could not be loaded."
      >
        {(list) =>
          list.length === 0 ? (
            <Card>
              <EmptyState
                icon={Nfc}
                title="No payment points yet"
                description={
                  manage.isAllowed
                    ? 'Register a static QR code, an NFC tag or a bracelet for a counter.'
                    : 'Ask the owner or a manager to register one for you.'
                }
              />
            </Card>
          ) : (
            <ul className="space-y-3" aria-label="Payment points">
              {list.map((device) => (
                <li key={device.id}>
                  <DeviceCard device={device} canManage={manage.isAllowed} onDialog={setDialog} />
                </li>
              ))}
            </ul>
          )
        }
      </QueryBoundary>

      {dialog?.kind === 'register' && optionsQuery.data && (
        <RegisterDeviceDialog open onOpenChange={close} options={optionsQuery.data} />
      )}
      {dialog?.kind === 'assign' && optionsQuery.data && (
        <AssignDeviceDialog
          open
          onOpenChange={close}
          device={dialog.device}
          options={optionsQuery.data}
        />
      )}
      {dialog?.kind === 'status' && (
        <DeviceStatusDialog
          open
          onOpenChange={close}
          device={dialog.device}
          action={dialog.action}
        />
      )}
      {dialog?.kind === 'bind' && (
        <BindSaleDialog open onOpenChange={close} device={dialog.device} />
      )}
      {dialog?.kind === 'unbind' && (
        <UnbindSaleDialog open onOpenChange={close} device={dialog.device} />
      )}
    </div>
  )
}

function DeviceCard({
  device,
  canManage,
  onDialog,
}: {
  device: EntryDevice
  canManage: boolean
  onDialog: (dialog: Dialog) => void
}) {
  const { notify } = useToast()
  const bindPermission = usePermission('entry_devices:bind')
  const [showHistory, setShowHistory] = useState(false)
  const [showNfc, setShowNfc] = useState(false)
  const url = buildEntryUrl(device.entryPath)
  const live = device.status !== 'REVOKED'
  const Icon = device.deviceType === 'STATIC_QR' ? QrIcon : Nfc

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      notify('success', 'The permanent link was copied.')
    } catch {
      notify('error', 'Your browser blocked copying. Select the link and copy it manually.')
    }
  }

  return (
    <Card className="space-y-3 p-4" aria-label={`Payment point ${device.displayName}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-muted">
            <Icon className="size-4" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h2 className="break-words text-base font-semibold">{device.displayName}</h2>
            <p className="text-sm text-muted-foreground">
              {DEVICE_TYPE_LABELS[device.deviceType]} · {device.branchName} ·{' '}
              {device.assignedCashierName ? device.assignedCashierName : 'shared counter'}
            </p>
          </div>
        </div>
        <span
          className={cn(
            'rounded-full px-2.5 py-0.5 text-xs font-medium',
            DEVICE_STATUS_STYLES[device.status],
          )}
        >
          {DEVICE_STATUS_LABELS[device.status]}
        </span>
      </div>

      {device.statusReason && device.status !== 'ACTIVE' && (
        <p className="text-xs text-muted-foreground">Reason: {device.statusReason}</p>
      )}

      {live && (
        <div className="space-y-1">
          <label htmlFor={`url-${device.id}`} className="block text-xs text-muted-foreground">
            Permanent link (the same for the QR code and the NFC tag)
          </label>
          <div className="flex gap-2">
            <input
              id={`url-${device.id}`}
              readOnly
              value={url}
              className="h-11 min-w-0 flex-1 rounded-md border border-input bg-muted px-3 text-sm"
              onFocus={(e) => e.currentTarget.select()}
            />
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={() => void copy()}
              aria-label={`Copy the link of ${device.displayName}`}
            >
              <Copy aria-hidden="true" /> Copy
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            This link identifies the payment point, not a bill: it never changes. Each bill has its
            own sale reference (OP-…).
          </p>
        </div>
      )}

      <BindingPanel device={device} />

      <div className="flex flex-wrap gap-2">
        {live && (
          <Button asChild variant="outline" size="sm" className="min-h-11 sm:min-h-9">
            <Link to={`/entry-devices/${device.id}/print`}>
              <Printer aria-hidden="true" /> Print QR code
            </Link>
          </Button>
        )}
        {device.status === 'ACTIVE' && bindPermission.isAllowed && !device.binding && (
          <Button
            size="sm"
            className="min-h-11 sm:min-h-9"
            onClick={() => onDialog({ kind: 'bind', device })}
          >
            Give a bill
          </Button>
        )}
        {device.binding && bindPermission.isAllowed && (
          <Button
            size="sm"
            variant="outline"
            className="min-h-11 sm:min-h-9"
            onClick={() => onDialog({ kind: 'unbind', device })}
          >
            Stop opening this bill
          </Button>
        )}
        {canManage && live && (
          <Button
            size="sm"
            variant="outline"
            className="min-h-11 sm:min-h-9"
            onClick={() => onDialog({ kind: 'assign', device })}
          >
            Change branch or cashier
          </Button>
        )}
        {canManage && device.status === 'ACTIVE' && (
          <Button
            size="sm"
            variant="outline"
            className="min-h-11 sm:min-h-9"
            onClick={() => onDialog({ kind: 'status', device, action: 'suspend' })}
          >
            Suspend
          </Button>
        )}
        {canManage && device.status === 'SUSPENDED' && (
          <Button
            size="sm"
            variant="outline"
            className="min-h-11 sm:min-h-9"
            onClick={() => onDialog({ kind: 'status', device, action: 'reactivate' })}
          >
            Switch on
          </Button>
        )}
        {canManage && live && (
          <Button
            size="sm"
            variant="outline"
            className="min-h-11 text-danger sm:min-h-9"
            onClick={() => onDialog({ kind: 'status', device, action: 'revoke' })}
          >
            Revoke
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="min-h-11 sm:min-h-9"
          aria-expanded={showHistory}
          onClick={() => setShowHistory((v) => !v)}
        >
          History{' '}
          {showHistory ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
        </Button>
        {live && device.deviceType !== 'STATIC_QR' && (
          <Button
            size="sm"
            variant="ghost"
            className="min-h-11 sm:min-h-9"
            aria-expanded={showNfc}
            onClick={() => setShowNfc((v) => !v)}
          >
            Writing the NFC tag{' '}
            {showNfc ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
          </Button>
        )}
      </div>

      {showNfc && <NfcInstructions url={url} />}
      {showHistory && <History device={device} />}
    </Card>
  )
}

function BindingPanel({ device }: { device: EntryDevice }) {
  const binding = device.binding
  if (!binding) {
    return (
      <p className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
        {device.status === 'ACTIVE'
          ? 'Idle: no bill is open here. Customers who scan see that nothing is ready.'
          : 'This payment point opens nothing for customers right now.'}
      </p>
    )
  }
  return (
    <div className="space-y-1 rounded-md border px-3 py-2 text-sm" aria-label="Current bill">
      <p className="font-medium">
        Opens bill {binding.saleReference} · {formatRwf(binding.amountRwf)}
        {binding.presentationMode === 'DEMONSTRATION' && ' · DEMONSTRATION'}
      </p>
      <p className="text-muted-foreground">
        {binding.description} · {binding.agentName} ·{' '}
        {SALE_STATUS_LABELS[binding.saleStatus] ?? binding.saleStatus}
      </p>
      <p
        role="status"
        className={cn(
          'text-xs',
          binding.customerSessionActive ? 'font-medium text-warning' : 'text-muted-foreground',
        )}
      >
        {binding.customerSessionActive
          ? `BUSY: a customer is looking at this bill right now. Their session ends at ${binding.sessionExpiresAt ? formatDateTime(binding.sessionExpiresAt) : 'a few minutes from now'} unless they continue. Anyone else who scans sees "Payment in progress".`
          : 'Ready: no customer has taken this bill at the moment.'}
      </p>
    </div>
  )
}

function History({ device }: { device: EntryDevice }) {
  const assignments = useDeviceAssignments(device.id)
  const bindings = useDeviceBindings(device.id)
  return (
    <div className="grid gap-4 border-t pt-3 text-sm sm:grid-cols-2">
      <section aria-label="Assignment history">
        <h3 className="mb-1 font-medium">Branch and cashier history</h3>
        {assignments.isPending && <p role="status">Loading…</p>}
        {assignments.isError && <p role="alert">The history could not be loaded.</p>}
        <ul className="space-y-1.5">
          {assignments.data?.map((a) => (
            <li key={a.id} className="text-muted-foreground">
              {a.branchName} · {a.assignedCashierName ?? 'shared counter'}
              <br />
              <span className="text-xs">
                {formatDateTime(a.validFrom)} → {a.validTo ? formatDateTime(a.validTo) : 'now'} · by{' '}
                {a.assignedBy}
                {a.reason ? ` · ${a.reason}` : ''}
              </span>
            </li>
          ))}
        </ul>
      </section>
      <section aria-label="Bill history">
        <h3 className="mb-1 font-medium">Bills it has opened</h3>
        {bindings.isPending && <p role="status">Loading…</p>}
        {bindings.isError && <p role="alert">The history could not be loaded.</p>}
        {bindings.data?.length === 0 && <p className="text-muted-foreground">None yet.</p>}
        <ul className="space-y-1.5">
          {bindings.data?.map((b) => (
            <li key={b.id} className="text-muted-foreground">
              {b.saleReference} · {formatRwf(b.amountRwf)} · {b.agentName}
              <br />
              <span className="text-xs">
                {formatDateTime(b.boundAt)} by {b.boundBy} →{' '}
                {b.endedAt
                  ? `${formatDateTime(b.endedAt)} (${BINDING_END_LABELS[b.endReason ?? ''] ?? b.endReason})`
                  : 'still open'}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}

function NfcInstructions({ url }: { url: string }) {
  const ndef = describeNdefUriRecord(url)
  return (
    <div className="space-y-2 border-t pt-3 text-sm">
      <p>
        Write <strong>one</strong> NDEF record ({ndef.recordType}) containing exactly this link,
        about {ndef.payloadBytes} bytes. The QR code of this payment point carries the same string.
      </p>
      <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
        {ENTRY_NFC_STEPS.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  )
}
