// SAMPLE DATA ONLY. Fictional goods and services for the BUSINESS demo merchants; prices are whole RWF for ONE sale unit.
import type {
  CatalogItem,
  CatalogItemType,
  MeasurementDimension,
  MeasurementUnitCode,
  PriceVersion,
} from '@/types/catalog'
import { SAMPLE_MERCHANT_ID, SAMPLE_SECOND_MERCHANT_ID } from './sampleMerchants'

/** A package as stored: only the canonical quantity. The quantity in the sale unit is derived on every read. */
export interface StoredCatalogPackage {
  id: string
  itemId: string
  label: string
  quantityPerPackage: string
  canonicalUnit: MeasurementUnitCode
  active: boolean
  createdAt: string
  updatedAt: string
  version: number
}

export type StoredCatalogItem = Omit<CatalogItem, 'packages'> & { packages: StoredCatalogPackage[] }

/** One immutable price version of an item. */
export interface StoredPriceVersion extends PriceVersion {
  merchantId: string
  itemId: string
}

export const CATALOG_UNITS: Record<
  MeasurementUnitCode,
  { dimension: MeasurementDimension; exponent: number; name: string }
> = {
  pc: { dimension: 'COUNT', exponent: 0, name: 'Piece' },
  g: { dimension: 'MASS', exponent: 0, name: 'Gram' },
  kg: { dimension: 'MASS', exponent: 3, name: 'Kilogram' },
  ml: { dimension: 'VOLUME', exponent: 0, name: 'Millilitre' },
  l: { dimension: 'VOLUME', exponent: 3, name: 'Litre' },
  mm: { dimension: 'LENGTH', exponent: 0, name: 'Millimetre' },
  m: { dimension: 'LENGTH', exponent: 3, name: 'Metre' },
  mm2: { dimension: 'AREA', exponent: 0, name: 'Square millimetre' },
  m2: { dimension: 'AREA', exponent: 6, name: 'Square metre' },
}

export const CANONICAL_UNIT: Record<MeasurementDimension, MeasurementUnitCode> = {
  COUNT: 'pc',
  MASS: 'g',
  VOLUME: 'ml',
  LENGTH: 'mm',
  AREA: 'mm2',
}

const at = (minute: number) => `2026-09-10T08:${String(minute).padStart(2, '0')}:00+02:00`

interface SeedGoods {
  id: string
  merchantId: string
  type: CatalogItemType
  name: string
  code: string
  description?: string
  dimension: MeasurementDimension
  saleUnit: MeasurementUnitCode
  price: number
  active?: boolean
  minute: number
  packages?: { label: string; quantity: string }[]
}

const seedItem = (seed: SeedGoods): StoredCatalogItem => {
  const goods = seed.type === 'GOODS'
  return {
    id: seed.id,
    merchantId: seed.merchantId,
    itemType: seed.type,
    name: seed.name,
    description: seed.description ?? null,
    code: seed.code,
    active: seed.active ?? true,
    measurementDimension: seed.dimension,
    stockUnit: goods ? CANONICAL_UNIT[seed.dimension] : null,
    saleUnit: seed.saleUnit,
    pricePerSaleUnitRwf: seed.price,
    priceVersion: 1,
    packages: (seed.packages ?? []).map((p, index) => ({
      id: `${seed.id}-pkg-${index + 1}`,
      itemId: seed.id,
      label: p.label,
      quantityPerPackage: p.quantity,
      canonicalUnit: CANONICAL_UNIT[seed.dimension],
      active: true,
      createdAt: at(seed.minute),
      updatedAt: at(seed.minute),
      version: 0,
    })),
    createdAt: at(seed.minute),
    updatedAt: at(seed.minute),
    version: 0,
  }
}

