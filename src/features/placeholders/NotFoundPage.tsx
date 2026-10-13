import { SearchX } from 'lucide-react'
import { Link } from 'react-router-dom'
import { EmptyState } from '@/components/common/EmptyState'
import { PageHeader } from '@/components/common/PageHeader'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'

export function NotFoundPage() {
  return (
    <div className="space-y-4 sm:space-y-6">
      <PageHeader title="Page not found" />
      <Card>
        <EmptyState
          icon={SearchX}
          title="We could not find that page"
          description="The address may be mistyped or the page may have moved."
        />
        <div className="flex justify-center pb-8">
          <Button asChild variant="outline">
            <Link to="/">Back to dashboard</Link>
          </Button>
        </div>
      </Card>
    </div>
  )
}
