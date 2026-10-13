export interface DescriptionRow {
  label: string
  value?: string
}

/** Label/value pairs as a real description list; stacks on phones, two columns from sm up. */
export function DescriptionList({ rows }: { rows: DescriptionRow[] }) {
  return (
    <dl className="divide-y">
      {rows.map(({ label, value }) => (
        <div key={label} className="grid gap-0.5 px-4 py-2.5 sm:grid-cols-3 sm:gap-4">
          <dt className="text-sm text-muted-foreground">{label}</dt>
          <dd className="break-words text-sm sm:col-span-2">{value || 'Not provided'}</dd>
        </div>
      ))}
    </dl>
  )
}
