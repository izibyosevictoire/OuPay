import * as React from 'react'
import { cn } from '@/lib/utils'

const fieldClassName =
  'flex h-10 w-full rounded-md border border-input bg-card px-3 text-sm placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-70 aria-[invalid=true]:border-destructive'

const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type = 'text', ...props }, ref) => (
    <input ref={ref} type={type} className={cn(fieldClassName, className)} {...props} />
  ),
)
Input.displayName = 'Input'

/** Native select: best keyboard and screen-reader support, and the native picker on phones. */
const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, ...props }, ref) => (
    <select ref={ref} className={cn(fieldClassName, 'pr-8', className)} {...props} />
  ),
)
Select.displayName = 'Select'

const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(fieldClassName, 'h-auto min-h-20 py-2', className)}
    {...props}
  />
))
Textarea.displayName = 'Textarea'

export { Input, Select, Textarea }
