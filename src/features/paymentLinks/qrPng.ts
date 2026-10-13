import QRCode from 'qrcode'

export const QUIET_ZONE = 4

/** A PNG of the same code, for saving or printing elsewhere. */
export const qrPngDataUrl = (value: string) =>
  QRCode.toDataURL(value, { errorCorrectionLevel: 'M', margin: QUIET_ZONE, width: 1024 })
