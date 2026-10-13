const rwandanFrancFormatter = new Intl.NumberFormat('en-RW', {
  style: 'currency',
  currencyDisplay: 'code',
  currency: 'RWF',
  maximumFractionDigits: 0,
})
const compactNumberFormatter = new Intl.NumberFormat('en', {
  notation: 'compact',
  maximumFractionDigits: 1,
})
const dateTimeFormatter = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'Africa/Kigali',
})
const dateFormatter = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  timeZone: 'Africa/Kigali',
})

export const formatRwf = (amountInRwf: number) => rwandanFrancFormatter.format(amountInRwf)
export const formatCompactNumber = (value: number) => compactNumberFormatter.format(value)
export const formatDateTime = (isoTimestamp: string) =>
  dateTimeFormatter.format(new Date(isoTimestamp))
export const formatDate = (isoTimestamp: string) => dateFormatter.format(new Date(isoTimestamp))

const quantityFormatter = new Intl.NumberFormat('en', { maximumFractionDigits: 3 })

/** Quantities show up to 3 decimals without trailing zeros: 2, 1.5, 0.125. */
export const formatQuantity = (quantity: number) => quantityFormatter.format(quantity)

/** Basis points as a percentage: 1800 -> "18%", 250 -> "2.5%". */
export const formatBasisPoints = (basisPoints: number) =>
  `${new Intl.NumberFormat('en', { maximumFractionDigits: 2 }).format(basisPoints / 100)}%`

const longDateFormatter = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'long',
  year: 'numeric',
  timeZone: 'Africa/Kigali',
})

/** A plain YYYY-MM-DD date (such as a due date) as "12 October 2026", without time-zone shifts. */
export const formatPlainDate = (isoDate: string) =>
  longDateFormatter.format(new Date(`${isoDate}T12:00:00+02:00`))

export const formatLongDate = (isoTimestamp: string) =>
  longDateFormatter.format(new Date(isoTimestamp))
