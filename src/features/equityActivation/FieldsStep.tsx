import { useState } from 'react'
import { FormField } from '@/components/common/FormField'
import { Button } from '@/components/ui/button'
import { Input, Select } from '@/components/ui/input'
import type { KycAnswer, KycApplication, KycField, KycRequirementDefinition } from '@/types/kyc'
import { useRevealValue } from './kycQueries'
import { applies, valuesOf } from './kycRules'

interface FieldsStepProps {
  definition: KycRequirementDefinition
  application: KycApplication
  section: string
  edits: Record<string, string>
  errors: Record<string, string>
  onEdit: (key: string, value: string) => void
  /** Showing a saved protected value is offered only when the server enables a secured workflow. */
  revealAvailable: boolean
}

/** One section of the application: its fields, with required and optional items marked, and saved protected values shown only as hints. */
export function FieldsStep({
  definition,
  application,
  section,
  edits,
  errors,
  onEdit,
  revealAvailable,
}: FieldsStepProps) {
  const values = valuesOf(application.answers, edits)
  const answers = new Map(application.answers.map((answer) => [answer.key, answer]))
  const fields = definition.fields.filter(
    (f) => f.section === section && applies(f.appliesWhen, values),
  )
  return (
    <div className="space-y-5">
      {fields.map((field) => (
        <FieldInput
          key={field.key}
          field={field}
          answer={answers.get(field.key)}
          application={application}
          value={edits[field.key] ?? (field.sensitive ? '' : (answers.get(field.key)?.value ?? ''))}
          error={errors[field.key]}
          revealAvailable={revealAvailable}
          onChange={(value) => onEdit(field.key, value)}
        />
      ))}
    </div>
  )
}

interface FieldInputProps {
  field: KycField
  answer: KycAnswer | undefined
  application: KycApplication
  value: string
  error?: string
  revealAvailable: boolean
  onChange: (value: string) => void
}

function FieldInput({
  field,
  answer,
  application,
  value,
  error,
  revealAvailable,
  onChange,
}: FieldInputProps) {
  const reveal = useRevealValue()
  const [shown, setShown] = useState<string | null>(null)
  const [revealError, setRevealError] = useState<string | null>(null)
  const prefilled = answer?.source === 'PREFILL' && !field.sensitive && value === answer.value

  const show = async () => {
    setRevealError(null)
    try {
      const result = await reveal.mutateAsync({
        applicationId: application.id,
        fieldKey: field.key,
      })
      setShown(result.value)
    } catch (caught) {
      setRevealError(caught instanceof Error ? caught.message : 'The value could not be shown.')
    }
  }

  const hint = [
    field.help,
    prefilled && 'Filled in from your business registration. Check it is right.',
    field.sensitive &&
      answer?.hasValue &&
      `A value is saved (${answer.hint}). Type a new one to replace it.`,
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className="space-y-1.5">
      <FormField
        label={field.label}
        required={field.required}
        error={error}
        hint={hint || undefined}
      >
        {(control) =>
          field.type === 'CHOICE' ? (
            <Select
              {...control}
              name={field.key}
              value={value}
              onChange={(event) => onChange(event.target.value)}
            >
              <option value="">Choose…</option>
              {field.options?.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          ) : (
            <Input
              {...control}
              name={field.key}
              value={value}
              type={field.type === 'EMAIL' ? 'email' : field.type === 'PHONE' ? 'tel' : 'text'}
              autoComplete="off"
              spellCheck={false}
              maxLength={field.maxLength ?? 200}
              onChange={(event) => onChange(event.target.value)}
            />
          )
        }
      </FormField>
      {field.sensitive && answer?.hasValue && revealAvailable && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {shown === null ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void show()}
              disabled={reveal.isPending}
            >
              Show saved value
            </Button>
          ) : (
            <>
              <span
                className="rounded bg-muted px-2 py-1 font-mono"
                data-testid={`revealed-${field.key}`}
              >
                {shown}
              </span>
              <Button type="button" variant="outline" size="sm" onClick={() => setShown(null)}>
                Hide
              </Button>
            </>
          )}
          <span className="text-xs text-muted-foreground">
            Viewing a protected value is recorded.
          </span>
        </div>
      )}
      {revealError && (
        <p role="alert" className="text-xs font-medium text-danger">
          {revealError}
        </p>
      )}
    </div>
  )
}
