import { unitSymbol } from '@/constants/catalog'
import type { MeasurementUnitCode } from '@/types/catalog'

/**
 * Groups the digits of a plain decimal STRING with thousands separators without ever turning it into a number, so a quantity
 * such as 99999999999999.999999 prints exactly. Anything that is not plain decimal text is returned untouched.
 */
export function groupDecimalText(text: string): string {
  const match = /^(-?)([0-9]+)(?:\.([0-9]+))?$/.exec(text)
  if (!match) return text
  const [, sign = '', whole = '', fraction] = match
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${sign}${grouped}${fraction ? `.${fraction}` : ''}`
}

/** "497,000 g". */
export function formatStockQuantity(text: string, unit: MeasurementUnitCode): string {
  return `${groupDecimalText(text)} ${unitSymbol(unit)}`
}

/** A signed change: "+250 g" or "-3,500 g". */
export function formatStockChange(text: string, unit: MeasurementUnitCode): string {
  const grouped = groupDecimalText(text)
  return `${grouped.startsWith('-') ? grouped : `+${grouped}`} ${unitSymbol(unit)}`
}
