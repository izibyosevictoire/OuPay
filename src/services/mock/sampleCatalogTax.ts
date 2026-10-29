// SAMPLE DATA ONLY. Demonstration tax classifications for the sample catalog. They are NOT tax advice and make no claim about what is
// taxable in Rwanda: they exist so the demo can show a billable cart and a blocked one. One item is deliberately left UNCONFIGURED
// (Cement): an item with no classification can not be billed, and nothing is ever assumed.
import type { PosTaxCategory } from '@/types/pos'
import { SAMPLE_MERCHANT_ID } from './sampleMerchants'

export interface StoredCatalogTax {
  merchantId: string
  itemId: string
  category: PosTaxCategory
  rateBp: number
}

/** The treatments the DEMO "approves" for POS billing (the server's list is configuration and is empty until a business approves it). */
export const MOCK_APPROVED_TAX_TREATMENTS: readonly { category: PosTaxCategory; rateBp: number }[] =
  [
    { category: 'EXEMPT', rateBp: 0 },
    { category: 'ZERO_RATED', rateBp: 0 },
    { category: 'STANDARD', rateBp: 1800 },
  ]

export const approvedLabelsOf = () =>
  MOCK_APPROVED_TAX_TREATMENTS.map((t) =>
    t.category === 'STANDARD' ? `STANDARD ${(t.rateBp / 100).toFixed(2)}%` : t.category,
  ).sort()

const tax = (itemId: string, category: PosTaxCategory, rateBp = 0): StoredCatalogTax => ({
  merchantId: SAMPLE_MERCHANT_ID,
  itemId,
  category,
  rateBp,
})

export const SAMPLE_CATALOG_TAX: StoredCatalogTax[] = [
  tax('cat-rice', 'EXEMPT'),
  tax('cat-oil', 'STANDARD', 1800),
  tax('cat-fabric', 'STANDARD', 1800),
  tax('cat-tiles', 'STANDARD', 1800),
  tax('cat-phone', 'STANDARD', 1800),
  tax('cat-haircut', 'EXEMPT'),
  tax('cat-carwash', 'STANDARD', 1800),
]
