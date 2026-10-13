import { useFormContext, type UseFormReturn } from 'react-hook-form'
import { FormField } from '@/components/common/FormField'
import {
  RwandaLocationFields,
  type RwandaLocationFieldValues,
} from '@/components/common/RwandaLocationFields'
import { Input, Select } from '@/components/ui/input'
import type { OnboardingFormValues } from '../../merchantSchemas'

export function LocationStep() {
  const form = useFormContext<OnboardingFormValues>()
  const {
    register,
    formState: { errors },
  } = form

  return (
    <div className="space-y-4">
      <FormField label="Country" required>
        {(field) => (
          <Select {...field} {...register('country')}>
            <option value="RW">Rwanda</option>
          </Select>
        )}
      </FormField>
      {/* The shared selector only touches province, district and sector. */}
      <RwandaLocationFields form={form as unknown as UseFormReturn<RwandaLocationFieldValues>} />
      <FormField
        label="Physical address"
        required
        hint="Street, building or landmark where the business operates."
        error={errors.physicalAddress?.message}
      >
        {(field) => (
          <Input autoComplete="street-address" {...field} {...register('physicalAddress')} />
        )}
      </FormField>
    </div>
  )
}
