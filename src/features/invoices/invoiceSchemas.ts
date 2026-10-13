import { z } from 'zod'
import type { TaxChoice } from '@/constants/invoice'
import {
  emailField,
  isRwandanPhoneNumber,
  normalizeRwandanPhoneNumber,
} from '@/features/merchants/merchantSchemas'
import {
  calculateInvoice,
  countDecimals,
  MAX_QUANTITY_DECIMALS,
  RWANDA_STANDARD_VAT_RATE_BP,
} from '@/lib/invoiceCalculations'
import { todayInKigali } from '@/lib/invoiceLifecycle'
import type {
  Invoice,
  InvoiceDraftInput,
  InvoiceItemInput,
  TaxMode,
  TaxRate,
} from '@/types/invoice'

/*
 * Form values are strings (what people type). They are parsed into integers only at the
 * edge, by the helpers below, and the service recomputes every total itself.
 */

export interface InvoiceItemFormValues {
  description: string
  quantity: string
  unitPrice: string
  discount: string
  taxChoice: TaxChoice
  /** Only used when taxChoice is CUSTOM, as a percentage like "5" or "7.5". */
  customRatePercent: string
}

export interface InvoiceFormValues {
  customerName: string
  customerEmail: string
  customerPhone: string
  customerTin: string
  customerAddress: string
  branchId: string
  assignedToUserId: string
  taxMode: TaxMode
  dueAt: string
  notes: string
  items: InvoiceItemFormValues[]
}

export const EMPTY_ITEM: InvoiceItemFormValues = {
  description: '',
  quantity: '1',
  unitPrice: '',
  discount: '',
  // Nothing is assumed taxable: the default is "no VAT" until the user chooses otherwise.
  taxChoice: 'NOT_APPLICABLE',
  customRatePercent: '',
}

const addDays = (days: number) => {
  const date = new Date()
  date.setDate(date.getDate() + days)
  return todayInKigali(date)
}

export const defaultInvoiceFormValues = (): InvoiceFormValues => ({
  customerName: '',
  customerEmail: '',
  customerPhone: '',
  customerTin: '',
  customerAddress: '',
  branchId: '',
  assignedToUserId: '',
  taxMode: 'EXCLUSIVE',
  dueAt: addDays(14),
  notes: '',
  items: [{ ...EMPTY_ITEM }],
})

// ---- parsing -------------------------------------------------------------------------------

const clean = (value: string) => value.trim().replace(/[\s,]/g, '')

/** A whole number of francs; blank means 0. Returns NaN when it is not a valid amount. */
export function parseAmount(value: string): number {
  const text = clean(value)
  if (text === '') return 0
  return /^\d{1,10}$/.test(text) ? Number(text) : NaN
}

/** A quantity with at most 3 decimals. Returns NaN when invalid. */
export function parseQuantity(value: string): number {
  const text = clean(value)
  if (!/^\d{1,7}(\.\d+)?$/.test(text) || countDecimals(text) > MAX_QUANTITY_DECIMALS) return NaN
  return Number(text)
}

/** Percentage with at most 2 decimals, 0 to 100, as basis points. Returns NaN when invalid. */
export function parsePercentToBasisPoints(value: string): number {
  const text = clean(value)
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(text)) return NaN
  const percent = Number(text)
  return percent <= 100 ? Math.round(percent * 100) : NaN
}

export function taxRateFromChoice(
  item: Pick<InvoiceItemFormValues, 'taxChoice' | 'customRatePercent'>,
): TaxRate {
  switch (item.taxChoice) {
    case 'STANDARD':
      return { category: 'STANDARD', rateBp: RWANDA_STANDARD_VAT_RATE_BP }
    case 'CUSTOM': {
      const rateBp = parsePercentToBasisPoints(item.customRatePercent)
      return { category: 'STANDARD', rateBp: Number.isNaN(rateBp) ? 0 : rateBp }
    }
    default:
      return { category: item.taxChoice, rateBp: 0 }
  }
}

function taxChoiceFromRate(
  taxRate: TaxRate,
): Pick<InvoiceItemFormValues, 'taxChoice' | 'customRatePercent'> {
  if (taxRate.category !== 'STANDARD') return { taxChoice: taxRate.category, customRatePercent: '' }
  if (taxRate.rateBp === RWANDA_STANDARD_VAT_RATE_BP)
    return { taxChoice: 'STANDARD', customRatePercent: '' }
  return { taxChoice: 'CUSTOM', customRatePercent: String(taxRate.rateBp / 100) }
}

/** Items as numbers for live totals; anything not yet valid counts as zero. */
export function itemsForPreview(items: InvoiceItemFormValues[]): InvoiceItemInput[] {
  const orZero = (n: number) => (Number.isNaN(n) ? 0 : n)
  return items.map((item) => ({
    description: item.description,
    quantity: orZero(parseQuantity(item.quantity)),
    unitPrice: orZero(parseAmount(item.unitPrice)),
    discount: orZero(parseAmount(item.discount)),
    taxRate: taxRateFromChoice(item),
  }))
}

// ---- validation ----------------------------------------------------------------------------

