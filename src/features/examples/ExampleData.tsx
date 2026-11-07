import { ChevronDown, FlaskConical } from 'lucide-react'
import { useId, useState } from 'react'
import { Card } from '@/components/ui/card'
import { DEMO_EXPERIENCE } from '@/lib/demoExperience'
import { EXAMPLE_LABEL } from '@/lib/exampleData'
import { cn } from '@/lib/utils'
import { exampleView, type ExampleTable, type ExampleTopic } from './exampleViews'

interface ExampleDataProps {
  topic: ExampleTopic
}

/**
 * A clearly separated EXAMPLES section at the bottom of a page, so anyone can see what a populated OuPay looks like (R10).
 *
 * - It takes NO business information and calls NO service: it renders fixed fictional records (Kigali Demo Supermarket) and nothing about the
 *   signed-in business, so it can never show, change, or add to real records, totals or reports.
 * - It is READ-ONLY: it contains no button, link or form for a record, only the control that opens and closes it.
 * - It is labelled EXAMPLE DATA in its heading, and says so again when open. It lives in its own section: examples are never mixed into the
 *   real tables.
 * - The separate demo build already IS a demonstration, so it shows no second layer of examples.
 */
export function ExampleData({ topic }: ExampleDataProps) {
  const [open, setOpen] = useState(false)
  const headingId = useId()
  const bodyId = useId()
  if (DEMO_EXPERIENCE) return null
  const view = exampleView(topic)

  return (
    <section aria-labelledby={headingId} data-example-data={topic} className="print:hidden">
      <Card className="border-dashed border-warning/50 bg-warning-soft/30">
        <h2 id={headingId} className="text-base font-semibold">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={() => setOpen((value) => !value)}
            className="flex min-h-12 w-full items-center justify-between gap-3 rounded-lg px-4 py-3 text-left hover:bg-warning-soft/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <span className="inline-flex items-center gap-1 rounded-md bg-warning-soft px-2 py-0.5 text-xs font-bold tracking-wide text-warning">
                <FlaskConical className="size-3.5" aria-hidden="true" />
                {EXAMPLE_LABEL}
              </span>
              <span>See how this looks when it is filled in</span>
            </span>
            <ChevronDown className={cn('size-5 shrink-0 transition-transform', open && 'rotate-180')} aria-hidden="true" />
          </button>
        </h2>

        {open && (
          <div id={bodyId} className="space-y-4 border-t border-warning/30 px-4 py-4">
            <p role="note" className="rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-sm text-warning">
              <strong className="font-semibold">{EXAMPLE_LABEL}.</strong> Kigali Demo Supermarket is a made-up shop. These records are{' '}
              <strong>not yours</strong>, can not be edited, billed or used, and are not counted in any of your totals. Any payment shown is simulated.
            </p>
            <p className="text-sm text-muted-foreground">{view.summary}</p>

            {view.stats.length > 0 && (
              <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {view.stats.map((stat) => (
                  <div key={stat.label} className="rounded-lg border bg-card p-3">
                    <dt className="text-sm text-muted-foreground">{stat.label}</dt>
                    <dd className="mt-1 text-lg font-semibold tabular-nums">{stat.value}</dd>
                    {stat.hint && <dd className="text-xs text-muted-foreground">{stat.hint}</dd>}
                  </div>
                ))}
              </dl>
            )}

            {view.tables.map((table) => (
              <ExampleTableView key={table.caption} table={table} />
            ))}
          </div>
        )}
      </Card>
    </section>
  )
}

/**
 * One table in the same look as the real ones. On a phone each row becomes a small card (label and value on one line each), so nothing needs
 * sideways scrolling; from `sm` up it is an ordinary table.
 */
function ExampleTableView({ table }: { table: ExampleTable }) {
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{table.caption}</p>
      <div className="rounded-lg border bg-card">
        <table className="block w-full text-sm sm:table">
          <caption className="sr-only">{table.caption} (example data, read-only)</caption>
          <thead className="sr-only sm:not-sr-only sm:table-header-group">
            <tr className="border-b text-left text-muted-foreground sm:table-row">
              {table.columns.map((column) => (
                <th key={column.key} scope="col" className={cn('px-3 py-2 font-medium', column.numeric && 'sm:text-right')}>
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="block sm:table-row-group">
            {table.rows.map((row) => (
              <tr key={row.key} className="block border-b p-3 last:border-b-0 sm:table-row sm:p-0">
                {table.columns.map((column) => (
                  <td
                    key={column.key}
                    data-label={column.label}
                    className={cn(
                      'flex items-start justify-between gap-3 py-1 before:shrink-0 before:text-xs before:font-medium before:text-muted-foreground before:content-[attr(data-label)] sm:table-cell sm:px-3 sm:py-2.5 sm:before:content-none',
                      column.numeric && 'sm:text-right tabular-nums',
                    )}
                  >
                    <span className="min-w-0 text-right sm:[text-align:inherit]">{row.cells[column.key]}</span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
