import QRCode from 'qrcode'
import { useMemo } from 'react'
import { QUIET_ZONE } from './qrPng'

/**
 * A real, scannable QR code drawn as SVG from the `qrcode` library's module matrix. The exact
 * encoded text is exposed as `data-qr-value`, so tests (and anyone inspecting the page) can
 * confirm the code carries precisely the payment URL and nothing else.
 *
 * Colours are fixed black on white, whatever the theme: scanners need that contrast.
 */
export function QrCode({
  value,
  label,
  className,
}: {
  value: string
  label: string
  className?: string
}) {
  const { size, path } = useMemo(() => {
    const qr = QRCode.create(value, { errorCorrectionLevel: 'M' })
    const moduleCount = qr.modules.size
    let d = ''
    for (let y = 0; y < moduleCount; y += 1) {
      for (let x = 0; x < moduleCount; x += 1) {
        if (qr.modules.get(x, y)) d += `M${x + QUIET_ZONE} ${y + QUIET_ZONE}h1v1h-1z`
      }
    }
    return { size: moduleCount + QUIET_ZONE * 2, path: d }
  }, [value])

  return (
    <svg
      role="img"
      aria-label={label}
      data-qr-value={value}
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      className={className}
    >
      <rect width={size} height={size} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  )
}
