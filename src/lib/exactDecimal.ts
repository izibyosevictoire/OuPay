/**
 * Exact decimal arithmetic on plain decimal text, with BigInt. Quantities are NEVER floating point: 0.1 + 0.2 must be 0.3,
 * and a stock quantity must never be silently rounded. Only what the mock backend needs is here: parsing, moving the
 * decimal point (every unit factor is a power of ten) and printing.
 */
export interface ExactDecimal {
  /** The value is `unscaled / 10^scale`. */
  unscaled: bigint
  /** Never negative, and normalised: no trailing zeros in the fraction. */
  scale: number
}

const PLAIN_DECIMAL = /^(-?)([0-9]+)(?:\.([0-9]+))?$/

const normalise = (unscaled: bigint, scale: number): ExactDecimal => {
  let u = unscaled
  let s = scale
  while (s > 0 && u % 10n === 0n) {
    u /= 10n
    s -= 1
  }
  return { unscaled: u, scale: u === 0n ? 0 : s }
}

/** Plain decimal text only (`24`, `-0.75`). Exponents, signs other than a leading minus, separators: `null`. */
export function parseExactDecimal(text: string): ExactDecimal | null {
  const match = PLAIN_DECIMAL.exec(text.trim())
  if (!match) return null
  const [, sign = '', whole = '', fraction = ''] = match
  const unscaled = BigInt(`${whole}${fraction}`) * (sign === '-' ? -1n : 1n)
  return normalise(unscaled, fraction.length)
}

/** Multiplies by 10^places (negative places divide). Always exact. */
export function shiftDecimalPoint(value: ExactDecimal, places: number): ExactDecimal {
  const scale = value.scale - places
  if (scale >= 0) return normalise(value.unscaled, scale)
  return normalise(value.unscaled * 10n ** BigInt(-scale), 0)
}

/** Digits before the decimal point (0 for values below 1). */
export function integralDigits(value: ExactDecimal): number {
  const magnitude = value.unscaled < 0n ? -value.unscaled : value.unscaled
  const total = magnitude === 0n ? 0 : magnitude.toString().length
  return Math.max(0, total - value.scale)
}

export function formatExactDecimal(value: ExactDecimal): string {
  const negative = value.unscaled < 0n
  const digits = (negative ? -value.unscaled : value.unscaled)
    .toString()
    .padStart(value.scale + 1, '0')
  const whole = digits.slice(0, digits.length - value.scale)
  const fraction = digits.slice(digits.length - value.scale)
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`
}

/** Exact sum. */
export function addExactDecimals(a: ExactDecimal, b: ExactDecimal): ExactDecimal {
  const scale = Math.max(a.scale, b.scale)
  const left = a.unscaled * 10n ** BigInt(scale - a.scale)
  const right = b.unscaled * 10n ** BigInt(scale - b.scale)
  return normalise(left + right, scale)
}

export function negateExactDecimal(value: ExactDecimal): ExactDecimal {
  return { unscaled: -value.unscaled, scale: value.scale }
}

/** Exact product. */
export function multiplyExactDecimals(a: ExactDecimal, b: ExactDecimal): ExactDecimal {
  return normalise(a.unscaled * b.unscaled, a.scale + b.scale)
}

/** -1, 0 or 1. */
export function compareExactDecimals(a: ExactDecimal, b: ExactDecimal): -1 | 0 | 1 {
  const scale = Math.max(a.scale, b.scale)
  const left = a.unscaled * 10n ** BigInt(scale - a.scale)
  const right = b.unscaled * 10n ** BigInt(scale - b.scale)
  return left < right ? -1 : left > right ? 1 : 0
}
