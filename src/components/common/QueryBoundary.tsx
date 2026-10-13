import type { ReactNode } from 'react'
import { ErrorState } from './ErrorState'

interface QueryBoundaryProps<T> {
  query: { data: T | undefined; isPending: boolean; isError: boolean; refetch: () => unknown }
  loadingFallback: ReactNode
  errorMessage: string
  children: (data: T) => ReactNode
}

/** Renders loading and error states once so each widget only describes its success view. */
export function QueryBoundary<T>({
  query,
  loadingFallback,
  errorMessage,
  children,
}: QueryBoundaryProps<T>) {
  if (query.isPending) {
    return (
      <div role="status" aria-live="polite">
        <span className="sr-only">Loading</span>
        {loadingFallback}
      </div>
    )
  }
  if (query.isError || query.data === undefined) {
    return <ErrorState message={errorMessage} onRetry={() => void query.refetch()} />
  }
  return <>{children(query.data)}</>
}
