import { Loader2 } from 'lucide-react'
import { useState } from 'react'
import { QueryBoundary } from '@/components/common/QueryBoundary'
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
import { Skeleton } from '@/components/ui/skeleton'
import { FINAL_CODE_STATUSES } from '@/constants/collectionCodes'
import { usePermission } from '@/features/auth/permissions/usePermission'
import { formatDateTime } from '@/lib/format'
import type { CodeAssignment, CollectionCode, CollectionCodeOptions } from '@/types/collectionCodes'
import { AssigneeDialog, ReasonDialog, SubmissionDialog, type ReasonAction } from './CodeDialogs'
import { AssigneeAttention, CodeFacts, CodeIdentity, CodeStatusBadge } from './CodeParts'
import { assigneeLabel, statusHint } from './codeLabels'
import { useAssignmentHistory, useCollectionCode } from './collectionCodeQueries'

type ActionDialog =
  | { kind: 'assign' | 'reassign' }
  | { kind: 'reason'; action: ReasonAction }
  | { kind: 'submission' }

interface CodeDetailsDialogProps {
  codeId: string
  options: CollectionCodeOptions | undefined
  onClose: () => void
}

/** One code in full: who it is, where it stands, who holds it now, who held it before, and what the person may do. */
export function CodeDetailsDialog({ codeId, options, onClose }: CodeDetailsDialogProps) {
  const query = useCollectionCode(codeId)
  const [action, setAction] = useState<ActionDialog | null>(null)

  return (
    <Dialog open onOpenChange={(open) => !open && !action && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Collection code</DialogTitle>
          <DialogDescription>
            A code is only a payment instruction once the bank has approved it and it shows as
            Active.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="max-h-[70dvh] space-y-5 overflow-y-auto overscroll-contain">
          <QueryBoundary
            query={query}
            loadingFallback={<Skeleton className="h-40 w-full" />}
            errorMessage="This code could not be loaded."
          >
            {(code) => (
              <>
                <CodeSummary code={code} />
                <ActionBar code={code} options={options} onAction={setAction} />
                <History codeId={code.id} />
                {action && options && (
                  <ActionDialogs
                    code={code}
                    options={options}
                    action={action}
                    onClose={() => setAction(null)}
                  />
                )}
              </>
            )}
          </QueryBoundary>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function CodeSummary({ code }: { code: CollectionCode }) {
  return (
    <section aria-label="Code details" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-lg font-semibold">{code.displayLabel}</h3>
        <CodeStatusBadge status={code.status} />
      </div>
      <p className="text-sm text-muted-foreground">{statusHint(code.status)}</p>
      <CodeIdentity code={code} />
      <CodeFacts code={code} />
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs text-muted-foreground">Settlement account</dt>
          <dd>
            {code.settlementAccountLabel} {code.settlementAccountMasked}
            {code.simulated ? ' (simulated)' : ''}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Branch</dt>
          <dd>
            {code.branchName ? `${code.branchName} (${code.branchCode})` : 'Not tied to a branch'}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Held by</dt>
          <dd>{assigneeLabel(code.currentAssignment)}</dd>
          {code.currentAssignment && (
            <dd className="text-xs text-muted-foreground">
              Since {formatDateTime(code.currentAssignment.validFrom)}
            </dd>
          )}
        </div>
        {code.bankRequestRef ? (
          <div>
            <dt className="text-xs text-muted-foreground">
              Request reference declared by the owner
            </dt>
            <dd className="font-mono">{code.bankRequestRef}</dd>
            <dd className="text-xs text-muted-foreground">
              Owner-declared and unverified. Equity has not confirmed it.
            </dd>
          </div>
        ) : (
          code.status === 'REQUEST_DECLARED' && (
            <div>
              <dt className="text-xs text-muted-foreground">Request declared by the owner</dt>
              <dd className="text-xs text-muted-foreground">
                Unverified. The reference is visible to owners only.
              </dd>
            </div>
          )
        )}
        {code.statusReason && (
          <div className="sm:col-span-2">
            <dt className="text-xs text-muted-foreground">Reason for this status</dt>
            <dd>{code.statusReason}</dd>
          </div>
        )}
      </dl>
      <AssigneeAttention assignment={code.currentAssignment} />
    </section>
  )
}

function ActionBar({
  code,
  options,
  onAction,
}: {
  code: CollectionCode
  options: CollectionCodeOptions | undefined
  onAction: (action: ActionDialog) => void
}) {
  const assign = usePermission('collection_codes:assign')
  const manage = usePermission('collection_codes:manage')
  const isFinal = FINAL_CODE_STATUSES.includes(code.status)
  // A manager acts only on codes tied to a branch (the server checks which branch); codes with no branch are the owner's.
  const mayAssign = assign.isAllowed && (assign.scope === 'all' || code.branchId !== null)
  const assignable =
    mayAssign &&
    ['REQUESTED', 'REQUEST_DECLARED', 'ACTIVE'].includes(code.status) &&
    Boolean(options)
  const open = code.currentAssignment

  const buttons: { label: string; action: ActionDialog; show: boolean }[] = [
    { label: 'Assign', action: { kind: 'assign' }, show: assignable && !open },
    { label: 'Reassign', action: { kind: 'reassign' }, show: assignable && Boolean(open) },
    {
      label: 'Remove agent',
      action: { kind: 'reason', action: 'end' },
      show: mayAssign && Boolean(open),
    },
    {
      label: 'Record a request made to the bank',
      action: { kind: 'submission' },
      show: manage.isAllowed && code.status === 'REQUESTED',
    },
    {
      label: 'Suspend',
      action: { kind: 'reason', action: 'suspend' },
      show: manage.isAllowed && code.status === 'ACTIVE',
    },
    {
      label: 'Deactivate',
      action: { kind: 'reason', action: 'deactivate' },
      show: manage.isAllowed && !isFinal,
    },
  ]
  const visible = buttons.filter((button) => button.show)
  if (visible.length === 0) {
    return (
      <p role="note" className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
        {isFinal
          ? 'This code is closed. It cannot be changed or reassigned.'
          : 'You can view this code. Owners provision codes, and owners and managers assign them.'}
      </p>
    )
  }
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label="Actions for this code">
      {visible.map((button) => (
        <Button
          key={button.label}
          variant="outline"
          size="sm"
          onClick={() => onAction(button.action)}
        >
          {button.label}
        </Button>
      ))}
    </div>
  )
}

function ActionDialogs({
  code,
  options,
  action,
  onClose,
}: {
  code: CollectionCode
  options: CollectionCodeOptions
  action: ActionDialog
  onClose: () => void
}) {
  const close = (open: boolean) => {
    if (!open) onClose()
  }
  if (action.kind === 'assign' || action.kind === 'reassign') {
    return (
      <AssigneeDialog
        mode={action.kind}
        code={code}
        assignment={code.currentAssignment}
        options={options}
        open
        onOpenChange={close}
      />
    )
  }
  if (action.kind === 'submission') {
    return <SubmissionDialog code={code} open onOpenChange={close} />
  }
  if (action.kind === 'reason') {
    return <ReasonDialog action={action.action} code={code} open onOpenChange={close} />
  }
  return null
}

function History({ codeId }: { codeId: string }) {
  const query = useAssignmentHistory(codeId)
  return (
    <section aria-label="Assignment history" className="space-y-2">
      <h3 className="text-sm font-semibold">Who has held this code</h3>
      <QueryBoundary
        query={query}
        loadingFallback={<Skeleton className="h-16 w-full" />}
        errorMessage="The assignment history could not be loaded."
      >
        {(data) => {
          const rows = data.pages.flatMap((page) => page.items)
          if (rows.length === 0) {
            return <p className="text-sm text-muted-foreground">Nobody has held this code yet.</p>
          }
          return (
            <>
              <ol className="divide-y rounded-md border">
                {rows.map((row) => (
                  <HistoryRow key={row.id} row={row} />
                ))}
              </ol>
              {query.hasNextPage && (
                <div className="flex justify-center">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void query.fetchNextPage()}
                    disabled={query.isFetchingNextPage}
                  >
                    {query.isFetchingNextPage && (
                      <Loader2 className="animate-spin" aria-hidden="true" />
                    )}
                    Load more history
                  </Button>
                </div>
              )}
            </>
          )
        }}
      </QueryBoundary>
      <p className="text-xs text-muted-foreground">
        Names, roles and branches are kept as they were when each assignment was made. Later staff
        changes never rewrite this history.
      </p>
    </section>
  )
}

function HistoryRow({ row }: { row: CodeAssignment }) {
  return (
    <li className="space-y-0.5 px-3 py-2 text-sm">
      <p className="font-medium">
        {assigneeLabel(row)}
        {row.branchName ? ` · ${row.branchName}` : ''}
      </p>
      <p className="text-xs text-muted-foreground">
        From {formatDateTime(row.validFrom)}{' '}
        {row.validTo ? `to ${formatDateTime(row.validTo)}` : '(current)'} · assigned by{' '}
        {row.assignedByName}
      </p>
      {row.validTo && (
        <p className="text-xs text-muted-foreground">
          Ended{row.endedByName ? ` by ${row.endedByName}` : ''}
          {row.endReason ? `: ${row.endReason}` : ''}
        </p>
      )}
      <AssigneeAttention assignment={row} />
    </li>
  )
}
