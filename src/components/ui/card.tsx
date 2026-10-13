import * as React from 'react'
import { cn } from '@/lib/utils'

const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn('rounded-lg border bg-card text-card-foreground shadow-card', className)}
      {...props}
    />
  ),
)
Card.displayName = 'Card'

const CardHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex flex-col gap-1 p-4 pb-2 sm:p-5 sm:pb-3', className)} {...props} />
)

/** Renders an h2 by default so the page keeps one h1 and a clean outline. */
const CardTitle = ({
  className,
  as: Heading = 'h2',
  ...props
}: React.HTMLAttributes<HTMLHeadingElement> & { as?: 'h2' | 'h3' }) => (
  <Heading className={cn('text-card-title', className)} {...props} />
)

const CardDescription = ({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) => (
  <p className={cn('text-xs text-muted-foreground', className)} {...props} />
)

const CardContent = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('p-4 pt-2 sm:p-5 sm:pt-3', className)} {...props} />
)

export { Card, CardContent, CardDescription, CardHeader, CardTitle }
