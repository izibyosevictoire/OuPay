// SAMPLE DATA ONLY. These are mock invoices for development: not real customers, and the
// "PAID" / "PARTIALLY_PAID" states are pretend bank confirmations, not real payments.
import { calculateInvoice } from '@/lib/invoiceCalculations'
import type {
  BranchSnapshot,
  Invoice,
  InvoiceItemInput,
  InvoiceStatus,
  InvoicePaymentStatus,
  MerchantSnapshot,
  TaxMode,
  TaxRate,
} from '@/types/invoice'
import { DEMO_USER_IDS } from './sampleAccounts'
import { SAMPLE_BRANCH_IDS } from './sampleOrganization'
import { SAMPLE_MERCHANT_ID, SAMPLE_SECOND_MERCHANT_ID } from './sampleMerchants'

const NO_VAT: TaxRate = { category: 'NOT_APPLICABLE', rateBp: 0 }
const VAT_18: TaxRate = { category: 'STANDARD', rateBp: 1800 }

const SHOP: MerchantSnapshot = {
  legalName: 'Sample Business Ltd',
  tradingName: 'Sample Shop',
  tin: '100000001',
  registrationNumber: 'SMP-RDB-000123',
  address: 'KG 11 Ave, near Sample Plaza, Remera, Gasabo, Kigali City',
  phoneNumber: '+250788000001',
  email: 'owner@sample-business.example',
}
const CAFE: MerchantSnapshot = {
  legalName: 'Sample Corner Cafe',
  address: 'Nyamirambo main road, Nyamirambo, Nyarugenge, Kigali City',
  phoneNumber: '+250788000009',
  email: 'hello@sample-cafe.example',
}

const BRANCHES: Record<string, BranchSnapshot> = {
  [SAMPLE_BRANCH_IDS.remera]: {
    name: 'Remera Main',
    code: 'RM01',
    address: 'KG 11 Ave, near Sample Plaza',
  },
  [SAMPLE_BRANCH_IDS.cityCentre]: { name: 'City Centre', code: 'KCC', address: 'KN 4 Ave' },
  [SAMPLE_BRANCH_IDS.nyamirambo]: {
    name: 'Nyamirambo Kiosk',
    code: 'NYA1',
    address: 'Nyamirambo market, stall 12',
  },
  [SAMPLE_BRANCH_IDS.cafe]: {
    name: 'Cafe Nyamirambo',
    code: 'CAF1',
    address: 'Nyamirambo main road',
  },
}

const PEOPLE = {
  owner: { id: DEMO_USER_IDS.owner, name: 'Sample Owner' },
  aline: { id: DEMO_USER_IDS.cashier, name: 'Aline Uwase' },
  grace: { id: DEMO_USER_IDS.manager, name: 'Grace Mukamana' },
  claudine: { id: DEMO_USER_IDS.cafeOwner, name: 'Claudine Mukashema' },
}

const line = (
  description: string,
  quantity: number,
  unitPrice: number,
  taxRate: TaxRate = NO_VAT,
  discount = 0,
): InvoiceItemInput => ({ description, quantity, unitPrice, discount, taxRate })

interface SeedInvoice {
  number: string
  merchantId?: string
  branchId: string
  creator: { id: string; name: string }
  assignee: { id: string; name: string }
  customerName: string
  items: InvoiceItemInput[]
  taxMode?: TaxMode
  status: InvoiceStatus
  paymentStatus?: InvoicePaymentStatus
  createdAt: string
  issuedAt?: string
  dueAt: string
  notes?: string
  extra?: Partial<Invoice>
}

