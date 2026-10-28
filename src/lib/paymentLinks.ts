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

export const NFC_TAG_REQUIREMENTS = [
  'An NDEF-capable tag such as NTAG213, NTAG215 or NTAG216 (NFC Forum Type 2). NTAG213 holds about 144 bytes, enough for one payment link.',
  'Write exactly one NDEF URI record containing the payment URL above. Do not add other records.',
  'Lock the tag after writing so nobody can overwrite it. Locking cannot be undone.',
  'Writing needs an NFC writer app or device. A web browser cannot program tags on every phone, so OuPay does not write tags for you yet.',
  'The tag only carries the link. Anyone can read it, so treat it as public. If a tag is lost or copied, revoke and replace the link.',
]
