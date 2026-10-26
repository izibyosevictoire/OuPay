import { z } from 'zod'
import { INVENTORY_MAX_REASON, INVENTORY_MAX_REFERENCE } from '@/constants/inventory'
import type { CatalogItem, MeasurementUnitCode } from '@/types/catalog'
import type { StockOperation } from './inventoryQueries'

export type StockEntryKind = StockOperation['kind']

/**
 * UX validation only: it saves a round trip and points at the field. The server decides and its answer is always shown.
 * Quantities stay STRINGS from the form to the request, so they are never turned into floating-point numbers.
 */
const PLAIN_POSITIVE = /^[0-9]+(\.[0-9]+)?$/

export interface StockEntryFormValues {
  branchId: string
  itemId: string
  entryMode: 'amount' | 'package'
  amount: string
  unit: string
  packageId: string
  packageCount: string
  direction: 'IN' | 'OUT'
  reason: string
  reference: string
}

export const STOCK_ENTRY_DEFAULTS: StockEntryFormValues = {
  branchId: '',
  itemId: '',
  entryMode: 'amount',
  amount: '',
  unit: '',
  packageId: '',
  packageCount: '',
  direction: 'IN',
  reason: '',
  reference: '',
}

const isPositive = (text: string) => PLAIN_POSITIVE.test(text) && /[1-9]/.test(text)
const hasFraction = (text: string) => /\.[0-9]*[1-9]/.test(text)

/** The form schema for one kind of entry; `goods` lets it know whether the chosen item is counted in whole pieces. */
export function createStockEntrySchema(kind: StockEntryKind, goods: CatalogItem[]) {
  return z
    .object({
      branchId: z.string().min(1, 'Choose a branch.'),
      itemId: z.string().min(1, 'Choose an item.'),
      entryMode: z.enum(['amount', 'package']),
      amount: z.string().trim(),
      unit: z.string(),
      packageId: z.string(),
      packageCount: z.string().trim(),
      direction: z.enum(['IN', 'OUT']),
      reason: z
        .string()
        .trim()
        .max(INVENTORY_MAX_REASON, `Use ${INVENTORY_MAX_REASON} characters or fewer.`),
      reference: z
        .string()
        .trim()
        .max(INVENTORY_MAX_REFERENCE, `Use ${INVENTORY_MAX_REFERENCE} characters or fewer.`),
    })
    .superRefine((value, context) => {
      const item = goods.find((candidate) => candidate.id === value.itemId)
      const wholeOnly = item?.measurementDimension === 'COUNT'
      if (value.entryMode === 'amount') {
        if (!value.amount) {
          context.addIssue({ code: 'custom', path: ['amount'], message: 'Enter the quantity.' })
        } else if (!PLAIN_POSITIVE.test(value.amount)) {
          context.addIssue({
            code: 'custom',
            path: ['amount'],
            message: 'Enter a plain number such as 25 or 0.75, with no minus sign or separators.',
          })
        } else if (!isPositive(value.amount)) {
          context.addIssue({
            code: 'custom',
            path: ['amount'],
            message: 'The quantity must be greater than zero.',
          })
        } else if (wholeOnly && hasFraction(value.amount)) {
          context.addIssue({
            code: 'custom',
            path: ['amount'],
            message: 'Use a whole number of pieces.',
          })
        }
        if (!value.unit) {
          context.addIssue({ code: 'custom', path: ['unit'], message: 'Choose a unit.' })
        }
      } else {
        if (!value.packageId) {
          context.addIssue({ code: 'custom', path: ['packageId'], message: 'Choose a package.' })
        }
        if (!value.packageCount) {
          context.addIssue({
            code: 'custom',
            path: ['packageCount'],
            message: 'Enter how many packages.',
          })
        } else if (!isPositive(value.packageCount)) {
          context.addIssue({
            code: 'custom',
            path: ['packageCount'],
            message: 'Enter a number greater than zero, such as 2 or 1.5.',
          })
        }
      }
      if (kind === 'ADJUST' && !value.reason) {
        context.addIssue({
          code: 'custom',
          path: ['reason'],
          message: 'Give a reason for the adjustment.',
        })
      }
    })
}

/** The request for these values. `operationId` is the identity of this one submission. */
export function toStockOperation(
  kind: StockEntryKind,
  values: StockEntryFormValues,
  operationId: string,
): StockOperation {
  const base = {
    clientOperationId: operationId,
    branchId: values.branchId,
    itemId: values.itemId,
    reference: values.reference.trim() || undefined,
  }
  const quantity =
    values.entryMode === 'amount'
      ? { amount: values.amount.trim(), unit: values.unit as MeasurementUnitCode }
      : { packageId: values.packageId, packageCount: values.packageCount.trim() }
  const reason = values.reason.trim() || undefined
  if (kind === 'ADJUST') {
    return {
      kind,
      input: { ...base, ...quantity, direction: values.direction, reason: reason ?? '' },
    }
  }
  return { kind, input: { ...base, ...quantity, reason } }
}

/** What makes one submission different from another: when it changes, the operation identity must change too. */
export const submissionSignature = (kind: StockEntryKind, values: StockEntryFormValues) =>
  JSON.stringify(toStockOperation(kind, values, ''))
