import { AlertTriangle } from 'lucide-react'
import {
  COLLECTION_CODE_STATUS_LABELS,
  COLLECTION_CODE_STATUS_TONE,
  ELIGIBILITY_ISSUE_LABELS,
  INTERNAL_REF_LABEL,
} from '@/constants/collectionCodes'
import { formatDateTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { CodeAssignment, CollectionCode, CollectionCodeStatus } from '@/types/collectionCodes'
import { assigneeLabel } from './codeLabels'

export function CodeStatusBadge({ status }: { status: CollectionCodeStatus }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
        COLLECTION_CODE_STATUS_TONE[status],
      )}
    >
      {COLLECTION_CODE_STATUS_LABELS[status]}
    </span>
  )
}

const APPROVAL_SOURCE_LABELS = {
  BANK_EVENT: 'a verified bank event',
  OPERATOR: 'an authorised operator holding the bank’s written confirmation',
} as const

/**
 * What a code IS, kept visibly apart:
 *  1. OuPay's own identifier: always present, always labelled as internal. It is never a bank code.
 *  2. The bank-issued code: either "none issued yet" or the approved value with the evidence it rests on. The evidence
 *     reference itself is for owners only; anyone else is told it exists.
 * Whether it can be used for collection right now is a separate fact (see CodeFacts).
 */
export function CodeIdentity({ code }: { code: CollectionCode }) {
  return (
    <dl className="grid gap-3 text-sm sm:grid-cols-2">
      <div>
        <dt className="text-xs text-muted-foreground">{INTERNAL_REF_LABEL}</dt>
        <dd className="font-mono">{code.internalRef}</dd>
        <dd className="text-xs text-muted-foreground">
          For OuPay records only. Customers never pay to it.
        </dd>
      </div>
      {code.externalCodeState === 'BANK_APPROVED' && code.externalCode ? (
        <div>
          <dt className="text-xs text-muted-foreground">Bank-issued code</dt>
          <dd className="font-mono text-base font-semibold">{code.externalCode}</dd>
          {code.approval && (
            <dd className="text-xs text-muted-foreground">
              Recorded through {APPROVAL_SOURCE_LABELS[code.approval.source]}, on{' '}
              {formatDateTime(code.approval.approvedAt)}.{' '}
              {code.approval.evidenceRef
                ? `Evidence: ${code.approval.evidenceRef}.`
                : 'Evidence recorded; visible to owners only.'}
            </dd>
          )}
        </div>
      ) : (
        <div>
          <dt className="text-xs text-muted-foreground">Equity-issued code</dt>
          <dd className="font-medium">None issued yet</dd>
          <dd className="text-xs text-muted-foreground">
            {code.status === 'REQUESTED'
              ? 'Nothing has been sent to Equity, so no code has been issued.'
              : 'OuPay has no code from Equity for this. Do not give customers any code yet.'}
          </dd>
        </div>
      )}
    </dl>
  )
}

/**
 * Four DIFFERENT facts about a code, never merged into one status: whether the bank provisioned it, who holds it, whether it is
 * eligible for collection right now (with the reasons when it is not), and whether it is a simulation.
 */
export function CodeFacts({ code }: { code: CollectionCode }) {
  return (
    <section aria-label="Collection readiness" className="space-y-2 rounded-md border p-3">
      <h4 className="text-sm font-semibold">Collection readiness</h4>
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs text-muted-foreground">Provisioned by the bank</dt>
          <dd className="font-medium">{code.bankProvisioned ? 'Yes' : 'No'}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Assigned to</dt>
          <dd className="font-medium">
            {code.currentAssignment ? assigneeLabel(code.currentAssignment) : 'Nobody'}
          </dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-xs text-muted-foreground">Eligible for collection now</dt>
          {code.payable ? (
            <dd className="font-medium text-success">Yes: it can be given to customers.</dd>
          ) : (
            <>
              <dd className="font-medium">No</dd>
              {code.eligibilityIssues.length > 0 && (
                <dd>
                  <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
                    {code.eligibilityIssues.map((issue) => (
                      <li key={issue}>{ELIGIBILITY_ISSUE_LABELS[issue]}</li>
                    ))}
                  </ul>
                </dd>
              )}
            </>
          )}
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Simulated</dt>
          <dd className={cn('font-medium', code.simulated && 'text-warning')}>
            {code.simulated ? 'Simulated: never a live code' : 'Not simulated'}
          </dd>
        </div>
      </dl>
    </section>
  )
}

/** Shown when an open assignment's person can no longer act: the history is untouched, but the code is not eligible. */
export function AssigneeAttention({ assignment }: { assignment: CodeAssignment | null }) {
  if (
    !assignment ||
    assignment.assigneeKind !== 'MEMBER' ||
    !assignment.assigneeCurrentStatus ||
    assignment.assigneeCurrentStatus === 'ACTIVE'
  ) {
    return null
  }
  return (
    <p
      role="alert"
      className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-sm text-warning"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span>
        {assignment.assigneeName} is{' '}
        {assignment.assigneeCurrentStatus === 'SUSPENDED'
          ? 'suspended'
          : assignment.assigneeCurrentStatus === 'REVOKED'
            ? 'no longer part of this business'
            : 'not active'}
        , so this code is not eligible for collection. They still hold it until you remove or
        replace them. Past records are not changed.
      </span>
    </p>
  )
}
