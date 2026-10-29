import { zodResolver } from '@hookform/resolvers/zod'
import { Loader2 } from 'lucide-react'
import { useRef, useState } from 'react'
import { useForm, useWatch } from 'react-hook-form'
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
import { COLLECTION_CODE_MAX_REASON, COLLECTION_CODE_MAX_LABEL } from '@/constants/collectionCodes'
import { CollectionCodeServiceError } from '@/services/collectionCodeService'
import type { CodeAssignment, CollectionCode, CollectionCodeOptions } from '@/types/collectionCodes'
import {
  useAssignCode,
  useDeactivateCode,
  useDeclareSubmission,
  useEndAssignment,
  useReassignCode,
  useRequestCode,
  useSuspendCode,
} from './collectionCodeQueries'
import {
  ASSIGNEE_DEFAULTS,
  REQUEST_CODE_DEFAULTS,
  assigneeSchema,
  reasonSchema,
  requestCodeSchema,
  requestSignature,
  submissionSchema,
  toAssigneeInput,
  type AssigneeFormValues,
  type ReasonFormValues,
  type RequestCodeFormValues,
  type SubmissionFormValues,
} from './collectionCodeSchemas'

/** A message a person can act on, whatever went wrong. A stale version or assignment tells them to reload. */
function describeError(error: unknown, fallback: string): string {
  if (error instanceof CollectionCodeServiceError) {
    if (error.code === 'version_conflict' || error.code === 'assignment_changed') {
      return `${error.message} Close this window, open the code again to see its latest state, and retry.`
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

function SubmitButton({
  pending,
  label,
  pendingLabel,
  destructive = false,
}: {
  pending: boolean
  label: string
  pendingLabel: string
  destructive?: boolean
}) {
  return (
    <Button
      type="submit"
      className={
        destructive
          ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
          : undefined
      }
      disabled={pending}
      aria-busy={pending}
    >
      {pending && <Loader2 className="animate-spin" aria-hidden="true" />}
      {pending ? pendingLabel : label}
    </Button>
  )
}

interface DialogShellProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  children: React.ReactNode
}

/** Mounted only while open, so every opening starts with fresh values (and a fresh request identity). */
function DialogShell({ open, onOpenChange, children }: DialogShellProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>{children}</DialogContent>
    </Dialog>
  )
}

// ---- request a code ----------------------------------------------------------------------------------------------

interface RequestCodeDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  options: CollectionCodeOptions
}

export function RequestCodeDialog({ open, onOpenChange, options }: RequestCodeDialogProps) {
  return (
    <DialogShell open={open} onOpenChange={onOpenChange}>
      <RequestCodeForm options={options} onDone={() => onOpenChange(false)} />
    </DialogShell>
  )
}

