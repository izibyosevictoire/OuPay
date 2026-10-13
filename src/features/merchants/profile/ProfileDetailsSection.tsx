import { Pencil } from 'lucide-react'
import { useState } from 'react'
import { DescriptionList } from '@/components/common/DescriptionList'
import { Button } from '@/components/ui/button'
import { usePermission } from '@/features/auth/permissions/usePermission'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import type { Merchant } from '@/types/merchant'
import { ProfileEditForm } from './ProfileEditForm'

/** Editable trading, address and contact details, with a read view by default. */
export function ProfileDetailsSection({ merchant }: { merchant: Merchant }) {
  const [isEditing, setIsEditing] = useState(false)
  const [savedNotice, setSavedNotice] = useState(false)
  const { isAllowed: canEdit } = usePermission('profile:edit')
  const isLocked = merchant.status === 'suspended'

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div>
          <CardTitle>Business and contact details</CardTitle>
          <CardDescription>
            {!canEdit
              ? 'Only a business owner can edit these details.'
              : isLocked
                ? 'Editing is disabled while the business is suspended.'
                : 'You can update these details at any time.'}
          </CardDescription>
        </div>
        {!isEditing && canEdit && (
          <Button
            variant="outline"
            size="sm"
            disabled={isLocked}
            onClick={() => {
              setSavedNotice(false)
              setIsEditing(true)
            }}
          >
            <Pencil aria-hidden="true" />
            Edit <span className="sr-only">business and contact details</span>
          </Button>
        )}
      </CardHeader>

      {savedNotice && !isEditing && (
        <p
          role="status"
          className="mx-4 mb-2 rounded-md bg-success-soft px-3 py-2 text-sm text-success sm:mx-5"
        >
          Changes saved.
        </p>
      )}

      {isEditing ? (
        <ProfileEditForm
          merchant={merchant}
          onCancel={() => setIsEditing(false)}
          onSaved={() => {
            setIsEditing(false)
            setSavedNotice(true)
          }}
        />
      ) : (
        <DescriptionList
          rows={[
            { label: 'Trading name', value: merchant.tradingName },
            { label: 'Physical address', value: merchant.location.physicalAddress },
            { label: 'Contact name', value: merchant.contact.fullName },
            { label: 'Email address', value: merchant.contact.email },
            { label: 'Phone number', value: merchant.contact.phoneNumber },
          ]}
        />
      )}
    </Card>
  )
}
