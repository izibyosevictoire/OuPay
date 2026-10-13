import { todayInKigali } from '@/lib/invoiceLifecycle'
import type { Invoice } from '@/types/invoice'
import { SAMPLE_INVOICES } from '@/services/mock/sampleInvoices'
import {
  defaultInvoiceFormValues,
  draftInvoiceSchema,
  invoiceToFormValues,
  issueInvoiceSchema,
  itemsForPreview,
  parseAmount,
  parsePercentToBasisPoints,
  parseQuantity,
  taxRateFromChoice,
  toDraftInput,
  type InvoiceFormValues,
} from './invoiceSchemas'

const validValues = (overrides: Partial<InvoiceFormValues> = {}): InvoiceFormValues => ({
  ...defaultInvoiceFormValues(),
  customerName: 'Mama Jane Shop',
  branchId: 'brn-1',
  assignedToUserId: 'usr-1',
  items: [
    {
      description: 'Tea',
      quantity: '2',
      unitPrice: '1,500',
      discount: '',
      taxChoice: 'NOT_APPLICABLE',
      customRatePercent: '',
    },
  ],
  ...overrides,
})

const messages = (result: {
  success: boolean
  error?: { issues: { path: PropertyKey[]; message: string }[] }
}) => (result.error?.issues ?? []).map((issue) => `${issue.path.join('.')}: ${issue.message}`)

describe('parsing what people type', () => {
  it('parses whole francs, tolerating commas and spaces, blank as zero', () => {
    expect(parseAmount('1,500')).toBe(1500)
    expect(parseAmount(' 25 000 ')).toBe(25_000)
    expect(parseAmount('')).toBe(0)
    for (const bad of ['12.5', '-3', 'abc', '1e6', '12345678901'])
      expect(parseAmount(bad)).toBeNaN()
  })

  it('parses quantities with at most three decimals', () => {
    expect(parseQuantity('2')).toBe(2)
    expect(parseQuantity('1.250')).toBe(1.25)
    for (const bad of ['', '0.0001', '1.2345', '-1', 'x']) {
      expect(Number.isNaN(parseQuantity(bad)) || parseQuantity(bad) === 0).toBe(true)
    }
  })

  it('parses percentages to basis points, 0 to 100 with 2 decimals', () => {
    expect(parsePercentToBasisPoints('18')).toBe(1800)
    expect(parsePercentToBasisPoints('7.5')).toBe(750)
    expect(parsePercentToBasisPoints('0')).toBe(0)
    for (const bad of ['101', '-1', '5.555', '', 'abc'])
      expect(parsePercentToBasisPoints(bad)).toBeNaN()
  })

  it('maps tax choices to explicit categories, with no automatic VAT', () => {
    expect(defaultInvoiceFormValues().items[0]?.taxChoice).toBe('NOT_APPLICABLE')
    expect(taxRateFromChoice({ taxChoice: 'NOT_APPLICABLE', customRatePercent: '' })).toEqual({
      category: 'NOT_APPLICABLE',
      rateBp: 0,
    })
    expect(taxRateFromChoice({ taxChoice: 'EXEMPT', customRatePercent: '' })).toEqual({
      category: 'EXEMPT',
      rateBp: 0,
    })
    expect(taxRateFromChoice({ taxChoice: 'STANDARD', customRatePercent: '' })).toEqual({
      category: 'STANDARD',
      rateBp: 1800,
    })
    expect(taxRateFromChoice({ taxChoice: 'CUSTOM', customRatePercent: '5.5' })).toEqual({
      category: 'STANDARD',
      rateBp: 550,
    })
  })

  it('counts unfinished fields as zero in the live preview', () => {
    const items = itemsForPreview([
      {
        description: '',
        quantity: 'x',
        unitPrice: '',
        discount: '',
        taxChoice: 'STANDARD',
        customRatePercent: '',
      },
    ])
    expect(items[0]).toMatchObject({ quantity: 0, unitPrice: 0, discount: 0 })
  })
})