const itemSchema = z
  .object({
    description: z
      .string()
      .trim()
      .min(1, 'Describe the item.')
      .max(200, 'Use 200 characters or fewer.'),
    quantity: z
      .string()
      .refine((value) => !Number.isNaN(parseQuantity(value)) && parseQuantity(value) > 0, {
        message: 'Enter a quantity above 0 (up to 3 decimals).',
      }),
    unitPrice: z.string().refine((value) => !Number.isNaN(parseAmount(value)), {
      message: 'Enter a whole amount in RWF.',
    }),
    discount: z.string().refine((value) => !Number.isNaN(parseAmount(value)), {
      message: 'Enter a whole amount in RWF, or leave blank.',
    }),
    taxChoice: z.enum(['NOT_APPLICABLE', 'EXEMPT', 'ZERO_RATED', 'STANDARD', 'CUSTOM']),
    customRatePercent: z.string(),
  })
  .superRefine((item, context) => {
    if (
      item.taxChoice === 'CUSTOM' &&
      Number.isNaN(parsePercentToBasisPoints(item.customRatePercent))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['customRatePercent'],
        message: 'Enter a rate from 0 to 100 (up to 2 decimals).',
      })
    }
    const quantity = parseQuantity(item.quantity)
    const unitPrice = parseAmount(item.unitPrice)
    const discount = parseAmount(item.discount)
    if (![quantity, unitPrice, discount].some(Number.isNaN)) {
      const gross = calculateInvoice(
        [
          {
            description: '',
            quantity,
            unitPrice,
            discount: 0,
            taxRate: { category: 'NOT_APPLICABLE', rateBp: 0 },
          },
        ],
        'EXCLUSIVE',
      ).subtotal
      if (discount > gross) {
        context.addIssue({
          code: 'custom',
          path: ['discount'],
          message: 'The discount is larger than the line amount.',
        })
      }
    }
  })

const optionalEmail = z
  .string()
  .trim()
  .refine((value) => value === '' || emailField.safeParse(value).success, {
    message: 'Enter a valid email address, or leave blank.',
  })
const optionalPhone = z
  .string()
  .trim()
  .refine((value) => value === '' || isRwandanPhoneNumber(value), {
    message: 'Enter a Rwandan mobile number like 0788 123 456, or leave blank.',
  })
const optionalTin = z
  .string()
  .trim()
  .refine((value) => value === '' || /^\d{9}$/.test(value), {
    message: 'A TIN has exactly 9 digits, or leave blank.',
  })

const baseFields = {
  customerName: z
    .string()
    .trim()
    .min(1, 'Customer name is required.')
    .max(120, 'Use 120 characters or fewer.'),
  customerEmail: optionalEmail,
  customerPhone: optionalPhone,
  customerTin: optionalTin,
  customerAddress: z.string().trim().max(200, 'Use 200 characters or fewer.'),
  branchId: z.string().min(1, 'Choose an active branch.'),
  assignedToUserId: z.string().min(1, 'Choose who this invoice is assigned to.'),
  taxMode: z.enum(['EXCLUSIVE', 'INCLUSIVE']),
  dueAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose a due date.'),
  notes: z.string().trim().max(1000, 'Use 1,000 characters or fewer.'),
  items: z
    .array(itemSchema)
    .min(1, 'Add at least one line item.')
    .max(50, 'An invoice can have at most 50 items.'),
}

/** Saving a draft: complete enough to identify and re-open. Prices may still be unfinished. */
export const draftInvoiceSchema = z.object(baseFields)

/** Issuing: everything a customer-facing invoice needs, with real amounts and a sensible due date. */
export const issueInvoiceSchema = z.object(baseFields).superRefine((values, context) => {
  values.items.forEach((item, index) => {
    if (parseAmount(item.unitPrice) <= 0 || Number.isNaN(parseAmount(item.unitPrice))) {
      context.addIssue({
        code: 'custom',
        path: ['items', index, 'unitPrice'],
        message: 'Enter a price above 0 to issue.',
      })
    }
  })
  if (values.dueAt && values.dueAt < todayInKigali()) {
    context.addIssue({
      code: 'custom',
      path: ['dueAt'],
      message: 'The due date cannot be in the past.',
    })
  }
  const { grandTotal } = calculateInvoice(itemsForPreview(values.items), values.taxMode)
  if (grandTotal <= 0) {
    context.addIssue({
      code: 'custom',
      path: ['items'],
      message: 'The invoice total must be above 0.',
    })
  }
})

// ---- mapping -------------------------------------------------------------------------------

export function toDraftInput(values: InvoiceFormValues): InvoiceDraftInput {
  const blank = (text: string) => text.trim() || undefined
  return {
    branchId: values.branchId,
    assignedToUserId: values.assignedToUserId,
    customer: {
      name: values.customerName.trim(),
      email: blank(values.customerEmail),
      phoneNumber: values.customerPhone.trim()
        ? normalizeRwandanPhoneNumber(values.customerPhone)
        : undefined,
      address: blank(values.customerAddress),
      tin: blank(values.customerTin),
    },
    items: itemsForPreview(values.items).map((item) => ({
      ...item,
      description: item.description.trim(),
    })),
    taxMode: values.taxMode,
    dueAt: values.dueAt,
    notes: blank(values.notes),
  }
}

export function invoiceToFormValues(invoice: Invoice): InvoiceFormValues {
  return {
    customerName: invoice.customer.name,
    customerEmail: invoice.customer.email ?? '',
    customerPhone: invoice.customer.phoneNumber ?? '',
    customerTin: invoice.customer.tin ?? '',
    customerAddress: invoice.customer.address ?? '',
    branchId: invoice.branchId,
    assignedToUserId: invoice.assignedToUserId,
    taxMode: invoice.taxMode,
    dueAt: invoice.dueAt,
    notes: invoice.notes ?? '',
    items: invoice.items.map((item) => ({
      description: item.description,
      quantity: String(item.quantity),
      unitPrice: String(item.unitPrice),
      discount: item.discount ? String(item.discount) : '',
      ...taxChoiceFromRate(item.taxRate),
    })),
  }
}
