import { z } from 'zod'
import {
  CATALOG_CODE_PATTERN,
  CATALOG_MAX_CODE,
  CATALOG_MAX_DESCRIPTION,
  CATALOG_MAX_NAME,
  CATALOG_MAX_PACKAGE_LABEL,
  CATALOG_MAX_PRICE_RWF,
} from '@/constants/catalog'
import type {
  CatalogItem,
  CatalogPackage,
  CreateCatalogItemInput,
  CreateCatalogPackageInput,
  MeasurementDimension,
  MeasurementUnitCode,
  UpdateCatalogItemInput,
} from '@/types/catalog'

/**
 * UX validation only: it saves a round trip and points at the field. The server decides and its answer is always shown.
 * Form values are strings so the price and quantities are never turned into floating-point numbers on the way.
 */
export const catalogItemFormSchema = z
  .object({
    itemType: z.enum(['GOODS', 'SERVICE']),
    name: z
      .string()
      .trim()
      .min(1, 'Name is required.')
      .max(CATALOG_MAX_NAME, `Use ${CATALOG_MAX_NAME} characters or fewer.`),
    code: z
      .string()
      .trim()
      .max(CATALOG_MAX_CODE, `Use ${CATALOG_MAX_CODE} characters or fewer.`)
      .refine((value) => value === '' || CATALOG_CODE_PATTERN.test(value), {
        message:
          'Use letters, numbers, dots, hyphens or underscores, starting with a letter or number.',
      }),
    description: z
      .string()
      .trim()
      .max(CATALOG_MAX_DESCRIPTION, `Use ${CATALOG_MAX_DESCRIPTION} characters or fewer.`),
    measurementDimension: z.string(),
    saleUnit: z.string(),
    price: z
      .string()
      .trim()
      .min(1, 'Price is required.')
      .regex(/^[0-9]+$/, 'Enter a whole number of RWF, with no decimals or separators.')
      .refine((value) => Number(value) <= CATALOG_MAX_PRICE_RWF, {
        message: `The price cannot be more than RWF ${CATALOG_MAX_PRICE_RWF.toLocaleString('en-US')}.`,
      }),
    priceChangeReason: z.string().trim().max(200, 'Use 200 characters or fewer.'),
    active: z.boolean(),
  })
  .superRefine((value, context) => {
    if (value.itemType !== 'GOODS') return
    if (!value.measurementDimension) {
      context.addIssue({
        code: 'custom',
        path: ['measurementDimension'],
        message: 'Choose what the item is measured in.',
      })
    }
    if (!value.saleUnit) {
      context.addIssue({
        code: 'custom',
        path: ['saleUnit'],
        message: 'Choose the unit you sell it by.',
      })
    }
  })

export type CatalogItemFormValues = z.infer<typeof catalogItemFormSchema>

export const CATALOG_ITEM_FORM_DEFAULTS: CatalogItemFormValues = {
  itemType: 'GOODS',
  name: '',
  code: '',
  description: '',
  measurementDimension: '',
  saleUnit: '',
  price: '',
  priceChangeReason: '',
  active: true,
}

export const itemToFormValues = (item: CatalogItem): CatalogItemFormValues => ({
  itemType: item.itemType,
  name: item.name,
  code: item.code ?? '',
  description: item.description ?? '',
  measurementDimension: item.itemType === 'GOODS' ? item.measurementDimension : '',
  saleUnit: item.itemType === 'GOODS' ? item.saleUnit : '',
  price: String(item.pricePerSaleUnitRwf),
  priceChangeReason: '',
  active: item.active,
})

const optional = (value: string) => value || undefined

export function toCreateItemInput(values: CatalogItemFormValues): CreateCatalogItemInput {
  const goods = values.itemType === 'GOODS'
  return {
    itemType: values.itemType,
    name: values.name,
    description: optional(values.description),
    code: optional(values.code),
    measurementDimension: goods ? (values.measurementDimension as MeasurementDimension) : undefined,
    saleUnit: goods ? (values.saleUnit as MeasurementUnitCode) : undefined,
    pricePerSaleUnitRwf: Number(values.price),
    active: values.active,
  }
}

export function toUpdateItemInput(
  values: CatalogItemFormValues,
  expectedVersion: number,
): UpdateCatalogItemInput {
  return {
    expectedVersion,
    name: values.name,
    description: optional(values.description),
    code: optional(values.code),
    saleUnit: values.itemType === 'GOODS' ? (values.saleUnit as MeasurementUnitCode) : undefined,
    pricePerSaleUnitRwf: Number(values.price),
    priceChangeReason: optional(values.priceChangeReason),
  }
}

export const catalogPackageFormSchema = z.object({
  label: z
    .string()
    .trim()
    .min(1, 'Label is required.')
    .max(CATALOG_MAX_PACKAGE_LABEL, `Use ${CATALOG_MAX_PACKAGE_LABEL} characters or fewer.`),
  contentsAmount: z
    .string()
    .trim()
    .min(1, 'Enter how much one package holds.')
    .regex(/^[0-9]+(\.[0-9]+)?$/, 'Enter a plain number such as 24 or 0.75.')
    .refine((value) => /[1-9]/.test(value), { message: 'The amount must be greater than zero.' }),
  contentsUnit: z.string().min(1, 'Choose a unit.'),
})

export type CatalogPackageFormValues = z.infer<typeof catalogPackageFormSchema>

export const packageToFormValues = (
  pkg: CatalogPackage,
  item: CatalogItem,
): CatalogPackageFormValues => ({
  label: pkg.label,
  // Shown in the unit the item is sold in, which is exact: every unit factor is a power of ten.
  contentsAmount: pkg.quantityInSaleUnit,
  contentsUnit: item.saleUnit,
})

export const toPackageInput = (values: CatalogPackageFormValues): CreateCatalogPackageInput => ({
  label: values.label,
  contentsAmount: values.contentsAmount,
  contentsUnit: values.contentsUnit as MeasurementUnitCode,
})
