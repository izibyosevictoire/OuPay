import { Construction } from 'lucide-react'
import { EmptyState } from '@/components/common/EmptyState'
import { PageHeader } from '@/components/common/PageHeader'
import { Card } from '@/components/ui/card'

interface ModulePlaceholderPageProps {
  title: string
  description: string
}

export function ModulePlaceholderPage({ title, description }: ModulePlaceholderPageProps) {
  return (
    <div className="space-y-4 sm:space-y-6">
      <PageHeader title={title} description={description} />
      <Card>
        <EmptyState
          icon={Construction}
          title={`${title} is coming soon`}
          description="This module is planned for a later release."
        />
      </Card>
    </div>
  )
}
