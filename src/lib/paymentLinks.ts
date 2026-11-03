/**
 * Public payment URLs. The base URL is configurable (VITE_PUBLIC_PAYMENT_BASE_URL). The default,
 * https://pay.oupay.rw, is ILLUSTRATIVE: it is not a confirmed, deployed domain.
 *
 * A payment URL is a public identifier, not a credential. It contains an opaque token and
 * never any banking detail.
 */
export const DEFAULT_PUBLIC_PAYMENT_BASE_URL = 'https://pay.oupay.rw'

export function getPublicPaymentBaseUrl(): string {
  const configured = import.meta.env.VITE_PUBLIC_PAYMENT_BASE_URL
  return (configured || DEFAULT_PUBLIC_PAYMENT_BASE_URL).replace(/\/+$/, '')
}

export const buildProfileUrl = (paymentProfileId: string, baseUrl = getPublicPaymentBaseUrl()) =>
  `${baseUrl}/p/${paymentProfileId}`

export const buildRequestUrl = (
  paymentProfileId: string,
  publicReference: string,
  baseUrl = getPublicPaymentBaseUrl(),
) => `${baseUrl}/p/${paymentProfileId}/r/${publicReference}`

/** The customer's page of a code sale. The sale reference is a public identifier, never a credential. */
export const buildCodeSaleUrl = (saleReference: string, baseUrl = getPublicPaymentBaseUrl()) =>
  `${baseUrl}/code-sale/${saleReference}`
export const buildLocalCodeSalePath = (saleReference: string) => `/code-sale/${saleReference}`

/**
 * The PERMANENT entry URL of a payment-entry device (static QR, NFC tag or bracelet): the base plus the device's opaque path (`/e/{token}`).
 * A QR code and an NFC tag of the same device carry EXACTLY this string. It is a public identifier, not a credential: it contains no bank
 * detail, amount or person, and revoking the device disables it on the server.
 */
export const buildEntryUrl = (entryPath: string, baseUrl = getPublicPaymentBaseUrl()) =>
  `${baseUrl}${entryPath}`
export const buildLocalEntryPath = (entryPath: string) => entryPath

/** The same page inside this app, so the demo can be opened locally. */
export const buildLocalProfilePath = (paymentProfileId: string) => `/p/${paymentProfileId}`
export const buildLocalRequestPath = (paymentProfileId: string, publicReference: string) =>
  `/p/${paymentProfileId}/r/${publicReference}`

/**
 * What an NFC tag must contain: ONE NDEF record, well-known type "U" (URI), holding the public
 * payment URL. The tag only carries the link: it is not authentication, and a tag's hardware
 * UID is never trusted as proof of anything.
 */
export function describeNdefUriRecord(url: string) {
  return {
    recordType: 'Well-known URI (type "U")',
    url,
    payloadBytes: new TextEncoder().encode(url).length + 6, // URL plus NDEF header overhead
  }
}

/**
 * How to put a payment-entry device's permanent link on an NFC tag. Locking is deliberately NOT a step: it is optional, irreversible on some
 * tags, and unnecessary, because revoking the device disables the link on the server whatever the tag says.
 */
export const ENTRY_NFC_STEPS = [
  'Use an NDEF-capable tag such as NTAG213, NTAG215 or NTAG216 (NFC Forum Type 2). NTAG213 holds about 144 bytes, enough for this link.',
  'In an NFC writer app choose Write, then URL or URI, and paste exactly the permanent link above: https, no spaces, nothing added or changed. Write ONE record.',
  'Never write a sale amount, a sale reference, a name, a bank code or anything else on the tag. It only opens the payment point.',
  'Read the tag back with the same app and compare it with the link character by character. Then tap it with a phone and check that it opens the payment point page.',
  'You never rewrite the tag when the bill changes: the payment point shows whichever bill the cashier gives it.',
  'Locking the tag is OPTIONAL and cannot be undone on some tags. OuPay does not need it: if a tag is lost or copied, revoke the payment point and the link stops working everywhere.',
  'The tag only carries a link. Anyone can read or copy it, so treat it as public. OuPay does not write or provision tags for you.',
]

export const NFC_TAG_REQUIREMENTS = [
  'An NDEF-capable tag such as NTAG213, NTAG215 or NTAG216 (NFC Forum Type 2). NTAG213 holds about 144 bytes, enough for one payment link.',
  'Write exactly one NDEF URI record containing the payment URL above. Do not add other records.',
  'Lock the tag after writing so nobody can overwrite it. Locking cannot be undone.',
  'Writing needs an NFC writer app or device. A web browser cannot program tags on every phone, so OuPay does not write tags for you yet.',
  'The tag only carries the link. Anyone can read it, so treat it as public. If a tag is lost or copied, revoke and replace the link.',
]
