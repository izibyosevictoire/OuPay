import { zodResolver } from '@hookform/resolvers/zod'
import { Loader2 } from 'lucide-react'
import { useForm } from 'react-hook-form'
import { FormField } from '@/components/common/FormField'
import { Button } from '@/components/ui/button'
import { CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { MerchantServiceError } from '@/services/merchantService'
import type { Merchant } from '@/types/merchant'
import {
  profileEditSchema,
  toUpdateMerchantInput,
  type ProfileEditFormValues,
} from '../merchantSchemas'
import { useUpdateMerchant } from '../useMerchantQueries'

interface ProfileEditFormProps {
  merchant: Merchant
  onCancel: () => void
  onSaved: () => void
}

export function ProfileEditForm({ merchant, onCancel, onSaved }: ProfileEditFormProps) {
  const updateMerchant = useUpdateMerchant(merchant.id)
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ProfileEditFormValues>({
    resolver: zodResolver(profileEditSchema),
    defaultValues: {
      tradingName: merchant.tradingName ?? '',
      physicalAddress: merchant.location.physicalAddress,
      contactName: merchant.contact.fullName,
      email: merchant.contact.email,
      phoneNumber: merchant.contact.phoneNumber,
    },
  })

  const save = handleSubmit(async (values) => {
    if (updateMerchant.isPending) return
    try {
      await updateMerchant.mutateAsync(toUpdateMerchantInput(values))
      onSaved()
    } catch {
      // The error is rendered from mutation state below.
    }
  })

  const errorMessage = updateMerchant.error
    ? updateMerchant.error instanceof MerchantServiceError
      ? updateMerchant.error.message
      : 'Your changes could not be saved. Please try again.'
    : null

  return (
    <CardContent>
      <form noValidate onSubmit={save} className="space-y-4" aria-label="Edit business details">
        <FormField label="Trading name" error={errors.tradingName?.message}>
          {(field) => <Input {...field} {...register('tradingName')} />}
        </FormField>
        <FormField label="Physical address" required error={errors.physicalAddress?.message}>
          {(field) => (
            <Input autoComplete="street-address" {...field} {...register('physicalAddress')} />
          )}
        </FormField>
        <FormField label="Contact name" required error={errors.contactName?.message}>
          {(field) => <Input autoComplete="name" {...field} {...register('contactName')} />}
        </FormField>
        <FormField label="Email address" required error={errors.email?.message}>
          {(field) => <Input type="email" autoComplete="email" {...field} {...register('email')} />}
        </FormField>
        <FormField
          label="Phone number"
          required
          hint="Rwandan mobile number, e.g. 0788 123 456."
          error={errors.phoneNumber?.message}
        >
          {(field) => (
            <Input type="tel" autoComplete="tel" {...field} {...register('phoneNumber')} />
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

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            type="button"
            variant="outline"
            onClick={onCancel}
            disabled={updateMerchant.isPending}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={updateMerchant.isPending}
            aria-busy={updateMerchant.isPending}
          >
            {updateMerchant.isPending && <Loader2 className="animate-spin" aria-hidden="true" />}
            {updateMerchant.isPending ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      </form>
    </CardContent>
  )
}