function RequestCodeForm({
  options,
  onDone,
}: {
  options: CollectionCodeOptions
  onDone: () => void
}) {
  const { notify } = useToast()
  const request = useRequestCode()
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const usable = options.destinations.filter((d) => d.connectionStatus === 'CONNECTED')
  const form = useForm<RequestCodeFormValues>({
    resolver: zodResolver(requestCodeSchema),
    defaultValues: {
      ...REQUEST_CODE_DEFAULTS,
      settlementDestinationId: usable.length === 1 ? (usable[0]?.id ?? '') : '',
    },
  })
  const {
    register,
    handleSubmit,
    control,
    formState: { errors, isSubmitting },
  } = form
  const destinationId = useWatch({ control, name: 'settlementDestinationId' })
  const destination = options.destinations.find((d) => d.id === destinationId)

  /** ONE identity per submission attempt: a retry re-sends it, so it can never create a second request. */
  const identity = useRef<{ id: string; signature: string } | null>(null)
  const identityFor = (values: RequestCodeFormValues) => {
    const signature = requestSignature(values)
    if (!identity.current || identity.current.signature !== signature) {
      identity.current = { id: crypto.randomUUID(), signature }
    }
    return identity.current.id
  }

  const onValid = async (values: RequestCodeFormValues) => {
    setErrorMessage(null)
    try {
      const result = await request.mutateAsync({
        clientOperationId: identityFor(values),
        settlementDestinationId: values.settlementDestinationId,
        displayLabel: values.displayLabel.trim(),
        ...(values.branchId ? { branchId: values.branchId } : {}),
      })
      notify(
        'success',
        result.replayed
          ? 'That request was already recorded, so nothing new was created.'
          : 'Code request recorded in OuPay. Nothing has been sent to Equity.',
      )
      onDone()
    } catch (error) {
      setErrorMessage(
        describeError(
          error,
          'The request could not be recorded. You can try again: the same request will not be created twice.',
        ),
      )
    }
  }

  return (
    <form
      noValidate
      aria-label="Request a collection code"
      onSubmit={(event) => {
        void handleSubmit(onValid)(event)
      }}
      className="flex max-h-[90dvh] min-h-0 flex-col overflow-hidden"
    >
      <DialogHeader>
        <DialogTitle>Request a collection code</DialogTitle>
        <DialogDescription>
          This records a request inside OuPay. It does not contact Equity and it does not create a
          bank code. A code only becomes usable once the bank has approved it.
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain">
        <FormField
          label="Label"
          required
          hint={`For your team, for example “Remera counter”. Up to ${COLLECTION_CODE_MAX_LABEL} characters.`}
          error={errors.displayLabel?.message}
        >
          {(field) => <Input autoComplete="off" {...field} {...register('displayLabel')} />}
        </FormField>
        <FormField
          label="Settlement account"
          required
          hint="The merchant’s own account that the money settles into."
          error={errors.settlementDestinationId?.message}
        >
          {(field) => (
            <Select {...field} {...register('settlementDestinationId')}>
              <option value="">Choose…</option>
              {options.destinations.map((d) => (
                <option key={d.id} value={d.id} disabled={d.connectionStatus !== 'CONNECTED'}>
                  {d.label} {d.maskedAccount}
                  {d.simulated ? ' (simulated)' : ''}
                  {d.connectionStatus !== 'CONNECTED' ? ' (not connected)' : ''}
                </option>
              ))}
            </Select>
          )}
        </FormField>
        {destination?.simulated && (
          <p className="text-xs text-warning">
            This is a simulated demo account, so a code on it can never be live.
          </p>
        )}
        <FormField
          label="Branch"
          hint="Optional. Leave empty for a collection point that is not tied to one branch."
          error={errors.branchId?.message}
        >
          {(field) => (
            <Select {...field} {...register('branchId')}>
              <option value="">No specific branch</option>
              {options.branches
                .filter((b) => b.status === 'ACTIVE')
                .map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name} ({b.code})
                  </option>
                ))}
            </Select>
          )}
        </FormField>
        <ErrorAlert message={errorMessage} />
      </DialogBody>
      <DialogFooter className="shrink-0">
        <Button type="button" variant="outline" onClick={onDone} disabled={isSubmitting}>
          Cancel
        </Button>
        <SubmitButton pending={isSubmitting} label="Record request" pendingLabel="Recording…" />
      </DialogFooter>
    </form>
  )
}

// ---- assign / reassign -------------------------------------------------------------------------------------------

