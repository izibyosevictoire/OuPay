const DAY_MS = 86_400_000
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** The moment the Kigali examples were written for: the newest example event happens a little before it. */
export const KIGALI_FIXTURE_ANCHOR = '2026-11-07T08:00:00+02:00'

/** Whole days between the moment the examples were written for and `now` (never negative). */
export const daysSinceFixtureAnchor = (now: Date = new Date()): number =>
  Math.max(0, Math.floor((now.getTime() - Date.parse(KIGALI_FIXTURE_ANCHOR)) / DAY_MS))

/**
 * Moves every date in a piece of example data forward by a whole number of days, so the newest example is always about a day old whenever it is
 * shown. Whole days, so every time of day and every relationship between two records is unchanged. Pure: nothing is stored or sent anywhere.
 */
export function rebaseSeedDates<T>(value: T, days: number): T {
  if (days <= 0) return value
  const shift = (text: string): string => {
    if (ISO_DATE_TIME.test(text)) return new Date(Date.parse(text) + days * DAY_MS).toISOString()
    if (ISO_DATE.test(text)) return new Date(Date.parse(`${text}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10)
    return text
  }
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') return shift(node)
    if (Array.isArray(node)) return node.map(walk)
    if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, walk(child)]))
    return node
  }
  return walk(value) as T
}
