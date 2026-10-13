import { useFormContext } from 'react-hook-form'
import { FormField } from '@/components/common/FormField'
import { Input } from '@/components/ui/input'
import type { OnboardingFormValues } from '../../merchantSchemas'

export function ContactStep() {
  const {
    register,
    formState: { errors },
  } = useFormContext<OnboardingFormValues>()

  return (
    <div className="space-y-4">
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
          <Input
            type="tel"
            autoComplete="tel"
            inputMode="tel"
            {...field}
            {...register('phoneNumber')}
          />
        )}
      </FormField>
    </div>
  )
}
