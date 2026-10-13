import { Lock } from 'lucide-react'
import { DescriptionList } from '@/components/common/DescriptionList'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { BUSINESS_TYPE_LABELS } from '@/constants/merchant'
import type { Merchant } from '@/types/merchant'

/** Identity and registration data: read-only because changes need re-verification. */
export function RegistrationDetailsSection({ merchant }: { merchant: Merchant }) {
  const { location, registration } = merchant
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Registration details
          <Lock className="size-4 text-muted-foreground" aria-hidden="true" />
        </CardTitle>
        <CardDescription>
          These details are locked after registration. Contact support to request a change.
        </CardDescription>
      </CardHeader>
      <DescriptionList
        rows={[
          { label: 'Legal business name', value: merchant.legalName },
          { label: 'Business type', value: BUSINESS_TYPE_LABELS[merchant.businessType] },
          { label: 'Registration number', value: registration.registrationNumber },
          { label: 'TIN', value: registration.tin },
          { label: 'Country', value: 'Rwanda' },
          { label: 'Province', value: location.province },
          { label: 'District', value: location.district },
          { label: 'Sector', value: location.sector },
        ]}
      />
    </Card>
  )
}
