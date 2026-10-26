import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { formatDateTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { KycApplication, KycInformationRequest, KycRequirementDefinition } from '@/types/kyc'
import { useRespond } from './kycQueries'
import { describeKycStatus } from './kycRules'

const TONE = {
  neutral: 'border-border bg-muted text-foreground',
  info: 'border-info/30 bg-info-soft text-info',
  warning: 'border-warning/30 bg-warning-soft text-warning',
  success: 'border-success/30 bg-success-soft text-success',
  danger: 'border-danger/30 bg-danger-soft text-danger',
} as const

/** Where the application stands, in words that never claim more than is recorded, and the bank's requests for information. */
export function StatusStep({
  application,
  definition,
}: {
  application: KycApplication
  definition: KycRequirementDefinition
}) {
  const wording = describeKycStatus(application.status, application.decisionReason)
  const open = application.informationRequests.filter((r) => r.status === 'OPEN')
  const labelOf = (key: string | null) =>
    definition.fields.find((f) => f.key === key)?.label ?? null
  return (
    <div className="space-y-6">
      <div
        role="status"
        data-status={application.status}
        className={cn('rounded-lg border px-4 py-3', TONE[wording.tone])}
      >
        <p className="text-base font-semibold">{wording.label}</p>
        <p className="mt-1 text-sm">{wording.explanation}</p>
      </div>
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <Fact label="Started" value={formatDateTime(application.createdAt)} />
        {application.submittedAt && (
          <Fact label="Submitted to OuPay" value={formatDateTime(application.submittedAt)} />
        )}
        {application.handedOffAt && (
          <Fact
            label="Handed to Equity (recorded)"
            value={formatDateTime(application.handedOffAt)}
          />
        )}
        {application.decidedAt && (
          <Fact label="Decision recorded" value={formatDateTime(application.decidedAt)} />
        )}
        <Fact
          label="Requirement list version"
          value={`Version ${application.requirementSetVersion}`}
        />
      </dl>

      {application.informationRequests.length > 0 && (
        <section aria-labelledby="requests-heading" className="space-y-3">
          <h3 id="requests-heading" className="text-sm font-semibold">
            Information requested
          </h3>
          {open.length > 0 && (
            <p className="text-sm text-muted-foreground">
              Answer each request to send your reply back to OuPay.
            </p>
          )}
          <ul className="space-y-3">
            {application.informationRequests.map((request) => (
              <RequestItem
                key={request.id}
                request={request}
                applicationId={application.id}
                fieldLabel={labelOf(request.fieldKey)}
              />
            ))}
          </ul>
        </section>
      )}

      {application.readiness.outstandingDocuments.length > 0 && application.status !== 'DRAFT' && (
        <section aria-labelledby="outstanding-heading" className="space-y-2">
          <h3 id="outstanding-heading" className="text-sm font-semibold">
            Documents OuPay still needs
          </h3>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {application.documents
              .filter((d) => application.readiness.outstandingDocuments.includes(d.key))
              .map((d) => (
                <li key={d.key}>{d.label}</li>
              ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            Documents cannot be uploaded yet. OuPay will tell you when they can be.
          </p>
        </section>
      )}
    </div>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  )
}

function RequestItem({
  request,
  applicationId,
  fieldLabel,
}: {
  request: KycInformationRequest
  applicationId: string
  fieldLabel: string | null
}) {
  const respond = useRespond()
  const [text, setText] = useState('')
  const [failure, setFailure] = useState<string | null>(null)
  const send = async () => {
    setFailure(null)
    try {
      await respond.mutateAsync({ applicationId, requestId: request.id, response: text })
    } catch (caught) {
      setFailure(caught instanceof Error ? caught.message : 'Your answer could not be sent.')
    }
  }
  return (
    <li className="space-y-2 rounded-lg border p-4">
      <p className="text-sm font-medium">{request.message}</p>
      {fieldLabel && <p className="text-xs text-muted-foreground">About: {fieldLabel}</p>}
      {request.status === 'RESPONDED' ? (
        <p className="text-sm text-muted-foreground">
          Answered{request.respondedAt ? ` on ${formatDateTime(request.respondedAt)}` : ''}.
        </p>
      ) : (
        <div className="space-y-2">
          <label htmlFor={`response-${request.id}`} className="block text-sm font-medium">
            Your answer
          </label>
          <textarea
            id={`response-${request.id}`}
            value={text}
            onChange={(event) => setText(event.target.value)}
            maxLength={2000}
            rows={3}
            className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm"
          />
          <p className="text-xs text-muted-foreground">
            Do not type passwords, PINs or one-time codes.
          </p>
          {failure && (
            <p role="alert" className="text-sm text-danger">
              {failure}
            </p>
          )}
          <Button
            type="button"
            size="sm"
            disabled={text.trim() === '' || respond.isPending}
            onClick={() => void send()}
          >
            Send answer to OuPay
          </Button>
        </div>
      )}
    </li>
  )
}
