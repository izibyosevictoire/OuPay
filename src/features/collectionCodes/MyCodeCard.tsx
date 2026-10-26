import { KeyRound } from 'lucide-react'
import { EmptyState } from '@/components/common/EmptyState'
import { QueryBoundary } from '@/components/common/QueryBoundary'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { formatDateTime } from '@/lib/format'
import { CodeStatusBadge } from './CodeParts'
import { statusHint } from './codeLabels'
import { useMyCollectionCode } from './collectionCodeQueries'

/**
 * The signed-in person's OWN code. The server only sends a code value when the code is eligible for collection right now; this view never invents one, and
 * a code that is not eligible is described as exactly that.
 */
export function MyCodeCard({ onlyWhenAssigned = false }: { onlyWhenAssigned?: boolean }) {
  const query = useMyCollectionCode()
  if (onlyWhenAssigned && (query.isPending || query.isError || !query.data?.code)) return null
  return (
    <QueryBoundary
      query={query}
      loadingFallback={<Skeleton className="h-24 w-full" />}
      errorMessage="Your collection code could not be loaded."
    >
      {({ assignment, code }) => {
        if (!code || !assignment) {
          return (
            <Card className="p-4 sm:p-5">
              <EmptyState
                icon={KeyRound}
                title="No collection code is assigned to you"
                description="When your manager gives you a collection code, it appears here with its status."
              />
            </Card>
          )
        }
        return (
          <Card className="space-y-3 p-4 sm:p-5" aria-label="Your collection code">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-base font-semibold">Your collection code</h2>
              <CodeStatusBadge status={code.status} />
            </div>
            <p className="font-medium">{code.displayLabel}</p>
            <p className="text-sm text-muted-foreground">
              {code.branchName ? `${code.branchName} · ` : ''}
              Yours since {formatDateTime(assignment.validFrom)}
            </p>
            {code.payable && code.externalCode ? (
              <div>
                <p className="text-xs text-muted-foreground">
                  Your code (eligible for collection now)
                </p>
                <p className="font-mono text-lg font-semibold">{code.externalCode}</p>
              </div>
            ) : (
              <p className="text-sm font-medium">No code to give customers right now.</p>
            )}
            <p className="text-sm text-muted-foreground">{code.message}</p>
            <p className="text-xs text-muted-foreground">{statusHint(code.status)}</p>
            {code.simulated && (
              <p className="text-xs font-medium text-warning">Simulated: never a live code.</p>
            )}
          </Card>
        )
      }}
    </QueryBoundary>
  )
}
