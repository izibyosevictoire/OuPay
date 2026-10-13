import { Info } from 'lucide-react'

/** Makes it explicit that figures are mock data and not bank-verified. */
export function SampleDataNotice() {
  return (
    <div
      role="note"
      className="flex items-start gap-2 rounded-lg border border-info/20 bg-info-soft px-3 py-2 text-xs text-info"
    >
      <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <p>
        <strong className="font-semibold">Sample data.</strong> Figures shown here are mock records
        for development. They are not bank-verified payments.
      </p>
    </div>
  )
}