function seed(spec: SeedInvoice): Invoice {
  const merchantId = spec.merchantId ?? SAMPLE_MERCHANT_ID
  const taxMode = spec.taxMode ?? 'EXCLUSIVE'
  const calculation = calculateInvoice(
    spec.items,
    taxMode,
    spec.items.map((_, i) => `${spec.number}-item-${i + 1}`),
  )
  return {
    id: `inv-${spec.number.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    merchantId,
    branchId: spec.branchId,
    invoiceNumber: spec.number,
    createdByUserId: spec.creator.id,
    createdByName: spec.creator.name,
    assignedToUserId: spec.assignee.id,
    assignedToName: spec.assignee.name,
    customer: { name: spec.customerName },
    merchantSnapshot: merchantId === SAMPLE_MERCHANT_ID ? SHOP : CAFE,
    branchSnapshot: BRANCHES[spec.branchId]!,
    items: calculation.items,
    currency: 'RWF',
    taxMode,
    subtotal: calculation.subtotal,
    discountTotal: calculation.discountTotal,
    taxTotal: calculation.taxTotal,
    grandTotal: calculation.grandTotal,
    issuedAt: spec.issuedAt,
    dueAt: spec.dueAt,
    createdAt: spec.createdAt,
    updatedAt: spec.issuedAt ?? spec.createdAt,
    status: spec.status,
    paymentStatus: spec.paymentStatus ?? 'UNPAID',
    notes: spec.notes,
    version: 1,
    ...spec.extra,
  }
}

export const SAMPLE_INVOICES: Invoice[] = [
  seed({
    number: 'SMP-INV-1046',
    branchId: SAMPLE_BRANCH_IDS.nyamirambo, // this branch has since been deactivated
    creator: PEOPLE.aline,
    assignee: PEOPLE.aline,
    customerName: 'Test Customer',
    items: [line('Phone charger', 1, 8000)],
    status: 'VOIDED',
    createdAt: '2026-09-20T10:00:00+02:00',
    issuedAt: '2026-09-20T10:05:00+02:00',
    dueAt: '2026-09-27',
    extra: {
      voidedAt: '2026-09-22T09:00:00+02:00',
      voidReason: 'Issued to the wrong customer',
      updatedAt: '2026-09-22T09:00:00+02:00',
      version: 3,
    },
  }),
  seed({
    number: 'SMP-INV-1045',
    branchId: SAMPLE_BRANCH_IDS.remera,
    creator: PEOPLE.aline,
    assignee: PEOPLE.aline,
    customerName: 'Walk-in customer',
    items: [line('Notebook', 2, 1500)],
    status: 'CANCELLED',
    createdAt: '2026-09-25T14:00:00+02:00',
    dueAt: '2026-10-02',
    extra: {
      cancelledAt: '2026-09-25T14:10:00+02:00',
      updatedAt: '2026-09-25T14:10:00+02:00',
      version: 2,
    },
  }),
  seed({
    number: 'SMP-INV-1044',
    branchId: SAMPLE_BRANCH_IDS.remera,
    creator: PEOPLE.owner,
    assignee: PEOPLE.grace,
    customerName: 'Kivu Fresh Foods Ltd',
    items: [line('Catering supplies', 20, 28_000, VAT_18), line('Delivery', 1, 40_000, VAT_18)],
    status: 'ISSUED',
    createdAt: '2026-10-08T09:00:00+02:00',
    issuedAt: '2026-10-08T09:30:00+02:00',
    dueAt: '2026-10-20',
    notes: 'Payment by bank transfer preferred.',
  }),
  seed({
    number: 'SMP-INV-1043',
    branchId: SAMPLE_BRANCH_IDS.cityCentre,
    creator: PEOPLE.aline,
    assignee: PEOPLE.aline,
    customerName: 'Umuhuza Hardware',
    items: [line('Cement bags', 10, 12_500, VAT_18), line('Paint 5L', 3, 22_000, VAT_18, 3000)],
    status: 'ISSUED',
    paymentStatus: 'PARTIALLY_PAID',
    createdAt: '2026-10-10T11:00:00+02:00',
    issuedAt: '2026-10-10T11:20:00+02:00',
    dueAt: '2026-10-15',
  }),
  seed({
    number: 'SMP-INV-1042',
    branchId: SAMPLE_BRANCH_IDS.remera,
    creator: PEOPLE.aline,
    assignee: PEOPLE.aline,
    customerName: 'Imena Stationery',
    items: [line('Printer paper (ream)', 12, 6000)],
    taxMode: 'INCLUSIVE',
    status: 'ISSUED',
    paymentStatus: 'PAID',
    createdAt: '2026-10-05T08:30:00+02:00',
    issuedAt: '2026-10-05T08:45:00+02:00',
    dueAt: '2026-10-12',
  }),
  seed({
    number: 'SMP-INV-1041',
    branchId: SAMPLE_BRANCH_IDS.remera,
    creator: PEOPLE.aline,
    assignee: PEOPLE.aline,
    customerName: 'Bella Salon & Spa',
    items: [line('Hair products set', 4, 24_500)],
    status: 'ISSUED',
    createdAt: '2026-09-28T13:00:00+02:00',
    issuedAt: '2026-09-28T13:15:00+02:00',
    dueAt: '2026-10-05',
  }),
  seed({
    number: 'SMP-INV-1040',
    branchId: SAMPLE_BRANCH_IDS.cityCentre,
    creator: PEOPLE.owner,
    assignee: PEOPLE.aline,
    customerName: 'Nyabugogo Logistics',
    items: [line('Packaging materials', 50, 5000, VAT_18)],
    status: 'DRAFT',
    createdAt: '2026-10-11T16:00:00+02:00',
    dueAt: '2026-10-28',
  }),
  seed({
    number: 'SMP-CAFE-2001',
    merchantId: SAMPLE_SECOND_MERCHANT_ID,
    branchId: SAMPLE_BRANCH_IDS.cafe,
    creator: PEOPLE.claudine,
    assignee: PEOPLE.owner,
    customerName: 'Sample Catering Client',
    items: [line('Coffee and pastries platter', 4, 12_000)],
    status: 'ISSUED',
    createdAt: '2026-10-09T09:00:00+02:00',
    issuedAt: '2026-10-09T09:10:00+02:00',
    dueAt: '2026-10-18',
  }),
]
