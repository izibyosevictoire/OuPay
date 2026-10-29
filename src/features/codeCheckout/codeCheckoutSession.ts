/**
 * A `scope` is the business AND the signed-in person ("merchantId.userId"): another person on the same tab never sees, or
 * continues, someone else's sale.
 *
 * Remembers, for this browser tab only (sessionStorage), the sale being billed and the sale on screen, so that a refresh or a lost
 * response never loses track of a sale and never creates a second one. Only identifiers are kept (the sale's id and its public
 * reference), never a bank code, an amount that could be trusted, or a secret: the sale itself is read again from the server.
 */
export interface CodeCheckoutAttempt {
  /** What the sale was: the same amount, note, code and branch is the same sale. Anything else is a new one. */
  payloadKey: string
  clientRequestId: string
  idempotencyKey: string
}

export interface RememberedCodeSale {
  saleId: string
  saleReference: string
}

const attemptKey = (scope: string) => `oupay.codeCheckout.attempt.${scope}`
const saleKey = (scope: string) => `oupay.codeCheckout.sale.${scope}`

const browserStorage = (): Storage | undefined => {
  try {
    return typeof window === 'undefined' ? undefined : window.sessionStorage
  } catch {
    return undefined
  }
}

export const payloadKeyOf = (amount: number, description: string, codeId: string) =>
  JSON.stringify([amount, description.trim(), codeId])

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
 * The ids to bill this sale with. The SAME sale (same payload) gets the SAME ids every time, so retrying after a lost response or a
 * refresh finds the sale the server already made instead of making another; a different sale gets fresh ids.
 */
export function attemptFor(
  scope: string,
  payloadKey: string,
  storage: Storage | undefined = browserStorage(),
): CodeCheckoutAttempt {
  const existing = read<CodeCheckoutAttempt>(storage, attemptKey(scope))
  if (existing && existing.payloadKey === payloadKey) return existing
  const fresh: CodeCheckoutAttempt = {
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

/** Storage is untrusted (anyone can edit it), so a remembered sale is only accepted when it has the exact shape the server makes. */
function isRemembered(value: unknown): value is RememberedCodeSale {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.saleId === 'string' &&
    /^[A-Za-z0-9-]{6,64}$/.test(v.saleId) &&
    typeof v.saleReference === 'string' &&
    /^OP-[A-Z0-9]{6,20}$/.test(v.saleReference)
  )
}

export function loadSale(
  scope: string,
  storage: Storage | undefined = browserStorage(),
): RememberedCodeSale | undefined {
  const sale = read<unknown>(storage, saleKey(scope))
  return isRemembered(sale) ? sale : undefined
}

export function rememberSale(
  scope: string,
  sale: RememberedCodeSale,
  storage: Storage | undefined = browserStorage(),
) {
  write(storage, saleKey(scope), { saleId: sale.saleId, saleReference: sale.saleReference })
}

export function forgetSale(scope: string, storage: Storage | undefined = browserStorage()) {
  try {
    storage?.removeItem(saleKey(scope))
  } catch {
    // ignore
  }
}
