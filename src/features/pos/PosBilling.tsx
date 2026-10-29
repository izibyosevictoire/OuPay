import { ArrowLeft, Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { QueryBoundary } from '@/components/common/QueryBoundary'
import { FormField } from '@/components/common/FormField'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Select } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { useCodeCheckoutOptions } from '@/features/codeCheckout/codeCheckoutQueries'
import { DemoBillNotice } from '@/features/codeCheckout/DemoBillNotice'
import { CodeSaleReceipt } from '@/features/codeCheckout/CodeSaleReceipt'
import { formatRwf } from '@/lib/format'
import type {
  PosBilledSale,
  PosBillingReview,
  PosReservation,
  PosReviewLine,
  PosSaleLine,
} from '@/types/pos'
import { FulfilmentSection } from './PosFulfilment'
import { useBillPosDraft, usePosBillingReview, usePosSale } from './posBillingQueries'
import { availabilityText, billFailure, taxLabelOf } from './posBillingRules'
import { friendlyQuantity, unitSymbol } from './posRules'
import { billKeyFor, forgetBillKey } from './posSession'

const linkClass = 'font-medium text-primary hover:underline'

function ReviewLineRow({ line }: { line: PosReviewLine }) {
  const entered = line.packageLabel
    ? `${line.enteredQuantity} × ${line.packageLabel}`
    : `${line.enteredQuantity} ${unitSymbol(line.enteredUnit ?? line.saleUnit)}`
  return (
    <li className="space-y-1 p-3 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-semibold">{line.name}</p>
        <p className="font-semibold tabular-nums">{formatRwf(line.lineTotalRwf)}</p>
      </div>
      <p className="text-xs text-muted-foreground">
        {entered} = {line.quantityInSaleUnit} {unitSymbol(line.saleUnit)} ×{' '}
        {formatRwf(line.unitPriceRwf)} (price version {line.priceVersion})
      </p>
      {line.priceChangedSinceDraft && (
        <p className="text-xs font-medium text-warning-foreground">
          ⚠ The price changed since the draft was saved: it was {formatRwf(line.draftUnitPriceRwf)}{' '}
          (version {line.draftPriceVersion}). The current price is billed.
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Tax: {taxLabelOf(line.taxCategory, line.taxRateBp)}
        {line.taxCategory && ` · net ${formatRwf(line.netRwf)} + tax ${formatRwf(line.taxRwf)}`}
      </p>
      <p
        className={
          line.availability.state === 'INSUFFICIENT' ||
          line.availability.state === 'NO_STOCK_RECORD'
            ? 'text-xs font-medium text-warning-foreground'
            : 'text-xs text-muted-foreground'
        }
      >
        {availabilityText(line.availability)}
      </p>
    </li>
  )
}

function ModeBanner({ review }: { review: PosBillingReview }) {
  if (review.mode === 'DEMONSTRATION') {
    return (
      <div className="space-y-1">
        <DemoBillNotice />
        <p className="text-xs text-muted-foreground">{review.modeNote}</p>
      </div>
    )
  }
  if (review.mode === 'LIVE') {
    return (
      <p
        role="note"
        className="rounded-lg border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
      >
        {review.modeNote}
      </p>
    )
  }
  return null
}

interface ReviewProps {
  scope: string
  draftId: string
  onBack: () => void
  onBilled: (saleId: string) => void
}

/**
 * The FINAL review before billing: the server's current price, tax and availability, as it sees them now. Billing sends only what was
 * reviewed (the draft, its version, the total, the code): if the server computes anything else it refuses and this review is read again.
 * Nothing here marks anything as paid, and "reserved" is never "sold".
 */
export function PosBillingReview({ scope, draftId, onBack, onBilled }: ReviewProps) {
  const codes = useCodeCheckoutOptions()
  const [codeId, setCodeId] = useState<string | null>(null)
  const bill = useBillPosDraft(draftId)
  const [failure, setFailure] = useState<ReturnType<typeof billFailure> | null>(null)

  const choices = codes.data?.codes.filter((c) => c.mode !== 'UNAVAILABLE') ?? []
  // One usable code is used without asking; several need a choice (the server refuses to guess).
  const effectiveCode = codeId ?? (choices.length === 1 ? (choices[0]?.id ?? null) : null)
  const review = usePosBillingReview(draftId, effectiveCode, !codes.isPending)

  const submit = async (data: PosBillingReview) => {
    if (bill.isPending) return
    setFailure(null)
    // The same bill (same draft, version, total and code) keeps one retry key: a lost answer can be retried and finds the same sale.
    const payload = JSON.stringify([data.draftId, data.draftVersion, data.totalRwf, effectiveCode])
    try {
      const sale = await bill.mutateAsync({
        expectedDraftVersion: data.draftVersion,
        reviewedTotalRwf: data.totalRwf,
        collectionCodeId: effectiveCode,
        idempotencyKey: billKeyFor(scope, payload),
      })
      forgetBillKey(scope)
      onBilled(sale.sale.saleId)
    } catch (error) {
      const next = billFailure(error)
      setFailure(next)
      if (next.review) void review.refetch()
    }
  }

  return (
    <Card>
      <CardContent className="space-y-4 p-4 sm:p-6">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-base font-semibold">Review and bill</h2>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onBack}
            disabled={bill.isPending}
          >
            <ArrowLeft aria-hidden="true" />
            Back to cart
          </Button>
        </div>
        <QueryBoundary
          query={review}
          loadingFallback={<Skeleton className="h-64 w-full" />}
          errorMessage="The bill could not be reviewed."
        >
          {(data) => (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Branch: <span className="font-medium text-foreground">{data.branchName}</span>.
                These are today's catalog prices, tax and stock, read again just now.
              </p>
              <ModeBanner review={data} />
              {choices.length > 1 && (
                <div className="max-w-xs">
                  <FormField label="Collect through code" required>
                    {(control) => (
                      <Select
                        {...control}
                        value={codeId ?? ''}
                        onChange={(event) => setCodeId(event.target.value || null)}
                      >
                        <option value="">Choose a code</option>
                        {choices.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.label}
                          </option>
                        ))}
                      </Select>
                    )}
                  </FormField>
                </div>
              )}
              <ul aria-label="Lines to bill" className="divide-y rounded-lg border">
                {data.lines.map((line) => (
                  <ReviewLineRow key={line.lineNo} line={line} />
                ))}
              </ul>
              {data.problems.length > 0 && (
                <div
                  role="alert"
                  className="space-y-2 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger"
                >
                  <p className="font-medium">This cart cannot be billed yet:</p>
                  <ul className="list-disc space-y-1 pl-5">
                    {data.problems.map((p) => (
                      <li key={`${p.lineNo}-${p.code}`}>
                        {p.lineNo > 0 ? `Line ${p.lineNo}: ` : ''}
                        {p.message}
                        {(p.code === 'tax_not_configured' || p.code === 'tax_not_approved') && (
                          <>
                            {' '}
                            <Link to="/catalog" className="font-medium underline">
                              Open the catalog
                            </Link>
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <dl className="space-y-1 border-t pt-3 text-sm">
                <div className="flex justify-between">
                  <dt>Subtotal</dt>
                  <dd className="tabular-nums">{formatRwf(data.subtotalRwf)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt>Tax</dt>
                  <dd className="tabular-nums">{formatRwf(data.taxRwf)}</dd>
                </div>
                <div className="flex justify-between text-base font-semibold">
                  <dt>Total to bill</dt>
                  <dd className="tabular-nums" aria-live="polite">
                    {formatRwf(data.totalRwf)}
                  </dd>
                </div>
              </dl>
              <p className="text-xs text-muted-foreground">
                {data.stockNote} Billing reserves the goods; it does not sell or deduct them.
              </p>
              {failure && (
                <div role="alert" className="space-y-2 text-sm text-danger">
                  <p>{failure.message}</p>
                  {failure.review && (
                    <p className="text-muted-foreground">The review above was read again.</p>
                  )}
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  onClick={() => void submit(data)}
                  disabled={!data.billable || bill.isPending || review.isFetching}
                >
                  {bill.isPending && <Loader2 className="animate-spin" aria-hidden="true" />}
                  {failure?.retrySafe ? 'Try again' : `Bill ${formatRwf(data.totalRwf)}`}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void review.refetch()}
                  disabled={bill.isPending}
                >
                  Review again
                </Button>
              </div>
            </div>
          )}
        </QueryBoundary>
      </CardContent>
    </Card>
  )
}

const RESERVATION_LABEL: Record<PosReservation['state'], string> = {
  RESERVED: 'Goods reserved (not sold)',
  FULFILLED: 'Goods fulfilled',
  RELEASED: 'Reservation released',
  NOT_RESERVED: 'No stock reserved',
}

function SaleLines({ lines }: { lines: PosSaleLine[] }) {
  return (
    <ul aria-label="Billed lines" className="divide-y rounded-lg border">
      {lines.map((line) => (
        <li key={line.lineNo} className="space-y-0.5 p-3 text-sm">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="font-semibold">{line.name}</p>
            <p className="font-semibold tabular-nums">{formatRwf(line.lineTotalRwf)}</p>
          </div>
          <p className="text-xs text-muted-foreground">
            {line.quantityInSaleUnit} {unitSymbol(line.saleUnit)} × {formatRwf(line.unitPriceRwf)}{' '}
            (price version {line.priceVersion}) · Tax:{' '}
            {taxLabelOf(line.taxCategory, line.taxRateBp)} ({formatRwf(line.taxRwf)})
          </p>
        </li>
      ))}
    </ul>
  )
}

function SaleSummary({ sale }: { sale: PosBilledSale }) {
  const reservation = sale.reservation
  const demo = sale.mode === 'DEMONSTRATION'
  return (
    <section aria-labelledby="pos-sale-heading" className="space-y-3">
      {demo && <DemoBillNotice />}
      <h2 id="pos-sale-heading" className="text-base font-semibold">
        POS sale {sale.sale.invoiceNumber}
        {sale.mode === 'DEMONSTRATION' && ' (demonstration)'}
      </h2>
      <SaleLines lines={sale.lines} />
      <dl className="space-y-1 text-sm">
        <div className="flex justify-between">
          <dt>Subtotal</dt>
          <dd className="tabular-nums">{formatRwf(sale.subtotalRwf)}</dd>
        </div>
        <div className="flex justify-between">
          <dt>Tax</dt>
          <dd className="tabular-nums">{formatRwf(sale.taxRwf)}</dd>
        </div>
        <div className="flex justify-between font-semibold">
          <dt>Total</dt>
          <dd className="tabular-nums">{formatRwf(sale.totalRwf)}</dd>
        </div>
      </dl>
      <div
        className="rounded-lg border bg-muted/40 px-3 py-2 text-sm"
        data-reservation={reservation.state}
      >
        <p className="font-medium">
          {demo
            ? 'Stock not reserved or deducted (demonstration)'
            : RESERVATION_LABEL[reservation.state]}
        </p>
        {!demo && <p className="text-xs text-muted-foreground">{reservation.note}</p>}
        {!demo && reservation.lines.length > 0 && (
          <ul className="mt-1 list-disc pl-5 text-xs">
            {reservation.lines.map((l) => (
              <li key={`${l.itemId}-${l.quantity}-${l.enteredQuantity}`}>
                {l.name}: {friendlyQuantity(l.quantity, (l.canonicalUnit || 'pc') as 'pc')} reserved
              </li>
            ))}
          </ul>
        )}
      </div>
      <FulfilmentSection fulfilment={sale.fulfilment} demo={demo} />
      <p>
        <Link to={`/invoices/${sale.sale.invoiceId}`} className={linkClass}>
          Open invoice {sale.sale.invoiceNumber}
        </Link>
      </p>
      <p className="text-xs text-muted-foreground">{sale.taxNote}</p>
    </section>
  )
}

interface SalePanelProps {
  saleId: string
  onNewSale: () => void
  onGone: () => void
}

/**
 * The sale just billed: its lines, tax and reservation (this page), and the code, reference and live payment status (the existing
 * code-sale receipt, read from the server). "Paid" appears only after bank-verified money was applied; "reserved" is not "sold".
 */
export function PosSalePanel({ saleId, onNewSale, onGone }: SalePanelProps) {
  const sale = usePosSale(saleId)
  const errorCode = (sale.error as { code?: string } | null)?.code
  useEffect(() => {
    if (errorCode === 'not_found' || errorCode === 'forbidden') onGone()
  }, [errorCode, onGone])
  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-4 sm:p-6">
          <QueryBoundary
            query={sale}
            loadingFallback={<Skeleton className="h-48 w-full" />}
            errorMessage="The sale could not be loaded."
          >
            {(data) => <SaleSummary sale={data} />}
          </QueryBoundary>
        </CardContent>
      </Card>
      <CodeSaleReceipt saleId={saleId} onNewSale={onNewSale} onGone={onGone} />
    </div>
  )
}
