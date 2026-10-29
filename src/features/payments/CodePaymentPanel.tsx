import { FlaskConical } from 'lucide-react'
import { Link } from 'react-router-dom'
import { DescriptionList } from '@/components/common/DescriptionList'
import { CodePaymentStageBadge } from '@/components/common/StatusBadge'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  ATTRIBUTION_STATUS_LABELS,
  SALE_ALLOCATION_ORIGIN_LABELS,
  SIMULATED_PAYMENT_NOTICE,
} from '@/constants/codePayment'
import { PermissionGuard } from '@/features/auth/permissions/PermissionGuard'
import { formatDateTime, formatRwf } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { BankAttribution } from '@/types/bankAttribution'
import type { AuditEntry } from '@/types/payment'
import { agentLine, codePaymentFacts, explainCodePayment } from './codePayment'

const FACT_STYLES = {
  done: 'bg-success-soft text-success',
  open: 'bg-info-soft text-info',
  problem: 'bg-danger-soft text-danger',
  none: 'bg-neutral-soft text-neutral',
} as const

interface CodePaymentPanelProps {
  attribution: BankAttribution
  /** The transaction's append-only history: manual reconciliation entries are listed here for people who may reconcile. */
  auditHistory: AuditEntry[]
  simulated: boolean
}

/**
 * How a bank transaction relates to a collection code and a code sale. The five facts (bank confirmation, code, sale reference, money
 * applied, sale paid) are listed separately, each with its state in words, so "confirmed", "matched" and "paid" are never one status.
 */
export function CodePaymentPanel({
  attribution: a,
  auditHistory,
  simulated,
}: CodePaymentPanelProps) {
  const facts = codePaymentFacts(a)
  const manualHistory = auditHistory.filter(
    (entry) => entry.kind === 'MANUAL_ALLOCATED' || entry.kind === 'ALLOCATION_REVERSED',
  )
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle>Code payment</CardTitle>
          <CodePaymentStageBadge stage={a.stage} />
        </div>
        <CardDescription>
          What the bank reported about the collection code, and what OuPay did with the money.
        </CardDescription>
      </CardHeader>
      <div className="space-y-4 px-4 pb-4 sm:px-5">
        {simulated && (
          <p
            role="note"
            className="flex items-start gap-2 rounded-md border border-info/20 bg-info-soft px-3 py-2 text-sm text-info"
          >
            <FlaskConical className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            {SIMULATED_PAYMENT_NOTICE}
          </p>
        )}
        <p
          className={cn(
            'rounded-md px-3 py-2 text-sm',
            a.stage === 'CONFLICT' ? 'bg-danger-soft text-danger' : 'bg-muted',
          )}
          data-testid="code-payment-explanation"
        >
          {explainCodePayment(a)}
        </p>
        <ol aria-label="What is established" className="divide-y rounded-md border">
          {facts.map((fact) => (
            <li
              key={fact.id}
              data-fact={fact.id}
              data-state={fact.state}
              className="grid grid-cols-1 gap-1 px-3 py-2.5 text-sm sm:grid-cols-[10rem_11rem_1fr] sm:items-center sm:gap-3"
            >
              <span className="font-medium">{fact.label}</span>
              <span
                className={cn(
                  'inline-flex w-fit rounded-full px-2 py-0.5 text-xs font-medium',
                  FACT_STYLES[fact.state],
                )}
              >
                {fact.stateText}
              </span>
              <span className="text-muted-foreground">{fact.detail}</span>
            </li>
          ))}
        </ol>
      </div>
      <DescriptionList
        rows={[
          { label: 'Sale reference', value: a.saleReference ?? undefined },
          { label: 'Collection code', value: a.collectionCode?.label },
          {
            label: a.reportedCodeMasked ? 'Reported code (masked)' : 'Reported code',
            value: a.reportedCode ?? undefined,
          },
          { label: 'Attribution', value: ATTRIBUTION_STATUS_LABELS[a.attributionStatus] },
          { label: 'Original agent', value: agentLine(a) },
          { label: 'Amount received', value: formatRwf(a.amountRwf) },
          { label: 'Applied to the sale', value: formatRwf(a.allocatedToSaleRwf) },
          {
            label: 'How it was applied',
            value: a.allocationOrigin
              ? SALE_ALLOCATION_ORIGIN_LABELS[a.allocationOrigin]
              : undefined,
          },
        ]}
      />
      {a.saleInvoiceId && (
        <div className="px-4 pb-4 sm:px-5">
          <PermissionGuard permission="invoices:view">
            <Link
              to={`/invoices/${a.saleInvoiceId}`}
              className="inline-flex min-h-10 items-center rounded-sm text-sm font-medium text-primary hover:underline"
            >
              View the sale’s invoice
            </Link>
          </PermissionGuard>
        </div>
      )}
      <PermissionGuard permission="payments:reconcile">
        <div className="border-t px-4 py-3 sm:px-5">
          <h3 className="text-sm font-medium">Manual reconciliation history</h3>
          {manualHistory.length === 0 ? (
            <p className="mt-1 text-sm text-muted-foreground">
              Nobody has applied or corrected this money by hand.
            </p>
          ) : (
            <ul className="mt-1 divide-y" aria-label="Manual reconciliation history">
              {manualHistory.map((entry) => (
                <li key={entry.id} className="py-2 text-sm">
                  <p>{entry.message}</p>
                  <p className="text-xs text-muted-foreground">{formatDateTime(entry.createdAt)}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </PermissionGuard>
    </Card>
  )
}