interface AssigneeDialogProps {
  mode: 'assign' | 'reassign'
  code: CollectionCode
  assignment: CodeAssignment | null
  options: CollectionCodeOptions
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function AssigneeDialog({ open, onOpenChange, ...rest }: AssigneeDialogProps) {
  return (
    <DialogShell open={open} onOpenChange={onOpenChange}>
      <AssigneeForm {...rest} onDone={() => onOpenChange(false)} />
    </DialogShell>
  )
}

function AssigneeForm({
  mode,
  code,
  assignment,
  options,
  onDone,
}: Omit<AssigneeDialogProps, 'open' | 'onOpenChange'> & { onDone: () => void }) {
  const { notify } = useToast()
  const assign = useAssignCode(code.id)
  const reassign = useReassignCode(code.id)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const form = useForm<AssigneeFormValues>({
    resolver: zodResolver(assigneeSchema),
    defaultValues: { ...ASSIGNEE_DEFAULTS, branchId: code.branchId ?? '' },
  })
  const {
    register,
    handleSubmit,
    control,
    formState: { errors, isSubmitting },
  } = form
  const kind = useWatch({ control, name: 'assigneeKind' })
  const branchId = useWatch({ control, name: 'branchId' })
  const branchLocked = code.branchId !== null
  const effectiveBranch = branchLocked ? code.branchId : branchId || null
  // Only people who work at the code's branch can hold it; with no branch, any active member.
  const eligible = options.members.filter(
    (member) => !effectiveBranch || member.branchIds.includes(effectiveBranch),
  )

  const onValid = async (values: AssigneeFormValues) => {
    setErrorMessage(null)
    if (mode === 'reassign' && !values.reason) {
      setErrorMessage('Give a reason for replacing the current agent.')
      return
    }
    try {
      if (mode === 'assign') {
        await assign.mutateAsync(toAssigneeInput(values))
        notify('success', 'The code was assigned.')
      } else {
        await reassign.mutateAsync({
          ...toAssigneeInput(values),
          expectedAssignmentId: assignment?.id ?? '',
          reason: values.reason,
        })
        notify(
          'success',
          'The code was reassigned. The previous assignment is kept in the history.',
        )
      }
      onDone()
    } catch (error) {
      setErrorMessage(
        describeError(error, 'The assignment could not be saved. Nothing was changed.'),
      )
    }
  }

  const title = mode === 'assign' ? 'Assign this code' : 'Reassign this code'
  return (
    <form
      noValidate
      aria-label={title}
      onSubmit={(event) => {
        void handleSubmit(onValid)(event)
      }}
      className="flex max-h-[90dvh] min-h-0 flex-col overflow-hidden"
    >
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          {mode === 'assign'
            ? `Give “${code.displayLabel}” to a team member or a collection point.`
            : `Replace the current holder of “${code.displayLabel}”. The previous assignment ends now and stays in the history.`}
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain">
        <FormField label="Give it to" required>
          {(field) => (
            <Select {...field} {...register('assigneeKind')}>
              <option value="MEMBER">A team member</option>
              <option value="COLLECTION_POINT">A collection point</option>
            </Select>
          )}
        </FormField>
        {kind === 'MEMBER' ? (
          <FormField
            label="Team member"
            required
            hint={
              effectiveBranch
                ? 'Only active people assigned to this branch can hold the code.'
                : 'Only active members of this business can hold a code.'
            }
            error={errors.membershipId?.message}
          >
            {(field) => (
              <Select {...field} {...register('membershipId')}>
                <option value="">Choose…</option>
                {eligible.map((member) => (
                  <option key={member.membershipId} value={member.membershipId}>
                    {member.fullName} ({member.role.toLowerCase()})
                  </option>
                ))}
              </Select>
            )}
          </FormField>
        ) : (
          <FormField
            label="Collection point"
            required
            hint="A place rather than a person, for example “Market stall”."
            error={errors.collectionPointLabel?.message}
          >
            {(field) => (
              <Input autoComplete="off" {...field} {...register('collectionPointLabel')} />
            )}
          </FormField>
        )}
        {!branchLocked && (
          <FormField label="Branch" hint="Optional." error={errors.branchId?.message}>
            {(field) => (
              <Select {...field} {...register('branchId')}>
                <option value="">No specific branch</option>
                {options.branches
                  .filter((b) => b.status === 'ACTIVE')
                  .map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name} ({b.code})
                    </option>
                  ))}
              </Select>
            )}
          </FormField>
        )}
        {branchLocked && (
          <p className="text-xs text-muted-foreground">
            Branch: {code.branchName ?? 'this code’s branch'}. It is fixed for this code.
          </p>
        )}
        {mode === 'reassign' && (
          <FormField
            label="Reason"
            required
            hint={`Why the code is changing hands. Up to ${COLLECTION_CODE_MAX_REASON} characters.`}
            error={errors.reason?.message}
          >
            {(field) => <Textarea rows={2} {...field} {...register('reason')} />}
          </FormField>
        )}
        <ErrorAlert message={errorMessage} />
      </DialogBody>
      <DialogFooter className="shrink-0">
        <Button type="button" variant="outline" onClick={onDone} disabled={isSubmitting}>
          Cancel
        </Button>
        <SubmitButton
          pending={isSubmitting}
          label={mode === 'assign' ? 'Assign code' : 'Reassign code'}
          pendingLabel="Saving…"
        />
      </DialogFooter>
    </form>
  )
}

// ---- end assignment, suspend, deactivate -------------------------------------------------------------------------

export type ReasonAction = 'end' | 'suspend' | 'deactivate'

const REASON_COPY: Record<
  ReasonAction,
  { title: string; description: (code: CollectionCode) => string; submit: string; success: string }
> = {
  end: {
    title: 'Remove the current agent',
    description: (code) =>
      `The code “${code.displayLabel}” will have nobody assigned. The assignment stays in the history.`,
    submit: 'Remove agent',
    success: 'The assignment was ended.',
  },
  suspend: {
    title: 'Suspend this code',
    description: (code) =>
      `“${code.displayLabel}” will no longer count as an active code. Only the bank process can make it active again.`,
    submit: 'Suspend code',
    success: 'The code was suspended.',
  },
  deactivate: {
    title: 'Deactivate this code',
    description: (code) =>
      `“${code.displayLabel}” will be closed for good: it cannot be reassigned or reused, and any current agent is removed. The history stays.`,
    submit: 'Deactivate code',
    success: 'The code was deactivated.',
  },
}