describe('saving a draft versus issuing', () => {
  it('accepts a complete form for both', () => {
    expect(draftInvoiceSchema.safeParse(validValues()).success).toBe(true)
    expect(issueInvoiceSchema.safeParse(validValues()).success).toBe(true)
  })

  it('requires the essentials even for a draft', () => {
    const result = draftInvoiceSchema.safeParse(
      validValues({ customerName: ' ', branchId: '', assignedToUserId: '', items: [] }),
    )
    const text = messages(result)
    expect(text).toContain('customerName: Customer name is required.')
    expect(text).toContain('branchId: Choose an active branch.')
    expect(text).toContain('assignedToUserId: Choose who this invoice is assigned to.')
    expect(text).toContain('items: Add at least one line item.')
  })

  it('lets a draft keep an unfinished price but not an invoice that is being issued', () => {
    const unfinished = validValues({
      items: [
        {
          description: 'Tea',
          quantity: '1',
          unitPrice: '',
          discount: '',
          taxChoice: 'NOT_APPLICABLE',
          customRatePercent: '',
        },
      ],
    })
    expect(draftInvoiceSchema.safeParse(unfinished).success).toBe(true)
    const issue = issueInvoiceSchema.safeParse(unfinished)
    expect(issue.success).toBe(false)
    expect(messages(issue).join(' ')).toContain('Enter a price above 0 to issue.')
  })

  it('refuses a past due date only when issuing', () => {
    const past = validValues({ dueAt: '2020-01-01' })
    expect(draftInvoiceSchema.safeParse(past).success).toBe(true)
    expect(messages(issueInvoiceSchema.safeParse(past))).toContain(
      'dueAt: The due date cannot be in the past.',
    )
    expect(issueInvoiceSchema.safeParse(validValues({ dueAt: todayInKigali() })).success).toBe(true)
  })

  it('validates line items: description, quantity, whole prices, discounts and custom rates', () => {
    const bad = validValues({
      items: [
        {
          description: ' ',
          quantity: '0',
          unitPrice: '10.5',
          discount: 'x',
          taxChoice: 'CUSTOM',
          customRatePercent: '150',
        },
        {
          description: 'B',
          quantity: '1',
          unitPrice: '100',
          discount: '101',
          taxChoice: 'NOT_APPLICABLE',
          customRatePercent: '',
        },
      ],
    })
    const text = messages(draftInvoiceSchema.safeParse(bad)).join('\n')
    expect(text).toContain('items.0.description: Describe the item.')
    expect(text).toContain('items.0.quantity: Enter a quantity above 0')
    expect(text).toContain('items.0.unitPrice: Enter a whole amount in RWF.')
    expect(text).toContain('items.0.discount')
    expect(text).toContain('items.0.customRatePercent: Enter a rate from 0 to 100')
    expect(text).toContain('items.1.discount: The discount is larger than the line amount.')
  })

  it('validates the optional customer fields only when they are filled in', () => {
    expect(draftInvoiceSchema.safeParse(validValues()).success).toBe(true)
    const text = messages(
      draftInvoiceSchema.safeParse(
        validValues({ customerEmail: 'nope', customerPhone: '123', customerTin: '12' }),
      ),
    ).join('\n')
    expect(text).toContain('customerEmail')
    expect(text).toContain('customerPhone')
    expect(text).toContain('customerTin: A TIN has exactly 9 digits')
  })

  it('rejects an invoice whose total would be zero', () => {
    const free = validValues({
      items: [
        {
          description: 'Gift',
          quantity: '1',
          unitPrice: '0',
          discount: '',
          taxChoice: 'NOT_APPLICABLE',
          customRatePercent: '',
        },
      ],
    })
    expect(issueInvoiceSchema.safeParse(free).success).toBe(false)
  })
})

describe('mapping between the form and the domain', () => {
  it('builds a service input with integers, normalised phone and trimmed text', () => {
    const input = toDraftInput(
      validValues({
        customerPhone: '0788 123 456',
        customerEmail: '',
        notes: '  hello  ',
        customerName: ' Jane ',
      }),
    )
    expect(input.customer).toMatchObject({
      name: 'Jane',
      phoneNumber: '+250788123456',
      email: undefined,
    })
    expect(input.items[0]).toMatchObject({ quantity: 2, unitPrice: 1500, discount: 0 })
    expect(input.notes).toBe('hello')
  })

  it('round-trips an invoice through the form, preserving tax choices', () => {
    const invoice = SAMPLE_INVOICES.find((i) => i.invoiceNumber === 'SMP-INV-1043') as Invoice
    const values = invoiceToFormValues(invoice)
    expect(values.items.map((item) => item.taxChoice)).toEqual(['STANDARD', 'STANDARD'])
    expect(values.items[1]?.discount).toBe('3000')
    const back = toDraftInput(values)
    expect(back.items.map((item) => [item.quantity, item.unitPrice, item.discount])).toEqual(
      invoice.items.map((item) => [item.quantity, item.unitPrice, item.discount]),
    )
    expect(back.taxMode).toBe(invoice.taxMode)
  })

  it('represents a custom tax rate from history faithfully', () => {
    const base = SAMPLE_INVOICES[0] as Invoice
    const custom = {
      ...base,
      items: [{ ...base.items[0]!, taxRate: { category: 'STANDARD' as const, rateBp: 550 } }],
    }
    expect(invoiceToFormValues(custom).items[0]).toMatchObject({
      taxChoice: 'CUSTOM',
      customRatePercent: '5.5',
    })
  })
})
