import { AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface ErrorStateProps {
  message: string
  onRetry?: () => void
}

export function ErrorState({ message, onRetry }: ErrorStateProps) {
  return (
    <div role="alert" className="flex flex-col items-center gap-3 px-4 py-10 text-center">
      <span className="flex size-10 items-center justify-center rounded-full bg-danger-soft text-danger">
        <AlertCircle className="size-5" aria-hidden="true" />
      </span>
      <p className="text-sm font-medium">{message}</p>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  )
}
