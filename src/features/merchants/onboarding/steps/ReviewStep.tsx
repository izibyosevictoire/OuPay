import { Pencil } from 'lucide-react'
import { useFormContext } from 'react-hook-form'
import { DescriptionList, type DescriptionRow } from '@/components/common/DescriptionList'
import { Button } from '@/components/ui/button'
import { BUSINESS_TYPE_LABELS, OPERATING_MODE_DETAILS } from '@/constants/merchant'
import { normalizeRwandanPhoneNumber, type OnboardingFormValues } from '../../merchantSchemas'

interface ReviewSectionProps {
  title: string
  stepIndex: number
  onEdit: (stepIndex: number) => void
  rows: DescriptionRow[]
}

function ReviewSection({ title, stepIndex, onEdit, rows }: ReviewSectionProps) {
  return (
    <section className="rounded-lg border">
      <div className="flex items-center justify-between border-b px-4 py-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        <Button variant="ghost" size="sm" type="button" onClick={() => onEdit(stepIndex)}>
          <Pencil aria-hidden="true" />
          Edit <span className="sr-only">{title.toLowerCase()}</span>
        </Button>
      </div>
      <DescriptionList rows={rows} />
    </section>
  )
}

export function ReviewStep({ onEdit }: { onEdit: (stepIndex: number) => void }) {
  const { getValues } = useFormContext<OnboardingFormValues>()
  const values = getValues()

  return (
    <div className="space-y-4">
      <ReviewSection
        title="Business details"
        stepIndex={0}
        onEdit={onEdit}
        rows={[
          { label: 'Legal business name', value: values.legalName },
          { label: 'Trading name', value: values.tradingName },
          { label: 'Business type', value: BUSINESS_TYPE_LABELS[values.businessType] },
          {
            label: 'How you will use OuPay',
            value: OPERATING_MODE_DETAILS[values.operatingMode].label,
          },
          { label: 'Registration number', value: values.registrationNumber },
          { label: 'TIN', value: values.tin },
        ]}
      />
      <ReviewSection
        title="Location"
        stepIndex={1}
        onEdit={onEdit}
        rows={[
          { label: 'Country', value: 'Rwanda' },
          { label: 'Province', value: values.province },
          { label: 'District', value: values.district },
          { label: 'Sector', value: values.sector },
          { label: 'Physical address', value: values.physicalAddress },
        ]}
      />
      <ReviewSection
        title="Primary contact"
        stepIndex={2}
        onEdit={onEdit}
        rows={[
          { label: 'Contact name', value: values.contactName },
          { label: 'Email address', value: values.email },
          { label: 'Phone number', value: normalizeRwandanPhoneNumber(values.phoneNumber) },
        ]}
      />
      <p className="text-xs text-muted-foreground">
        Submitting sends your details for review. Your business will show as pending verification
        and is not approved until that review is complete. Never share bank PINs or passwords.
      </p>
    </div>
  )
}
