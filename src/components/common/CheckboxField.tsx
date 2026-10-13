import { useId, type InputHTMLAttributes, type ReactNode, forwardRef } from 'react'

interface CheckboxFieldProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'type' | 'children'
> {
  label: ReactNode
  error?: string
}

/** Checkbox with a large click target; the error is announced with the control. */
export const CheckboxField = forwardRef<HTMLInputElement, CheckboxFieldProps>(
  ({ label, error, ...inputProps }, ref) => {
    const id = useId()
    const errorId = `${id}-error`
    return (
      <div className="space-y-1">
        <label htmlFor={id} className="flex min-h-10 cursor-pointer items-start gap-3 text-sm">
          <input
            ref={ref}
            id={id}
            type="checkbox"
            aria-invalid={Boolean(error)}
            aria-describedby={error ? errorId : undefined}
            className="mt-0.5 size-5 shrink-0 rounded border-input accent-primary"
            {...inputProps}
          />
          <span>{label}</span>
        </label>
        {error && (
          <p id={errorId} className="text-xs font-medium text-danger">
            {error}
          </p>
        )}
      </div>
    )
  },
)
CheckboxField.displayName = 'CheckboxField'
