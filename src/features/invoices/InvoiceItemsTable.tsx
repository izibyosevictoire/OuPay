import { formatQuantity, formatRwf } from '@/lib/format'
import { describeTaxRate } from '@/lib/taxLabels'
import type { InvoiceItem, TaxMode } from '@/types/invoice'

interface InvoiceItemsTableProps {
  items: InvoiceItem[]
  taxMode: TaxMode
  /** Print layout drops the phone card list and always shows the table. */
  forPrint?: boolean
}

/** Read-only line items: a table from md up, stacked cards on phones. */
export function InvoiceItemsTable({ items, taxMode, forPrint = false }: InvoiceItemsTableProps) {
  const priceNote = taxMode === 'INCLUSIVE' ? 'incl. tax' : 'excl. tax'
  return (
    <>
      {!forPrint && (
        <ul className="divide-y md:hidden">
          {items.map((item) => (
            <li key={item.id} className="space-y-1 py-3 first:pt-0 last:pb-0">
              <div className="flex justify-between gap-3">
                <p className="font-medium">{item.description}</p>
                <p className="font-semibold tabular-nums">{formatRwf(item.lineTotal)}</p>
              </div>
              <p className="text-xs text-muted-foreground">
                {formatQuantity(item.quantity)} × {formatRwf(item.unitPrice)} ({priceNote})
                {item.discount > 0 && ` · discount ${formatRwf(item.discount)}`} ·{' '}
                {describeTaxRate(item.taxRate)}
                {item.taxAmount > 0 && ` (${formatRwf(item.taxAmount)})`}
              </p>
            </li>
          ))}
        </ul>
      )}
      <table
        className={
          forPrint ? 'w-full text-left text-sm' : 'hidden w-full text-left text-sm md:table'
        }
      >
        <caption className="sr-only">Invoice line items</caption>
        <thead className="text-xs text-muted-foreground print:text-black">
          <tr className="border-b">
            <th scope="col" className="pb-2 font-medium">
              Description
            </th>
            <th scope="col" className="pb-2 text-right font-medium">
              Qty
            </th>
            <th scope="col" className="pb-2 text-right font-medium">
              Unit price ({priceNote})
            </th>
            <th scope="col" className="pb-2 text-right font-medium">
              Discount
            </th>
            <th scope="col" className="pb-2 pl-3 font-medium">
              Tax
            </th>
            <th scope="col" className="pb-2 text-right font-medium">
              Amount
            </th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {items.map((item) => (
            <tr key={item.id}>
              <th scope="row" className="py-2.5 pr-3 font-medium">
                {item.description}
              </th>
              <td className="py-2.5 text-right tabular-nums">{formatQuantity(item.quantity)}</td>
              <td className="py-2.5 text-right tabular-nums">{formatRwf(item.unitPrice)}</td>
              <td className="py-2.5 text-right tabular-nums">
                {item.discount > 0 ? formatRwf(item.discount) : '—'}
              </td>
              <td className="py-2.5 pl-3">
                {describeTaxRate(item.taxRate)}
                {item.taxAmount > 0 && (
                  <span className="block text-xs text-muted-foreground print:text-black">
                    {formatRwf(item.taxAmount)}
                  </span>
                )}
              </td>
              <td className="py-2.5 text-right font-medium tabular-nums">
                {formatRwf(item.lineTotal)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}
