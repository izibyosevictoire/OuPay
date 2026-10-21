import type { SimpleCheckoutResult } from '@/types/checkout'

/**
 * A `scope` is the business AND the signed-in person ("merchantId.userId"): another person on the same tab never sees, or
 * continues, someone else's sale.
 *
 * Remembers, for this browser tab only (sessionStorage), the sale being billed and the sale on screen, so that a refresh or a
 * lost response never loses track of a sale and never creates a second one. Only public identifiers are kept: a sale's ids and
 * its payment reference, nothing about a bank, a person or a secret. Storage may be unavailable (private windows); then
 * everything still works, only without the memory.
 */
export interface CheckoutAttempt {
  /** What the sale was: the same amount, note and branch is the same sale. Anything else is a new one. */
  payloadKey: string
  /** The sale's permanent identifier, kept by the server for good. */
  clientRequestId: string
  /** The transport retry key. */
  idempotencyKey: string
}

const attemptKey = (scope: string) => `oupay.checkout.attempt.${scope}`
const saleKey = (scope: string) => `oupay.checkout.sale.${scope}`

const browserStorage = (): Storage | undefined => {
  try {
    return typeof window === 'undefined' ? undefined : window.sessionStorage
  } catch {
    return undefined
  }
}

export const payloadKeyOf = (amount: number, description: string, branchId: string) =>
  JSON.stringify([amount, description.trim(), branchId])

function read<T>(storage: Storage | undefined, key: string): T | undefined {
  try {
    const raw = storage?.getItem(key)
    return raw ? (JSON.parse(raw) as T) : undefined
  } catch {
    return undefined
  }
}

function write(storage: Storage | undefined, key: string, value: unknown) {
  try {
    storage?.setItem(key, JSON.stringify(value))
  } catch {
    // Remembering is a convenience, never a requirement.
  }
}

/**
 * The ids to bill this sale with. The SAME sale (same payload) gets the SAME ids every time, so retrying after a lost response
 * or a refresh finds the sale the server already made instead of making another; a different sale gets fresh ids, so an edited
 * amount can never collide with the earlier one.
 */
export function attemptFor(
  scope: string,
  payloadKey: string,
  storage: Storage | undefined = browserStorage(),
): CheckoutAttempt {
  const existing = read<CheckoutAttempt>(storage, attemptKey(scope))
  if (existing && existing.payloadKey === payloadKey) return existing
  const fresh: CheckoutAttempt = {
    payloadKey,
    clientRequestId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
  }
  write(storage, attemptKey(scope), fresh)
  return fresh
}

export function forgetAttempt(scope: string, storage: Storage | undefined = browserStorage()) {
  try {
    storage?.removeItem(attemptKey(scope))
  } catch {
    // ignore
  }
}

/**
 * Storage is untrusted (anyone can edit it in the developer tools), and the remembered sale feeds a payment URL and a QR code, so
 * it is only accepted when every field has the exact shape the server produces.
 */
function isSale(value: unknown): value is SimpleCheckoutResult {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  const text = (key: string) => typeof v[key] === 'string'
  return (
    [
      'invoiceId',
      'invoiceNumber',
      'paymentRequestId',
      'description',
      'status',
      'expiresAt',
      'createdAt',
      'merchantDisplayName',
      'branchId',
      'branchName',
    ].every(text) &&
    typeof v.publicReference === 'string' &&
    /^[A-Za-z0-9-]{6,40}$/.test(v.publicReference) &&
    typeof v.profileToken === 'string' &&
    /^[A-Za-z0-9]{6,40}$/.test(v.profileToken) &&
    typeof v.amountRwf === 'number' &&
    Number.isSafeInteger(v.amountRwf) &&
    v.currency === 'RWF' &&
    v.paymentPath === `/p/${v.profileToken}/r/${v.publicReference}`
  )
}

export function loadSale(
  scope: string,
  storage: Storage | undefined = browserStorage(),
): SimpleCheckoutResult | undefined {
  const sale = read<unknown>(storage, saleKey(scope))
  return isSale(sale) ? sale : undefined
}

export function rememberSale(
  scope: string,
  sale: SimpleCheckoutResult,
  storage: Storage | undefined = browserStorage(),
) {
  write(storage, saleKey(scope), sale)
}

export function forgetSale(scope: string, storage: Storage | undefined = browserStorage()) {
  try {
    storage?.removeItem(saleKey(scope))
  } catch {
    // ignore
  }
}
