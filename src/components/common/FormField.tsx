import { useId, type ReactNode } from 'react'

export interface FieldControlProps {
  id: string
  'aria-describedby'?: string
  'aria-invalid': boolean
  'aria-required': boolean
}

interface FormFieldProps {
  label: string
  error?: string
  hint?: string
  required?: boolean
  children: (controlProps: FieldControlProps) => ReactNode
}

/** Wires label, hint and error text to the control so screen readers announce them. */
export function FormField({ label, error, hint, required = false, children }: FormFieldProps) {
  const id = useId()
  const hintId = `${id}-hint`
  const errorId = `${id}-error`
  const describedBy = [hint && hintId, error && errorId].filter(Boolean).join(' ') || undefined

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
        {required ? (
          <span className="text-danger" aria-hidden="true">
            {' '}
            *
          </span>
        ) : (
          <span className="font-normal text-muted-foreground"> (optional)</span>
        )}
      </label>
      {children({
        id,
        'aria-describedby': describedBy,
        'aria-invalid': Boolean(error),
        'aria-required': required,
      })}
      {hint && (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-xs font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  )
}
