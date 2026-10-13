const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
/** Crockford-style alphabet: no 0/O or 1/I/L, so references are easy to read out and type. */
const REFERENCE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'

/** Uniformly random characters from `alphabet`, using the browser's cryptographic RNG. */
function randomString(alphabet: string, length: number): string {
  const limit = 256 - (256 % alphabet.length) // rejection sampling avoids modulo bias
  let result = ''
  while (result.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length * 2))
    for (const byte of bytes) {
      if (byte < limit && result.length < length) result += alphabet[byte % alphabet.length]
    }
  }
  return result
}

/**
 * An unpredictable public identifier for a payment link (62^12, about 71 bits). It is NOT a
 * secret or a credential: it only has to be impossible to guess or enumerate.
 */
export const generatePublicToken = (length = 12) => randomString(BASE62, length)

/** A high-entropy payment reference such as "OP-7KD92PQ4XM2R" (31^12, about 59 bits). */
export const generatePaymentReference = () => `OP-${randomString(REFERENCE_ALPHABET, 12)}`
