import { zodResolver } from '@hookform/resolvers/zod'
import { Loader2 } from 'lucide-react'
import { useState } from 'react'
import { useForm, type UseFormReturn } from 'react-hook-form'
import { FormField } from '@/components/common/FormField'
import {
  RwandaLocationFields,
  type RwandaLocationFieldValues,
} from '@/components/common/RwandaLocationFields'
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
import { Input, Select } from '@/components/ui/input'
import { BRANCH_STATUS_LABELS } from '@/constants/branch'
import { OrganizationServiceError } from '@/services/organizationService'
import type { Branch } from '@/types/branch'
import {
  BRANCH_CODE_HINT,
  BRANCH_FORM_DEFAULTS,
  branchFormSchema,
  branchToFormValues,
  toCreateBranchInput,
  toUpdateBranchInput,
  type BranchFormValues,
} from './branchSchemas'
import { useCreateBranch, useUpdateBranch } from './useBranchQueries'

interface BranchFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Present when editing; absent when creating. */
  branch?: Branch
}

export function BranchFormDialog({ open, onOpenChange, branch }: BranchFormDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {/* Mounted only while open, so every opening starts from fresh values. */}
        <BranchForm branch={branch} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}

function BranchForm({ branch, onDone }: { branch?: Branch; onDone: () => void }) {
  const isEditing = Boolean(branch)
  const { notify } = useToast()
  const createBranch = useCreateBranch()
  const updateBranch = useUpdateBranch(branch?.id ?? '')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const form = useForm<BranchFormValues>({
    resolver: zodResolver(branchFormSchema),
    defaultValues: branch ? branchToFormValues(branch) : BRANCH_FORM_DEFAULTS,
  })
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = form

  const submit = handleSubmit(async (values) => {
    setErrorMessage(null)
    try {
      if (branch) {
        await updateBranch.mutateAsync(toUpdateBranchInput(values))
        notify('success', `${values.name} was updated.`)
      } else {
        await createBranch.mutateAsync(toCreateBranchInput(values))
        notify('success', `${values.name} was created.`)
      }
      onDone()
    } catch (error) {
      if (error instanceof OrganizationServiceError && error.code === 'duplicate_branch_code') {
        setError('code', { message: error.message }, { shouldFocus: true })
      } else {
        setErrorMessage(
          error instanceof OrganizationServiceError
            ? error.message
            : 'The branch could not be saved. Please try again.',
        )
      }
    }
  })

  return (
    <form noValidate onSubmit={submit} aria-label={isEditing ? 'Edit branch' : 'Add branch'}>
      <DialogHeader>
        <DialogTitle>{isEditing ? 'Edit branch' : 'Add a branch'}</DialogTitle>
        <DialogDescription>
          {isEditing
            ? 'Update the branch details. Its ID never changes.'
            : 'Add a location where your business operates.'}
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-4">
        <FormField label="Branch name" required error={errors.name?.message}>
          {(field) => <Input {...field} {...register('name')} />}
        </FormField>
        <FormField
          label="Branch code"
          required
          hint={BRANCH_CODE_HINT}
          error={errors.code?.message}
        >
          {(field) => <Input autoCapitalize="characters" {...field} {...register('code')} />}
        </FormField>
        <RwandaLocationFields form={form as unknown as UseFormReturn<RwandaLocationFieldValues>} />
        <FormField label="Physical address" required error={errors.physicalAddress?.message}>
          {(field) => (
            <Input autoComplete="street-address" {...field} {...register('physicalAddress')} />
          )}
        </FormField>
        <FormField
          label="Contact phone"
          hint="Rwandan mobile number, e.g. 0788 123 456."
          error={errors.contactPhone?.message}
        >
          {(field) => <Input type="tel" inputMode="tel" {...field} {...register('contactPhone')} />}
        </FormField>
        {!isEditing && (
          <FormField
            label="Status"
            required
            hint="Inactive branches cannot receive staff assignments or new invoices."
            error={errors.status?.message}
          >
            {(field) => (
              <Select {...field} {...register('status')}>
                <option value="ACTIVE">{BRANCH_STATUS_LABELS.ACTIVE}</option>
                <option value="INACTIVE">{BRANCH_STATUS_LABELS.INACTIVE}</option>
              </Select>
            )}
          </FormField>
        )}
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
          {isSubmitting ? 'Saving…' : isEditing ? 'Save changes' : 'Add branch'}
        </Button>
      </DialogFooter>
    </form>
  )
}
