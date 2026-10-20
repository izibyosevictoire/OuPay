import { useId } from 'react'
import { OPERATING_MODE_DETAILS, OPERATING_MODES } from '@/constants/merchant'
import type { OperatingMode } from '@/types/merchant'

interface OperatingModeOptionsProps {
  value: OperatingMode
  onChange: (mode: OperatingMode) => void
  legend: string
  disabled?: boolean
  error?: string
}

/**
 * The two ways a business can work, explained in plain language. A native radio group, so keyboard
 * and screen-reader behaviour comes from the browser; each option is one large touch target.
 */
export function OperatingModeOptions({
  value,
  onChange,
  legend,
  disabled = false,
  error,
}: OperatingModeOptionsProps) {
  const groupName = useId()
  const errorId = `${groupName}-error`
  return (
    <fieldset
      disabled={disabled}
      aria-describedby={error ? errorId : undefined}
      className="min-w-0 space-y-2"
    >
      <legend className="mb-1.5 text-sm font-medium">{legend}</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        {OPERATING_MODES.map((mode) => {
          const details = OPERATING_MODE_DETAILS[mode]
          const descriptionId = `${groupName}-${mode}`
          return (
            <label
              key={mode}
              className="flex cursor-pointer gap-3 rounded-lg border p-3 has-[:checked]:border-primary has-[:checked]:bg-muted has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-70 sm:p-4"
            >
              <input
                type="radio"
                name={groupName}
                value={mode}
                checked={value === mode}
                onChange={() => onChange(mode)}
                aria-describedby={descriptionId}
                className="mt-1 size-5 shrink-0 accent-primary"
              />
              <span className="min-w-0">
                <span className="block text-sm font-semibold">{details.label}</span>
                <span id={descriptionId} className="mt-0.5 block text-sm text-muted-foreground">
                  {details.summary}
                </span>
                <ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-muted-foreground">
                  {details.points.map((point) => (
                    <li key={point}>{point}</li>
                  ))}
                </ul>
              </span>
            </label>
          )
        })}
      </div>
      {error && (
        <p id={errorId} className="text-xs font-medium text-danger">
          {error}
        </p>
      )}
    </fieldset>
  )
}