const SEEDS: SeedGoods[] = [
  {
    id: 'cat-rice',
    merchantId: SAMPLE_MERCHANT_ID,
    type: 'GOODS',
    name: 'Rice',
    code: 'RICE',
    description: 'Long-grain rice, sold loose by the kilogram.',
    dimension: 'MASS',
    saleUnit: 'kg',
    price: 1_200,
    minute: 1,
    packages: [{ label: 'Bag', quantity: '25000' }],
  },
  {
    id: 'cat-oil',
    merchantId: SAMPLE_MERCHANT_ID,
    type: 'GOODS',
    name: 'Cooking oil',
    code: 'OIL',
    dimension: 'VOLUME',
    saleUnit: 'l',
    price: 3_200,
    minute: 2,
    packages: [
      { label: 'Bottle', quantity: '750' },
      { label: 'Jerrycan', quantity: '20000' },
    ],
  },
  {
    id: 'cat-cement',
    merchantId: SAMPLE_MERCHANT_ID,
    type: 'GOODS',
    name: 'Cement',
    code: 'CEMENT',
    description: 'Portland cement, priced per kilogram and sold by the bag.',
    dimension: 'MASS',
    saleUnit: 'kg',
    price: 290,
    minute: 3,
    packages: [{ label: 'Bag', quantity: '50000' }],
  },
  {
    id: 'cat-fabric',
    merchantId: SAMPLE_MERCHANT_ID,
    type: 'GOODS',
    name: 'Kitenge fabric',
    code: 'FABRIC',
    dimension: 'LENGTH',
    saleUnit: 'm',
    price: 4_500,
    minute: 4,
  },
  {
    id: 'cat-tiles',
    merchantId: SAMPLE_MERCHANT_ID,
    type: 'GOODS',
    name: 'Floor tiles',
    code: 'TILES',
    dimension: 'AREA',
    saleUnit: 'm2',
    price: 12_000,
    minute: 5,
    packages: [{ label: 'Box', quantity: '1440000' }],
  },
  {
    id: 'cat-phone',
    merchantId: SAMPLE_MERCHANT_ID,
    type: 'GOODS',
    name: 'Smartphone',
    code: 'PHONE',
    dimension: 'COUNT',
    saleUnit: 'pc',
    price: 85_000,
    minute: 6,
    packages: [{ label: 'Carton', quantity: '10' }],
  },
  {
    id: 'cat-feature-phone',
    merchantId: SAMPLE_MERCHANT_ID,
    type: 'GOODS',
    name: 'Feature phone (discontinued)',
    code: 'PHONE-OLD',
    dimension: 'COUNT',
    saleUnit: 'pc',
    price: 18_000,
    active: false,
    minute: 7,
  },
  {
    id: 'cat-haircut',
    merchantId: SAMPLE_MERCHANT_ID,
    type: 'SERVICE',
    name: 'Haircut',
    code: 'HAIRCUT',
    dimension: 'COUNT',
    saleUnit: 'pc',
    price: 3_000,
    minute: 8,
  },
  {
    id: 'cat-carwash',
    merchantId: SAMPLE_MERCHANT_ID,
    type: 'SERVICE',
    name: 'Car wash',
    code: 'CARWASH',
    description: 'Exterior wash and dry.',
    dimension: 'COUNT',
    saleUnit: 'pc',
    price: 5_000,
    minute: 9,
  },
  {
    id: 'cat-cafe-beans',
    merchantId: SAMPLE_SECOND_MERCHANT_ID,
    type: 'GOODS',
    name: 'Coffee beans',
    code: 'BEANS',
    dimension: 'MASS',
    saleUnit: 'kg',
    price: 18_000,
    minute: 10,
  },
]

export const SAMPLE_CATALOG_ITEMS: StoredCatalogItem[] = SEEDS.map((seed) => {
  const item = seedItem(seed)
  // Rice has had a price rise since it was listed, so its history has two versions.
  return seed.id === 'cat-rice' ? { ...item, priceVersion: 2, pricePerSaleUnitRwf: 1_200 } : item
})

export const SAMPLE_CATALOG_PRICES: StoredPriceVersion[] = SAMPLE_CATALOG_ITEMS.flatMap((item) => {
  const first: StoredPriceVersion = {
    merchantId: item.merchantId,
    itemId: item.id,
    version: 1,
    pricePerSaleUnitRwf: item.id === 'cat-rice' ? 1_100 : item.pricePerSaleUnitRwf,
    saleUnit: item.saleUnit,
    effectiveAt: item.createdAt,
    reason: null,
  }
  return item.id === 'cat-rice'
    ? [
        first,
        {
          ...first,
          version: 2,
          pricePerSaleUnitRwf: 1_200,
          effectiveAt: '2026-09-20T09:00:00+02:00',
          reason: 'Supplier price increase',
        },
      ]
    : [first]
})
