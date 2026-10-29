/**
 * The mock invoice seeds carry fixed 2026 dates, while "overdue" and "due date cannot be in the past" are judged against the clock.
 * Tests that depend on those seeds pin only `Date` (timers keep running) to a day inside the seeds' own timeline, so they do not rot as the real date moves on.
 */
export const SEED_TODAY = '2026-10-11T18:00:00+02:00'

export function pinSeedClock(): void {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(SEED_TODAY))
}

export function restoreClock(): void {
  vi.useRealTimers()
}
