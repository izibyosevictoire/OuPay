import type { CatalogItemType, MeasurementDimension, MeasurementUnitCode } from '@/types/catalog'

export const CATALOG_ITEM_TYPE_LABELS: Record<CatalogItemType, string> = {
  GOODS: 'Goods',
  SERVICE: 'Service',
}

export const MEASUREMENT_DIMENSION_LABELS: Record<MeasurementDimension, string> = {
  COUNT: 'Count (pieces)',
  MASS: 'Weight',
  VOLUME: 'Volume',
  LENGTH: 'Length',
  AREA: 'Area',
}

/** Short symbols for display only. Which units exist and which belong together is decided by the server. */
export const MEASUREMENT_UNIT_SYMBOLS: Record<MeasurementUnitCode, string> = {
  pc: 'pc',
  g: 'g',
  kg: 'kg',
  ml: 'mL',
  l: 'L',
  mm: 'mm',
  m: 'm',
  mm2: 'mm²',
  m2: 'm²',
}

export const unitSymbol = (code: MeasurementUnitCode) => MEASUREMENT_UNIT_SYMBOLS[code] ?? code

/** What a price refers to, in plain words. */
export const PRICE_BASIS_EXPLANATION =
  'The price is for ONE selling unit (one kg, one litre, one piece, or one service). Packages have no price of their own: they are a convenient multiple of the selling unit.'

/** UX limits that mirror the server's. The server decides; these only save a round trip. */
export const CATALOG_MAX_PRICE_RWF = 1_000_000_000
export const CATALOG_MAX_NAME = 120
export const CATALOG_MAX_DESCRIPTION = 500
export const CATALOG_MAX_CODE = 40
export const CATALOG_MAX_PACKAGE_LABEL = 60
export const CATALOG_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
export const CATALOG_PAGE_SIZE = 20
