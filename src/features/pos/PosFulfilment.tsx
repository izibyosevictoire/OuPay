import { Info } from 'lucide-react'
import { QueryBoundary } from '@/components/common/QueryBoundary'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { formatDateTime, formatRwf } from '@/lib/format'
import type {
  PosFulfilmentException,
  PosFulfilmentExceptionKind,
  PosFulfilmentView,
  PosInventoryState,
  PosPaymentState,
} from '@/types/pos'
import { usePosFulfilmentExceptions } from './posBillingQueries'
import { friendlyQuantity } from './posRules'

const PAYMENT_TEXT: Record<PosPaymentState, (f: PosFulfilmentView) => string> = {
  UNPAID: () => 'Not paid yet. Nothing has been verified and matched to this sale.',
  PARTIAL: (f) =>
    `Partly paid: ${formatRwf(f.appliedRwf)} of ${formatRwf(f.totalRwf)} verified and matched. Stock is deducted only when it is paid in full.`,
  PAID: () => 'Paid in full: bank-verified money was matched to this sale.',
  REVERSED: () => 'The payment was reversed by the bank. Nothing verified is applied now.',
  NOT_APPLICABLE: () => 'No real payment exists for a demonstration.',
}

const INVENTORY_TEXT: Record<PosInventoryState, (f: PosFulfilmentView) => string> = {
  NOT_POSTED: () => 'Stock not deducted yet. It is deducted after the sale is paid in full.',
  POSTED: (f) =>
    `Stock deducted${f.postedAt ? ` (${formatDateTime(f.postedAt)})` : ''}: the stock ledger was updated.`,
  EXCEPTION: () => 'Stock was NOT deducted: this paid sale needs an owner’s attention.',
  NOT_REQUIRED: () => 'No goods in this sale: nothing to deduct.',
  NOT_APPLICABLE: () => 'No real stock is reserved or deducted for a demonstration.',
}

const EXCEPTION_TEXT: Record<PosFulfilmentExceptionKind, string> = {
  RESERVATION_RELEASED: 'Paid after its stock reservation was released',
  INSUFFICIENT_STOCK: 'Paid, but physical stock cannot cover it',
  PAYMENT_REVERSED_AFTER_POSTING: 'Payment reversed after the stock was deducted',
  PROCESSING_FAILED: 'Deducting the stock failed repeatedly',
}

function ExceptionList({ items }: { items: PosFulfilmentException[] }) {
  return (
    <ul aria-label="Fulfilment exceptions" className="space-y-2">
      {items.map((e) => (
        <li
          key={e.id}
          className="rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-sm"
        >
          <p className="font-medium text-warning">
            {EXCEPTION_TEXT[e.kind]}
            {e.status === 'RESOLVED' && ' (resolved)'}
          </p>
          <p className="text-xs">{e.detail}</p>
        </li>
      ))}
    </ul>
  )
}

/**
 * Four SEPARATE facts about a sale, each read from the server: payment (verified and matched money only), reservation (shown beside this),
 * inventory posting, and handover. PAID never means delivered, and a stock deduction only says the stock ledger was updated.
 */
export function FulfilmentSection({
  fulfilment,
  demo,
}: {
  fulfilment: PosFulfilmentView
  demo: boolean
}) {
  return (
    <section
      aria-labelledby="pos-fulfilment-heading"
      className="space-y-2 rounded-lg border px-3 py-3 text-sm"
    >
      <h3 id="pos-fulfilment-heading" className="font-semibold">
        Payment and stock
      </h3>
      {demo ? (
        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          {fulfilment.note}
        </p>
      ) : (
        <>
          <dl className="space-y-1.5">
            <div>
              <dt className="text-xs text-muted-foreground">Payment</dt>
              <dd data-payment-state={fulfilment.paymentState}>
                {PAYMENT_TEXT[fulfilment.paymentState](fulfilment)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Inventory</dt>
              <dd data-inventory-state={fulfilment.inventoryState}>
                {INVENTORY_TEXT[fulfilment.inventoryState](fulfilment)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Handover</dt>
              <dd data-handover={fulfilment.handover}>Not recorded. {fulfilment.note}</dd>
            </div>
          </dl>
          {fulfilment.lines.length > 0 && (
            <ul aria-label="Stock deducted" className="list-disc space-y-0.5 pl-5 text-xs">
              {fulfilment.lines.map((line) => (
                <li key={line.movementId}>
                  {line.name}: {friendlyQuantity(line.quantityDeducted, line.canonicalUnit)}{' '}
                  deducted
                  {line.physicalNow !== null &&
                    ` · physical now ${friendlyQuantity(line.physicalNow, line.canonicalUnit)}`}
                  {line.availableNow !== null &&
                    ` · available now ${friendlyQuantity(line.availableNow, line.canonicalUnit)}`}
                </li>
              ))}
            </ul>
          )}
          {fulfilment.exceptions.length > 0 && <ExceptionList items={fulfilment.exceptions} />}
        </>
      )}
    </section>
  )
}

/** The owner's read-only list of paid sales whose stock could not be deducted. Resolving one is a later, separately authorised step. */
export function FulfilmentExceptionsCard() {
  const query = usePosFulfilmentExceptions()
  return (
    <Card>
      <CardContent className="space-y-3 p-4 sm:p-6">
        <section aria-labelledby="pos-exceptions-heading" className="space-y-3">
          <h2 id="pos-exceptions-heading" className="text-base font-semibold">
            Paid sales that need attention
          </h2>
          <QueryBoundary
            query={query}
            loadingFallback={<Skeleton className="h-16 w-full" />}
            errorMessage="Fulfilment exceptions could not be loaded."
          >
            {(items) =>
              items.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No paid sale is waiting for a decision.
                </p>
              ) : (
                <ul aria-label="Open fulfilment exceptions" className="divide-y rounded-lg border">
                  {items.map((e) => (
                    <li key={e.id} className="space-y-0.5 p-3 text-sm">
                      <p className="font-medium">
                        {e.invoiceNumber} · {e.saleReference}
                      </p>
                      <p className="text-warning">{EXCEPTION_TEXT[e.kind]}</p>
                      <p className="text-xs text-muted-foreground">{e.detail}</p>
                      <p className="text-xs text-muted-foreground">
                        Opened {formatDateTime(e.openedAt)}
                      </p>
                    </li>
                  ))}
                </ul>
              )
            }
          </QueryBoundary>
          <p className="text-xs text-muted-foreground">
            Read-only. The payment stays verified and applied; nothing here deducts or restores
            stock.
          </p>
        </section>
      </CardContent>
    </Card>
  )
}
