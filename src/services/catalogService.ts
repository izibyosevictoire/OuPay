import type {
  CatalogItem,
  CatalogItemPage,
  CatalogPackage,
  ChangeCatalogItemStatusInput,
  CreateCatalogItemInput,
  CreateCatalogPackageInput,
  ListCatalogItemsQuery,
  MeasurementUnitOption,
  PriceVersion,
  UpdateCatalogItemInput,
  UpdateCatalogPackageInput,
} from '@/types/catalog'

export type CatalogServiceErrorCode =
  | 'unauthenticated'
  /** Also used for businesses the caller does not belong to. */
  | 'not_found'
  | 'forbidden'
  | 'validation'
  | 'invalid_unit_configuration'
  | 'unsupported_unit'
  | 'dimension_mismatch'
  | 'invalid_quantity'
  | 'invalid_count'
  | 'precision_exceeded'
  | 'quantity_out_of_range'
  | 'invalid_package_conversion'
  | 'duplicate_code'
  /** A package name already used on that item. */
  | 'duplicate_label'
  | 'version_conflict'
  | 'catalog_unavailable'
  | 'service_unavailable'

export class CatalogServiceError extends Error {
  readonly code: CatalogServiceErrorCode

  constructor(code: CatalogServiceErrorCode, message: string) {
    super(message)
    this.name = 'CatalogServiceError'
    this.code = code
  }
}

/**
 * The goods-and-services catalog of a BUSINESS merchant. The server (or the mock) is authoritative for units, prices,
 * versions and permissions; the browser validates for convenience only. Quantities travel as plain decimal text and
 * prices as whole RWF. A price belongs to ONE sale unit; packages carry no price of their own.
 */
export interface CatalogService {
  /** The units the server supports, grouped by dimension. */
  listMeasurementUnits(merchantId: string): Promise<MeasurementUnitOption[]>
  /** Newest first, keyset-paged. `q` matches name or code, case-insensitively. */
  listItems(merchantId: string, query?: ListCatalogItemsQuery): Promise<CatalogItemPage>
  getItem(merchantId: string, itemId: string): Promise<CatalogItem>
  createItem(merchantId: string, input: CreateCatalogItemInput): Promise<CatalogItem>
  /** Type, dimension and stock unit never change. A new price or sale unit creates a new immutable price version. */
  updateItem(
    merchantId: string,
    itemId: string,
    input: UpdateCatalogItemInput,
  ): Promise<CatalogItem>
  /** Items are deactivated, never deleted, so history stays valid. */
  changeItemStatus(
    merchantId: string,
    itemId: string,
    input: ChangeCatalogItemStatusInput,
  ): Promise<CatalogItem>
  listPriceHistory(merchantId: string, itemId: string): Promise<PriceVersion[]>
  createPackage(
    merchantId: string,
    itemId: string,
    input: CreateCatalogPackageInput,
  ): Promise<CatalogPackage>
  updatePackage(
    merchantId: string,
    itemId: string,
    packageId: string,
    input: UpdateCatalogPackageInput,
  ): Promise<CatalogPackage>
}
