import { DescriptionList } from '@/components/common/DescriptionList'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { BUSINESS_TYPE_LABELS } from '@/constants/merchant'
import type { Merchant } from '@/types/merchant'

/** Reduced view for roles with limited profile access: no registration numbers, TIN or banking. */
export function LimitedProfileSummary({ merchant }: { merchant: Merchant }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Business information</CardTitle>
        <CardDescription>Basic details shared with your role.</CardDescription>
      </CardHeader>
      <DescriptionList
        rows={[
          { label: 'Business name', value: merchant.tradingName ?? merchant.legalName },
          { label: 'Business type', value: BUSINESS_TYPE_LABELS[merchant.businessType] },
          { label: 'District', value: merchant.location.district },
          { label: 'Address', value: merchant.location.physicalAddress },
        ]}
      />
    </Card>
  )
}
