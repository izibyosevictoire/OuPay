import { formatRwf } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { InvoiceTotals as Totals } from '@/lib/invoiceCalculations'
import type { TaxMode } from '@/types/invoice'

interface InvoiceTotalsProps {
  totals: Totals
  taxMode: TaxMode
  className?: string
}

/**
 * Subtotal, discount, tax and total, laid out to match the stored identity:
 * EXCLUSIVE: total = subtotal - discount + tax. INCLUSIVE: total = subtotal - discount,
 * with the tax shown as the part already inside it.
 */
export function InvoiceTotalsBlock({ totals, taxMode, className }: InvoiceTotalsProps) {
  const row = (label: string, value: string, emphasised = false) => (
    <div
      className={cn(
        'flex justify-between gap-4',
        emphasised && 'border-t pt-2 text-base font-semibold',
      )}
    >
      <dt className={emphasised ? undefined : 'text-muted-foreground'}>{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  )
  return (
    <dl className={cn('space-y-1.5 text-sm', className)}>
      {row('Subtotal', formatRwf(totals.subtotal))}
      {totals.discountTotal > 0 && row('Discounts', `− ${formatRwf(totals.discountTotal)}`)}
      {taxMode === 'EXCLUSIVE'
        ? row('VAT / tax added', formatRwf(totals.taxTotal))
        : row('Of which VAT / tax', formatRwf(totals.taxTotal))}
      {row('Total', formatRwf(totals.grandTotal), true)}
    </dl>
  )
}
