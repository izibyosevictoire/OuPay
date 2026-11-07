/**
 * EXAMPLE DATA protection (R10).
 *
 * The built-in examples (the fictional Kigali Demo Supermarket) are shown on the ordinary pages for everyone to learn from. They are static,
 * read-only and never real: no example record may be sent to the server as if it were one. Every example record carries an identifier of the
 * fixtures; this module knows all of them, so the HTTP client (the one door to the real backend) can refuse any request that names one,
 * whatever bug or future screen tried to send it.
 */
import { KIGALI_BRANCH_ASSIGNMENTS, KIGALI_BRANCHES, KIGALI_MEMBERSHIPS, KIGALI_MERCHANTS, KIGALI_USERS } from '@/services/mock/kigaliDemo/organization'
import { KIGALI_CATALOG_ITEMS, KIGALI_INVENTORY_BALANCES, KIGALI_POS_DRAFTS, KIGALI_STOCK_MOVEMENTS } from '@/services/mock/kigaliDemo/commerce'
import {
  KIGALI_BANK_TRANSACTIONS,
  KIGALI_COLLECTION_CODES,
  KIGALI_ENTRY_DEVICES,
  KIGALI_INVOICES,
  KIGALI_PAYMENT_ALLOCATIONS,
  KIGALI_PAYMENT_PROFILES,
  KIGALI_PAYMENT_REQUESTS,
} from '@/services/mock/kigaliDemo/payments'

/** The words every example screen shows. */
export const EXAMPLE_LABEL = 'EXAMPLE DATA'

/** What the server says (in effect) when it is asked to act on an example. */
export const EXAMPLE_REFUSAL = 'Example data is read-only: it is not your data and can not be changed or sent anywhere.'

/** The fixtures name every record `kd-...` (or `inv-kds-...` for invoices): only those are identifiers, never an enum such as a provider name. */
const FIXTURE_ID = /^(kd-|inv-kds-)[a-z0-9-]+$/

let known: ReadonlySet<string> | null = null

/** Every identifier of an example record (a business, branch, person, item, stock line, cart, payment point, invoice, payment, ...). */
export function exampleIds(): ReadonlySet<string> {
  if (known) return known
  const ids = new Set<string>()
  const collect = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(collect)
    else if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        // Request and operation identifiers (client-made, UUID-shaped) are not record identifiers and are never shown, so they are not listed.
        if (/^(client|operation)/.test(key)) continue
        if (typeof value === 'string' && FIXTURE_ID.test(value) && (key === 'id' || key.endsWith('Id'))) ids.add(value)
        else collect(value)
      }
    }
  }
  collect([
    KIGALI_MERCHANTS,
    KIGALI_USERS,
    KIGALI_MEMBERSHIPS,
    KIGALI_BRANCHES,
    KIGALI_BRANCH_ASSIGNMENTS,
    KIGALI_CATALOG_ITEMS,
    KIGALI_INVENTORY_BALANCES,
    KIGALI_STOCK_MOVEMENTS,
    KIGALI_POS_DRAFTS,
    KIGALI_INVOICES,
    KIGALI_BANK_TRANSACTIONS,
    KIGALI_PAYMENT_ALLOCATIONS,
    KIGALI_PAYMENT_PROFILES,
    KIGALI_PAYMENT_REQUESTS,
    KIGALI_COLLECTION_CODES,
    KIGALI_ENTRY_DEVICES,
  ])
  // Nested records (packages, lines) carry ids too.
  for (const item of KIGALI_CATALOG_ITEMS) for (const pack of item.packages) ids.add(pack.id)
  known = ids
  return ids
}

export const isExampleId = (value: unknown): boolean => typeof value === 'string' && exampleIds().has(value)

/**
 * True when ANY string inside the value (a path segment, a query value, a body at any depth) is exactly the identifier of an example record.
 * Exact match only: free text a person types is never mistaken for an example.
 */
export function referencesExampleData(value: unknown): boolean {
  if (typeof value === 'string') return value.split('/').some(isExampleId)
  if (Array.isArray(value)) return value.some(referencesExampleData)
  if (value && typeof value === 'object') return Object.values(value).some(referencesExampleData)
  return false
}
