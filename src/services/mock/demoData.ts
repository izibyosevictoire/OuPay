// DEMO EXPERIENCE ONLY (R9c): first-open initialisation and reset of the example data.
//
// The demo keeps everything in the browser's own storage, in the `oupay.demo.*` namespace. Nothing here can reach a server, a database or a
// real session: it only reads and writes the storage object it is given.
import { KIGALI_FIXTURE_ANCHOR, rebaseSeedDates } from '@/lib/rebaseDates'
import { MOCK_STORAGE_KEYS } from './mockStorageKeys'

// Kept importable from here: the demo's own tests and callers use these names.
export { KIGALI_FIXTURE_ANCHOR, rebaseSeedDates }
import type { MockSeedSet } from './seeds'

/** The minimal storage surface the demo needs (a `Storage`, or an in-memory stand-in in tests). */
export interface DemoStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** Storage prefixes the demo's own screens leave behind (cart retry ids, claim ids, ...): cleared by a reset so nothing stale survives it. */
const DEMO_SCOPED_PREFIXES = ['oupay.demo.', 'oupay.pos.', 'oupay.checkout.', 'oupay.codeCheckout.', 'oupay.kyc.', 'oupay.entry.'] as const

const DAY_MS = 86_400_000

/**
 * Writes every example collection exactly once, the first time the demo opens (when it has no `demoInitialisedAt`). After that it never
 * writes again, so edited records are never overwritten on a refresh: from then on the stored records ARE the demo.
 *
 * @returns true when it loaded the example data now, false when the demo was already initialised.
 */
export function initialiseDemoData(storage: DemoStorage, seeds: MockSeedSet, now: () => Date = () => new Date()): boolean {
  if (storage.getItem(MOCK_STORAGE_KEYS.demoInitialisedAt)) return false
  const opened = now()
  const days = Math.floor((opened.getTime() - Date.parse(KIGALI_FIXTURE_ANCHOR)) / DAY_MS)
  for (const collection of Object.keys(seeds) as (keyof MockSeedSet)[]) {
    storage.setItem(MOCK_STORAGE_KEYS[collection], JSON.stringify(rebaseSeedDates(seeds[collection], days)))
  }
  storage.setItem(MOCK_STORAGE_KEYS.demoInitialisedAt, opened.toISOString())
  return true
}

/** When the example data was first loaded in this browser, or null. */
export function demoInitialisedAt(storage: DemoStorage): string | null {
  return storage.getItem(MOCK_STORAGE_KEYS.demoInitialisedAt)
}

/** Every key of a `Storage` that begins with one of the prefixes. */
function keysWithPrefix(storage: Storage, prefixes: readonly string[]): string[] {
  const keys: string[] = []
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    if (key && prefixes.some((prefix) => key.startsWith(prefix))) keys.push(key)
  }
  return keys
}

/**
 * Removes the demo's records, its sign-in marker and its leftover screen state from the browser, so the next start loads the original
 * examples again. It only ever touches the demo's own `oupay.demo.*` keys and the demo screens' scoped retry keys: never the ordinary mock
 * namespace (`oupay.mock.*`) and nothing outside `oupay.`.
 */
export function clearDemoBrowserState(storages: { local: Storage; session: Storage }): number {
  let removed = 0
  for (const storage of [storages.local, storages.session]) {
    for (const key of keysWithPrefix(storage, DEMO_SCOPED_PREFIXES)) {
      storage.removeItem(key)
      removed += 1
    }
  }
  return removed
}
