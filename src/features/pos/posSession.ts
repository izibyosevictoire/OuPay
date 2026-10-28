/**
 * A `scope` is the business AND the signed-in person ("merchantId.userId"): another person on the same tab never continues
 * someone else's attempt.
 *
 * Remembers, for this browser tab only (sessionStorage), the ids a cart is saved under, so a lost response or a refresh followed by
 * "save" again finds the draft the server already made instead of making another. Only random identifiers and a fingerprint of the
 * cart are kept: nothing about a person, a bank or a secret. Storage may be unavailable (private windows); then everything still
 * works, only without the memory.
 */
export interface PosAttempt {
  /** What the cart was: the same cart is the same draft. Anything else is a new one. */
  payloadKey: string
  /** The draft's permanent identifier, kept by the server for good. */
  clientRequestId: string
  /** The transport retry key. */
  idempotencyKey: string
}

const attemptKey = (scope: string) => `oupay.pos.attempt.${scope}`

const browserStorage = (): Storage | undefined => {
  try {
    return typeof window === 'undefined' ? undefined : window.sessionStorage
  } catch {
    return undefined
  }
}

function isAttempt(value: unknown): value is PosAttempt {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.payloadKey === 'string' &&
    typeof v.clientRequestId === 'string' &&
    typeof v.idempotencyKey === 'string'
  )
}

/**
 * The ids to save this cart with. The SAME cart gets the SAME ids every time, so retrying after a lost response finds the draft
 * the server already made; a different cart gets fresh ids, so an edited cart can never collide with the earlier one.
 */
export function attemptFor(
  scope: string,
  payloadKey: string,
  storage: Storage | undefined = browserStorage(),
): PosAttempt {
  try {
    const raw = storage?.getItem(attemptKey(scope))
    const existing: unknown = raw ? JSON.parse(raw) : undefined
    if (isAttempt(existing) && existing.payloadKey === payloadKey) return existing
  } catch {
    // Storage is a convenience, never a requirement.
  }
  const fresh: PosAttempt = {
    payloadKey,
    clientRequestId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
  }
  try {
    storage?.setItem(attemptKey(scope), JSON.stringify(fresh))
  } catch {
    // ignore
  }
  return fresh
}

export function forgetAttempt(scope: string, storage: Storage | undefined = browserStorage()) {
  try {
    storage?.removeItem(attemptKey(scope))
  } catch {
    // ignore
  }
}
