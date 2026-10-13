import { zodResolver } from '@hookform/resolvers/zod'
import { Loader2, MailCheck } from 'lucide-react'
import { useState } from 'react'
import { Controller, useForm } from 'react-hook-form'
import { Link } from 'react-router-dom'
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
import { BUSINESS_ROLE_LABELS } from '@/constants/auth'
import { getInvitableRoles } from '@/features/auth/permissions/staffPolicy'
import { useCurrentRole } from '@/features/auth/permissions/usePermission'
import { useBranches } from '@/features/branches/useBranchQueries'
import { OrganizationServiceError } from '@/services/organizationService'
import type { InvitableRole, StaffInvitation } from '@/types/staff'
import { BranchAssignmentPicker } from './BranchAssignmentPicker'
import { inviteStaffSchema, toInviteStaffInput, type InviteStaffFormValues } from './staffSchemas'
import { useInviteStaff } from './useStaffQueries'

export interface InviteDefaults {
  email?: string
  role?: InvitableRole
  branchIds?: string[]
}

interface InviteStaffDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  defaults?: InviteDefaults
}

export function InviteStaffDialog({ open, onOpenChange, defaults }: InviteStaffDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <InviteForm defaults={defaults} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}

function InviteForm({ defaults, onDone }: { defaults?: InviteDefaults; onDone: () => void }) {
  const actorRole = useCurrentRole()
  const invitableRoles = getInvitableRoles(actorRole)
  const branchesQuery = useBranches()
  const inviteStaff = useInviteStaff()
  const { notify } = useToast()
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [createdInvitation, setCreatedInvitation] = useState<StaffInvitation | null>(null)

  const {
    register,
    control,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<InviteStaffFormValues>({
    resolver: zodResolver(inviteStaffSchema),
    defaultValues: {
      email: defaults?.email ?? '',
      role: defaults?.role ?? invitableRoles[invitableRoles.length - 1] ?? 'CASHIER',
      branchIds: defaults?.branchIds ?? [],
      note: '',
    },
  })

  const submit = handleSubmit(async (values) => {
    setErrorMessage(null)
    try {
      const invitation = await inviteStaff.mutateAsync(toInviteStaffInput(values))
      notify('success', `Invitation created for ${invitation.email}.`)
      setCreatedInvitation(invitation)
    } catch (error) {
      if (error instanceof OrganizationServiceError && error.code === 'duplicate_invitation') {
        setError('email', { message: error.message }, { shouldFocus: true })
      } else {
        setErrorMessage(
          error instanceof OrganizationServiceError
            ? error.message
            : 'The invitation could not be sent. Please try again.',
        )
      }
    }
  })

  if (createdInvitation) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Invitation created</DialogTitle>
          <DialogDescription>
            {createdInvitation.email} is invited as{' '}
            {BUSINESS_ROLE_LABELS[createdInvitation.role].toLowerCase()}. Their membership stays
            invited until they accept.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          {createdInvitation.demoToken ? (
            <>
              <p className="flex items-start gap-2 rounded-md bg-info-soft px-3 py-2 text-sm text-info">
                <MailCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <span>
                  Demo mode: no email is sent. Open the demo invitation link to try accepting it.
                  Demo links are not secure.
                </span>
              </p>
              <Link
                to={`/accept-invitation/${createdInvitation.demoToken}`}
                className="block break-all rounded-sm text-sm font-medium text-primary underline"
              >
                Open demo invitation for {createdInvitation.email}
              </Link>
            </>
          ) : (
            <p className="flex items-start gap-2 rounded-md bg-info-soft px-3 py-2 text-sm text-info">
              <MailCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span>
                We emailed {createdInvitation.email} a single-use link. It expires in 7 days; you
                can send a new invitation at any time.
              </span>
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button onClick={onDone}>Done</Button>
        </DialogFooter>
      </>
    )
  }

  return (
    <form noValidate onSubmit={submit} aria-label="Invite staff">
      <DialogHeader>
        <DialogTitle>Invite staff</DialogTitle>
        <DialogDescription>
          They join as invited and only get access after accepting. You can change branches later.
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-4">
        <FormField label="Email address" required error={errors.email?.message}>
          {(field) => <Input type="email" autoComplete="off" {...field} {...register('email')} />}
        </FormField>
        <FormField
          label="Role"
          required
          hint={
            invitableRoles.length === 1
              ? 'Managers can invite cashiers. Owners invite managers.'
              : undefined
          }
          error={errors.role?.message}
        >
          {(field) => (
            <Select {...field} {...register('role')}>
              {invitableRoles.map((role) => (
                <option key={role} value={role}>
                  {BUSINESS_ROLE_LABELS[role]}
                </option>
              ))}
            </Select>
          )}
        </FormField>
        <Controller
          control={control}
          name="branchIds"
          render={({ field }) => (
            <BranchAssignmentPicker
              legend="Branch assignments (optional)"
              branches={branchesQuery.data ?? []}
              selectedBranchIds={field.value}
              onChange={field.onChange}
            />
          )}
        />
        <FormField
          label="Note"
          hint="Optional message shown with the invitation."
          error={errors.note?.message}
        >
          {(field) => <Textarea {...field} {...register('note')} />}
        </FormField>
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
        <Button type="button" variant="outline" onClick={onDone} disabled={isSubmitting}>
          Cancel
        </Button>
        <Button type="submit" disabled={isSubmitting} aria-busy={isSubmitting}>
          {isSubmitting && <Loader2 className="animate-spin" aria-hidden="true" />}
          {isSubmitting ? 'Sending…' : 'Send invitation'}
        </Button>
      </DialogFooter>
    </form>
  )
}
