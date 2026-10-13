import { useFormContext, useWatch } from 'react-hook-form'
import { FormField } from '@/components/common/FormField'
import { Input, Select } from '@/components/ui/input'
import {
  BUSINESS_TYPE_LABELS,
  BUSINESS_TYPES,
  BUSINESS_TYPES_REQUIRING_REGISTRATION,
} from '@/constants/merchant'
import type { OnboardingFormValues } from '../../merchantSchemas'

export function BusinessDetailsStep() {
  const {
    register,
    control,
    formState: { errors },
  } = useFormContext<OnboardingFormValues>()
  const businessType = useWatch({ control, name: 'businessType' })
  const registrationExpected = BUSINESS_TYPES_REQUIRING_REGISTRATION.includes(businessType)

  return (
    <div className="space-y-4">
      <FormField label="Legal business name" required error={errors.legalName?.message}>
        {(field) => <Input autoComplete="organization" {...field} {...register('legalName')} />}
      </FormField>
      <FormField
        label="Trading name"
        hint="The name customers know you by, if different."
        error={errors.tradingName?.message}
      >
        {(field) => <Input {...field} {...register('tradingName')} />}
      </FormField>
      <FormField label="Business type" required error={errors.businessType?.message}>
        {(field) => (
          <Select {...field} {...register('businessType')} defaultValue="">
            <option value="" disabled>
              Select a business type
            </option>
            {BUSINESS_TYPES.map((type) => (
              <option key={type} value={type}>
                {BUSINESS_TYPE_LABELS[type]}
              </option>
            ))}
          </Select>
        )}
      </FormField>
      <FormField
        label="Registration number"
        required={registrationExpected}
        hint={
          registrationExpected
            ? 'Issued when the business was registered.'
            : 'Not needed for individual or informal businesses.'
        }
        error={errors.registrationNumber?.message}
      >
        {(field) => (
          <Input autoCapitalize="characters" {...field} {...register('registrationNumber')} />
        )}
      </FormField>
      <FormField
        label="Tax Identification Number (TIN)"
        hint="9 digits. Leave blank if you do not have one yet."
        error={errors.tin?.message}
      >
        {(field) => <Input inputMode="numeric" maxLength={9} {...field} {...register('tin')} />}
      </FormField>
    </div>
  )
}
