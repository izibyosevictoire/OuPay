import { useState } from 'react'
import { CheckboxField } from '@/components/common/CheckboxField'
import { Button } from '@/components/ui/button'
import { formatDateTime } from '@/lib/format'
import type { KycApplication, KycRequirementDefinition } from '@/types/kyc'
import { applies, valuesOf } from './kycRules'

interface ConsentStepProps {
  definition: KycRequirementDefinition
  application: KycApplication
  busy: boolean
  /** Saves unsaved edits first, then records consent. */
  onConsent: () => void
  onSubmit: () => void
}

/** What will be submitted, the exact consent wording, and the two separate acts: consenting, then giving the application to OuPay. */
export function ConsentStep({
  definition,
  application,
  busy,
  onConsent,
  onSubmit,
}: ConsentStepProps) {
  const [agreed, setAgreed] = useState(false)
  const values = valuesOf(application.answers)
  const answers = new Map(application.answers.map((a) => [a.key, a]))
  const rows = definition.fields.filter((f) => applies(f.appliesWhen, values) && answers.has(f.key))
  const consent = application.consent
  const readiness = application.readiness

  return (
    <div className="space-y-6">
      <section aria-labelledby="review-heading" className="space-y-3">
        <h3 id="review-heading" className="text-sm font-semibold">
          Review what you are giving to OuPay
        </h3>
        <dl className="divide-y rounded-lg border text-sm">
          {rows.map((field) => {
            const answer = answers.get(field.key)
            return (
              <div key={field.key} className="grid gap-1 p-3 sm:grid-cols-3">
                <dt className="text-muted-foreground">{field.label}</dt>
                <dd className="break-words sm:col-span-2">
                  {field.sensitive
                    ? `Provided (protected, ${answer?.hint ?? ''})`
                    : (field.options?.find((o) => o.value === answer?.value)?.label ??
                      answer?.value)}
                </dd>
              </div>
            )
          })}
        </dl>
        {readiness.missingFields.length > 0 && (
          <p role="alert" className="text-sm text-danger">
            Some required information is missing. Go back to the earlier steps to complete it.
          </p>
        )}
        {readiness.blockingDocuments.length > 0 && (
          <p role="alert" className="text-sm text-danger">
            A document must be received as a file before this can be submitted, and marking it ready
            is not enough. Documents cannot be uploaded yet.
          </p>
        )}
        {readiness.outstandingDocuments.length > 0 && (
          <p className="text-sm text-muted-foreground">
            Documents still to provide later: {readiness.outstandingDocuments.length}. They cannot
            be uploaded yet.
          </p>
        )}
      </section>

      <section aria-labelledby="consent-heading" className="space-y-3">
        <h3 id="consent-heading" className="text-sm font-semibold">
          Consent
        </h3>
        <blockquote className="rounded-lg border bg-muted/40 p-4 text-sm">
          {definition.consent.text}
        </blockquote>
        {consent && (
          <p role="status" className="text-sm">
            {consent.current
              ? `Consent recorded by ${consent.consentingName} on ${formatDateTime(consent.givenAt)}.`
              : 'You changed information after consenting. Please consent again to the current information.'}
          </p>
        )}
        {!consent?.current && (
          <>
            <CheckboxField
              label="I have read this and I agree"
              checked={agreed}
              onChange={(event) => setAgreed(event.target.checked)}
            />
            <Button
              type="button"
              variant="outline"
              disabled={!agreed || busy || readiness.missingFields.length > 0}
              onClick={onConsent}
            >
              Give consent
            </Button>
          </>
        )}
      </section>

      <section aria-labelledby="submit-heading" className="space-y-3">
        <h3 id="submit-heading" className="text-sm font-semibold">
          Give your application to OuPay
        </h3>
        <p className="text-sm text-muted-foreground">
          This gives your application to OuPay for review. It does not send it to Equity, and it
          does not mean Equity has received or approved it.
        </p>
        <Button type="button" disabled={!readiness.canSubmit || busy} onClick={onSubmit}>
          Submit to OuPay
        </Button>
      </section>
    </div>
  )
}