interface ReasonDialogProps {
  action: ReasonAction
  code: CollectionCode
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ReasonDialog({ open, onOpenChange, ...rest }: ReasonDialogProps) {
  return (
    <DialogShell open={open} onOpenChange={onOpenChange}>
      <ReasonForm {...rest} onDone={() => onOpenChange(false)} />
    </DialogShell>
  )
}

function ReasonForm({
  action,
  code,
  onDone,
}: Omit<ReasonDialogProps, 'open' | 'onOpenChange'> & { onDone: () => void }) {
  const copy = REASON_COPY[action]
  const { notify } = useToast()
  const end = useEndAssignment(code.id)
  const suspend = useSuspendCode(code.id)
  const deactivate = useDeactivateCode(code.id)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const form = useForm<ReasonFormValues>({
    resolver: zodResolver(reasonSchema),
    defaultValues: { reason: '' },
  })
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = form

  const onValid = async ({ reason }: ReasonFormValues) => {
    setErrorMessage(null)
    try {
      if (action === 'end') {
        await end.mutateAsync({
          expectedAssignmentId: code.currentAssignment?.id ?? '',
          reason,
        })
      } else if (action === 'suspend') {
        await suspend.mutateAsync({ expectedVersion: code.version, reason })
      } else {
        await deactivate.mutateAsync({ expectedVersion: code.version, reason })
      }
      notify('success', copy.success)
      onDone()
    } catch (error) {
      setErrorMessage(describeError(error, 'That could not be saved. Nothing was changed.'))
    }
  }

  return (
    <form
      noValidate
      aria-label={copy.title}
      onSubmit={(event) => {
        void handleSubmit(onValid)(event)
      }}
      className="flex max-h-[90dvh] min-h-0 flex-col overflow-hidden"
    >
      <DialogHeader>
        <DialogTitle>{copy.title}</DialogTitle>
        <DialogDescription>{copy.description(code)}</DialogDescription>
      </DialogHeader>
      <DialogBody className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain">
        <FormField
          label="Reason"
          required
          hint={`Kept in the history. Up to ${COLLECTION_CODE_MAX_REASON} characters.`}
          error={errors.reason?.message}
        >
          {(field) => <Textarea rows={3} {...field} {...register('reason')} />}
        </FormField>
        <ErrorAlert message={errorMessage} />
      </DialogBody>
      <DialogFooter className="shrink-0">
        <Button type="button" variant="outline" onClick={onDone} disabled={isSubmitting}>
          Cancel
        </Button>
        <SubmitButton
          pending={isSubmitting}
          label={copy.submit}
          pendingLabel="Saving…"
          destructive={action !== 'end'}
        />
      </DialogFooter>
    </form>
  )
}

// ---- record that a request was made to the bank ----------------------------------------------------------------------

interface SubmissionDialogProps {
  code: CollectionCode
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function SubmissionDialog({ open, onOpenChange, code }: SubmissionDialogProps) {
  return (
    <DialogShell open={open} onOpenChange={onOpenChange}>
      <SubmissionForm code={code} onDone={() => onOpenChange(false)} />
    </DialogShell>
  )
}

function SubmissionForm({ code, onDone }: { code: CollectionCode; onDone: () => void }) {
  const { notify } = useToast()
  const declare = useDeclareSubmission(code.id)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const form = useForm<SubmissionFormValues>({
    resolver: zodResolver(submissionSchema),
    defaultValues: { bankRequestRef: '' },
  })
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = form

  const onValid = async ({ bankRequestRef }: SubmissionFormValues) => {
    setErrorMessage(null)
    try {
      await declare.mutateAsync({ expectedVersion: code.version, bankRequestRef })
      notify('success', 'Your declaration was recorded. Equity has not confirmed anything.')
      onDone()
    } catch (error) {
      setErrorMessage(describeError(error, 'That could not be saved. Nothing was changed.'))
    }
  }

  return (
    <form
      noValidate
      aria-label="Record a request made to the bank"
      onSubmit={(event) => {
        void handleSubmit(onValid)(event)
      }}
      className="flex max-h-[90dvh] min-h-0 flex-col overflow-hidden"
    >
      <DialogHeader>
        <DialogTitle>Record a request made to the bank</DialogTitle>
        <DialogDescription>
          Use this after you have asked Equity for this code yourself. OuPay stores the reference
          you give as your own declaration. It is not verified or confirmed by Equity, and it does
          not approve the code.
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain">
        <FormField
          label="Reference you were given (declared by you)"
          required
          hint="The reference, ticket or case number you were given. OuPay does not check it with Equity."
          error={errors.bankRequestRef?.message}
        >
          {(field) => <Input autoComplete="off" {...field} {...register('bankRequestRef')} />}
        </FormField>
        <ErrorAlert message={errorMessage} />
      </DialogBody>
      <DialogFooter className="shrink-0">
        <Button type="button" variant="outline" onClick={onDone} disabled={isSubmitting}>
          Cancel
        </Button>
        <SubmitButton pending={isSubmitting} label="Record my declaration" pendingLabel="Saving…" />
      </DialogFooter>
    </form>
  )
}
