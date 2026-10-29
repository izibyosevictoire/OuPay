import { Info } from 'lucide-react'

/** The plain statements a demonstration bill makes, wherever it is shown. A demonstration is never a financial obligation. */
const DEMO_BILL_STATEMENTS = [
  'This is a demonstration bill.',
  'It is not payable through a real Equity code.',
  'No real bank payment has been made.',
] as const

const DEMO_STOCK_STATEMENT = 'Physical stock has not been reserved or deducted.'

interface DemoBillNoticeProps {
  /** Say what happened to stock. Left out on the customer's page: stock is the business's concern. */
  showStock?: boolean
}

/** The prominent demonstration notice. It states what the bill is NOT, so it cannot be mistaken for an amount owed. */
export function DemoBillNotice({ showStock = true }: DemoBillNoticeProps) {
  return (
    <div
      role="note"
      data-demo-bill-notice
      className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning-soft px-3 py-2 text-sm font-medium text-warning"
    >
      <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <p>
        {DEMO_BILL_STATEMENTS.join(' ')}
        {showStock && ` ${DEMO_STOCK_STATEMENT}`}
      </p>
    </div>
  )
}
