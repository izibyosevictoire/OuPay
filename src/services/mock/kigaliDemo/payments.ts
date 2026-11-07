// DEMO DATA ONLY (R9c). The payment side of the fictional Kigali Demo Supermarket. EVERY transaction, allocation, code and payment point below is
// SIMULATED. None of it came from a real bank, nothing here is an Equity confirmation, and no money moves.
import { calculateInvoice } from '@/lib/invoiceCalculations'
import type { BankConnection, PaymentDestination } from '@/types/banking'
import type { BranchSnapshot, Invoice, InvoiceItemInput, InvoiceStatus, InvoicePaymentStatus, MerchantSnapshot, TaxRate } from '@/types/invoice'
import type { AuditEntry, BankTransaction, PaymentAllocation } from '@/types/payment'
import type { PaymentProfile } from '@/types/paymentProfile'
import type { StoredPaymentRequest } from '../sampleLedger'
import type { StoredCodeAssignment, StoredCollectionCode } from '../sampleCollectionCodes'
import type { StoredAssignment, StoredDevice } from '../mockEntryDeviceService'
import { KD, KD_PEOPLE, KIGALI_BRANCHES, KIGALI_DEMO_MERCHANT_NAME } from './organization'

const NO_VAT: TaxRate = { category: 'NOT_APPLICABLE', rateBp: 0 }
const VAT_18: TaxRate = { category: 'STANDARD', rateBp: 1800 }

export const KD_BANK_ACCOUNT_ID = 'kd-bacc-001'
const CREATED = '2026-10-01T09:00:00+02:00'

// ---- simulated settlement account -----------------------------------------------------------------------------------------

export const KIGALI_BANK_CONNECTIONS: BankConnection[] = [
  {
    id: 'kd-bcn-001',
    merchantId: KD.merchantId,
    providerId: 'EQUITY_MOCK',
    status: 'CONNECTED',
    accountNickname: 'Demo collections account (simulated)',
    bankAccountId: KD_BANK_ACCOUNT_ID,
    maskedAccount: '••••0099',
    isSimulated: true,
    lastError: null,
    createdAt: CREATED,
    updatedAt: CREATED,
  },
]

export const KIGALI_PAYMENT_DESTINATIONS: PaymentDestination[] = [
  {
    id: 'kd-dst-001',
    merchantId: KD.merchantId,
    bankConnectionId: 'kd-bcn-001',
    label: 'Demo collections account (simulated)',
    bankAccountId: KD_BANK_ACCOUNT_ID,
    maskedAccount: '••••0099',
    providerId: 'EQUITY_MOCK',
    isSimulated: true,
    createdAt: CREATED,
  },
]

// ---- invoices --------------------------------------------------------------------------------------------------------------

const SNAPSHOT: MerchantSnapshot = {
  legalName: 'Kigali Demo Supermarket Ltd (demonstration)',
  tradingName: KIGALI_DEMO_MERCHANT_NAME,
  tin: '100000099',
  registrationNumber: 'DEMO-RDB-000001',
  address: 'KN 4 Ave (demonstration data), Nyarugenge, Kigali City',
  phoneNumber: KD_PEOPLE.owner.phone,
  email: KD_PEOPLE.owner.email,
}

const BRANCH_SNAPSHOTS: Record<string, BranchSnapshot> = Object.fromEntries(
  KIGALI_BRANCHES.map((b) => [b.id, { name: b.name, code: b.code, address: b.location.physicalAddress }]),
)

const person = (key: 'owner' | 'manager' | 'cashier') => ({ id: KD_PEOPLE[key].id, name: KD_PEOPLE[key].name })

const line = (description: string, quantity: number, unitPrice: number, taxRate: TaxRate = NO_VAT): InvoiceItemInput => ({
  description,
  quantity,
  unitPrice,
  discount: 0,
  taxRate,
})

interface SeedInvoice {
  number: string
  branchId: string
  creator: { id: string; name: string }
  assignee: { id: string; name: string }
  customerName: string
  items: InvoiceItemInput[]
  status: InvoiceStatus
  paymentStatus?: InvoicePaymentStatus
  createdAt: string
  issuedAt?: string
  dueAt: string
  notes?: string
}

function invoice(spec: SeedInvoice): Invoice {
  const calculation = calculateInvoice(spec.items, 'EXCLUSIVE', spec.items.map((_, i) => `${spec.number}-item-${i + 1}`))
  return {
    id: `inv-${spec.number.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    merchantId: KD.merchantId,
    branchId: spec.branchId,
    invoiceNumber: spec.number,
    createdByUserId: spec.creator.id,
    createdByName: spec.creator.name,
    assignedToUserId: spec.assignee.id,
    assignedToName: spec.assignee.name,
    customer: { name: spec.customerName },
    merchantSnapshot: SNAPSHOT,
    branchSnapshot: BRANCH_SNAPSHOTS[spec.branchId]!,
    items: calculation.items,
    currency: 'RWF',
    taxMode: 'EXCLUSIVE',
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
  }
}

/**
 * Four invoices for business customers. Their prices are the catalog prices (rice RWF 1,200 per kg, oil RWF 3,200 per litre, ...), and each
 * one that shows a payment has a matching SIMULATED transaction and allocation below, for exactly that amount.
 */
export const KIGALI_INVOICES: Invoice[] = [
  invoice({
    number: 'KDS-INV-2001',
    branchId: KD.branches.main,
    creator: person('manager'),
    assignee: person('cashier'),
    customerName: 'Umutoni Catering',
    items: [line('Rice (kg)', 100, 1_200), line('Cooking oil (l)', 20, 3_200, VAT_18)],
    status: 'ISSUED',
    paymentStatus: 'PAID',
    createdAt: '2026-10-21T09:00:00+02:00',
    issuedAt: '2026-10-21T09:15:00+02:00',
    dueAt: '2026-10-28',
  }),
  invoice({
    number: 'KDS-INV-2002',
    branchId: KD.branches.remera,
    creator: person('manager'),
    assignee: person('manager'),
    customerName: 'Gasabo Primary School',
    items: [line('Notebook A5 (pc)', 200, 800), line('Laundry soap bar (pc)', 50, 500)],
    status: 'ISSUED',
    paymentStatus: 'PARTIALLY_PAID',
    createdAt: '2026-10-27T10:00:00+02:00',
    issuedAt: '2026-10-27T10:20:00+02:00',
    dueAt: '2026-11-10',
  }),
  invoice({
    number: 'KDS-INV-2003',
    branchId: KD.branches.main,
    creator: person('owner'),
    assignee: person('cashier'),
    customerName: 'Nyamirambo Restaurant',
    items: [line('Sugar (kg)', 40, 1_500), line('Beans (kg)', 30, 1_400), line('Maize flour (kg)', 50, 1_100)],
    status: 'ISSUED',
    createdAt: '2026-11-04T11:00:00+02:00',
    issuedAt: '2026-11-04T11:10:00+02:00',
    dueAt: '2026-11-18',
    notes: 'Payment by transfer to the counter code.',
  }),
  invoice({
    number: 'KDS-INV-2004',
    branchId: KD.branches.kimironko,
    creator: person('owner'),
    assignee: person('owner'),
    customerName: 'Kimironko Guest House',
    items: [line('Bottled water 1.5 l (pc)', 120, 900, VAT_18), line('Soda 500 ml (pc)', 240, 600, VAT_18)],
    status: 'DRAFT',
    createdAt: '2026-11-06T15:00:00+02:00',
    dueAt: '2026-11-20',
  }),
]

const inv = (number: string) => KIGALI_INVOICES.find((i) => i.invoiceNumber === number)!

// ---- simulated bank events -------------------------------------------------------------------------------------------------

interface TxSpec {
  id: string
  amount: number
  status: BankTransaction['status']
  reference: string | null
  payer: string
  at: string
  paymentRequestId?: string | null
  review?: { state: 'NEEDS_REVIEW'; reason: string }
}

const tx = (spec: TxSpec): BankTransaction => ({
  id: spec.id,
  merchantId: KD.merchantId,
  bankAccountId: KD_BANK_ACCOUNT_ID,
  provider: 'EQUITY_MOCK',
  providerTransactionId: `SIM-TXN-${spec.id.toUpperCase()}`,
  providerEventId: `SIM-EVT-${spec.id.toUpperCase()}-1`,
  direction: 'INCOMING',
  amount: spec.amount,
  currency: 'RWF',
  paymentReference: spec.reference,
  payerDisplayName: spec.payer,
  providerOccurredAt: spec.at,
  receivedAt: spec.at,
  status: spec.status,
  createdAt: spec.at,
  updatedAt: spec.at,
  isSimulated: true,
  statusAppliedAt: spec.at,
  paymentRequestId: spec.paymentRequestId ?? null,
  reviewState: spec.review?.state ?? 'NONE',
  reviewReason: spec.review?.reason,
  version: 1,
})

export const KIGALI_BANK_TRANSACTIONS: BankTransaction[] = [
  tx({ id: 'kd-btx-001', amount: inv('KDS-INV-2001').grandTotal, status: 'CONFIRMED', reference: 'KDS-INV-2001', payer: 'Umutoni Catering', at: '2026-10-22T10:05:00+02:00' }),
  tx({ id: 'kd-btx-002', amount: 100_000, status: 'CONFIRMED', reference: 'KDS-INV-2002', payer: 'Gasabo Primary School', at: '2026-10-29T14:20:00+02:00' }),
  tx({ id: 'kd-btx-003', amount: inv('KDS-INV-2003').grandTotal, status: 'PENDING', reference: 'OP-DEMOKDS02', payer: 'Nyamirambo Restaurant', at: '2026-11-05T08:15:00+02:00', paymentRequestId: 'kd-pr-002' }),
  tx({ id: 'kd-btx-004', amount: 12_600, status: 'CONFIRMED', reference: 'OP-DEMOKDS01', payer: 'Walk-in customer', at: '2026-11-05T09:42:00+02:00', paymentRequestId: 'kd-pr-001' }),
  tx({ id: 'kd-btx-005', amount: 5_000, status: 'FAILED', reference: null, payer: 'Unknown payer', at: '2026-11-04T17:10:00+02:00' }),
  tx({ id: 'kd-btx-006', amount: 48_000, status: 'CONFIRMED', reference: 'KDS-INV-9999', payer: 'Nyabugogo Traders', at: '2026-11-03T16:05:00+02:00', review: { state: 'NEEDS_REVIEW', reason: 'The reference does not match any invoice.' } }),
]

const allocation = (id: string, transactionId: string, invoiceNumber: string, amount: number, at: string): PaymentAllocation => ({
  id,
  merchantId: KD.merchantId,
  bankTransactionId: transactionId,
  invoiceId: inv(invoiceNumber).id,
  amount,
  allocationStatus: 'ACTIVE',
  origin: 'AUTO_REFERENCE',
  createdByUserId: null,
  createdAt: at,
})

export const KIGALI_PAYMENT_ALLOCATIONS: PaymentAllocation[] = [
  allocation('kd-alc-001', 'kd-btx-001', 'KDS-INV-2001', inv('KDS-INV-2001').grandTotal, '2026-10-22T10:05:00+02:00'),
  allocation('kd-alc-002', 'kd-btx-002', 'KDS-INV-2002', 100_000, '2026-10-29T14:20:00+02:00'),
]

const entry = (id: string, transactionId: string, kind: AuditEntry['kind'], message: string, at: string, invoiceId: string | null = null): AuditEntry => ({
  id,
  merchantId: KD.merchantId,
  bankTransactionId: transactionId,
  invoiceId,
  kind,
  actorUserId: null,
  message,
  createdAt: at,
})

const money = (amount: number) => `RWF ${amount.toLocaleString('en-US')}`

export const KIGALI_AUDIT_ENTRIES: AuditEntry[] = [
  ...KIGALI_BANK_TRANSACTIONS.map((t, index) =>
    entry(`kd-aud-c-${index}`, t.id, 'TRANSACTION_CREATED', `Simulated ${t.status.toLowerCase()} event received from the simulated provider. This is demonstration data, not an Equity confirmation.`, t.createdAt),
  ),
  entry('kd-aud-a-001', 'kd-btx-001', 'AUTO_ALLOCATED', `Matched the exact reference KDS-INV-2001 and applied ${money(inv('KDS-INV-2001').grandTotal)}.`, '2026-10-22T10:05:01+02:00', inv('KDS-INV-2001').id),
  entry('kd-aud-a-002', 'kd-btx-002', 'AUTO_ALLOCATED', 'Matched the exact reference KDS-INV-2002 and applied RWF 100,000.', '2026-10-29T14:20:01+02:00', inv('KDS-INV-2002').id),
  entry('kd-aud-f-006', 'kd-btx-006', 'FLAGGED_FOR_REVIEW', 'The reference KDS-INV-9999 does not match any invoice, so nothing was applied.', '2026-11-03T16:05:01+02:00'),
]

// ---- payment profiles and requests ----------------------------------------------------------------------------------------

const profile = (n: number, slug: string, label: string, branchId: string | null, cashierId: string | null): PaymentProfile => ({
  id: `kd-pp-00${n}`,
  merchantId: KD.merchantId,
  paymentProfileId: slug,
  merchantDisplayName: KIGALI_DEMO_MERCHANT_NAME,
  label,
  branchId,
  assignedCashierId: cashierId,
  paymentDestinationId: 'kd-dst-001',
  status: 'ACTIVE',
  createdAt: CREATED,
  updatedAt: CREATED,
})

export const KIGALI_PAYMENT_PROFILES: PaymentProfile[] = [
  profile(1, 'Kd1mQ8vTz2Xn', 'Kigali Main counter', KD.branches.main, KD_PEOPLE.cashier.id),
  profile(2, 'Kd2wL3cYp9Ds', 'Remera counter', KD.branches.remera, null),
]

export const KIGALI_PAYMENT_REQUESTS: StoredPaymentRequest[] = [
  {
    id: 'kd-pr-001',
    merchantId: KD.merchantId,
    paymentProfileId: 'kd-pp-001',
    invoiceId: null,
    requestedAmount: 12_600,
    currency: 'RWF',
    publicReference: 'OP-DEMOKDS01',
    expiresAt: '2030-12-31T00:00:00Z',
    createdAt: '2026-11-05T09:30:00+02:00',
    updatedAt: '2026-11-05T09:30:00+02:00',
  },
  {
    id: 'kd-pr-002',
    merchantId: KD.merchantId,
    paymentProfileId: 'kd-pp-001',
    invoiceId: inv('KDS-INV-2003').id,
    requestedAmount: inv('KDS-INV-2003').grandTotal,
    currency: 'RWF',
    publicReference: 'OP-DEMOKDS02',
    expiresAt: '2030-12-31T00:00:00Z',
    createdAt: '2026-11-05T08:00:00+02:00',
    updatedAt: '2026-11-05T08:00:00+02:00',
  },
]

// ---- collection codes (SIMULATED) -------------------------------------------------------------------------------------------

const code = (n: number, fields: Partial<StoredCollectionCode> & Pick<StoredCollectionCode, 'internalRef' | 'displayLabel' | 'status'>): StoredCollectionCode => ({
  id: `kd-cc-00${n}`,
  merchantId: KD.merchantId,
  providerId: 'EQUITY_MOCK',
  settlementDestinationId: 'kd-dst-001',
  settlementAccountLabel: 'Demo collections account (simulated)',
  settlementAccountMasked: '••••0099',
  simulated: true,
  branchId: null,
  statusReason: null,
  bankRequestRef: null,
  externalCode: null,
  approval: null,
  clientOperationId: `00000000-0000-4000-b000-${String(n).padStart(12, '0')}`,
  fingerprint: `kd-seed-code-${n}`,
  createdByUserId: KD.users.owner,
  createdAt: '2026-10-03T09:00:00+02:00',
  updatedAt: '2026-10-03T09:00:00+02:00',
  seq: n,
  version: 0,
  ...fields,
})

const approval = (n: number) => ({ source: 'OPERATOR' as const, evidenceRef: 'SIMULATED-DEMO-EVIDENCE', approvedAt: `2026-10-0${n + 3}T10:00:00+02:00` })

/**
 * Two codes shown as ACTIVE so the demo can prepare and present a bill, and one still only REQUESTED, which shows the approval gate. Every one is
 * SIMULATED, on the simulated account: a bill made with one is a demonstration that can never be paid or shown as paid, and none of them is a real
 * Equity code or approval.
 */
export const KIGALI_COLLECTION_CODES: StoredCollectionCode[] = [
  code(1, { internalRef: 'CC-KDMAIN01', displayLabel: 'Kigali Main counter (simulated)', status: 'ACTIVE', branchId: KD.branches.main, externalCode: 'SIM-KGM1', approval: approval(1), updatedAt: '2026-10-04T10:00:00+02:00', version: 3 }),
  code(2, { internalRef: 'CC-KDREME02', displayLabel: 'Remera counter (simulated)', status: 'ACTIVE', branchId: KD.branches.remera, externalCode: 'SIM-RMR2', approval: approval(2), updatedAt: '2026-10-05T10:00:00+02:00', version: 3 }),
  code(3, { internalRef: 'CC-KDKIMI03', displayLabel: 'Kimironko counter (request only)', status: 'REQUESTED', branchId: KD.branches.kimironko, statusReason: 'An internal request only: nothing has been sent to Equity, and OuPay has no confirmation from the bank.' }),
]

const codeAssignment = (n: number, fields: Partial<StoredCodeAssignment> & Pick<StoredCodeAssignment, 'codeId' | 'assigneeName' | 'assigneeKind'>): StoredCodeAssignment => ({
  id: `kd-cca-00${n}`,
  merchantId: KD.merchantId,
  membershipId: null,
  assigneeUserId: null,
  assigneeRole: null,
  collectionPointLabel: null,
  branchId: null,
  branchName: null,
  branchCode: null,
  validFrom: '2026-10-04T11:00:00+02:00',
  validTo: null,
  assignedByName: KD_PEOPLE.owner.name,
  endedByName: null,
  endReason: null,
  seq: n,
  ...fields,
})

export const KIGALI_CODE_ASSIGNMENTS: StoredCodeAssignment[] = [
  codeAssignment(1, { codeId: 'kd-cc-001', assigneeKind: 'MEMBER', membershipId: KD.memberships.cashier, assigneeUserId: KD.users.cashier, assigneeName: KD_PEOPLE.cashier.name, assigneeRole: 'CASHIER', branchId: KD.branches.main, branchName: 'Kigali Main', branchCode: 'KGM1' }),
  codeAssignment(2, { codeId: 'kd-cc-002', assigneeKind: 'MEMBER', membershipId: KD.memberships.manager, assigneeUserId: KD.users.manager, assigneeName: KD_PEOPLE.manager.name, assigneeRole: 'MANAGER', branchId: KD.branches.remera, branchName: 'Remera', branchCode: 'RMR2', validFrom: '2026-10-05T11:00:00+02:00' }),
]

// ---- payment points: two static QR codes and one NFC bracelet --------------------------------------------------------------

const device = (n: number, type: StoredDevice['deviceType'], token: string, name: string, branchId: string, cashierUserId: string | null): StoredDevice => ({
  id: `kd-dev-00${n}`,
  merchantId: KD.merchantId,
  deviceType: type,
  token,
  displayName: name,
  branchId,
  cashierUserId,
  status: 'ACTIVE',
  statusReason: null,
  clientRequestId: `00000000-0000-4000-c000-${String(n).padStart(12, '0')}`,
  createdByUserId: KD.users.owner,
  createdAt: '2026-10-06T09:00:00+02:00',
  updatedAt: '2026-10-06T09:00:00+02:00',
  version: 0,
})

/** The demo tokens are fixed, public and fictional: scanning one opens the DEMO customer page, never a real payment. */
export const KD_DEVICE_TOKENS = {
  qrMain: 'KdDemoQrKigaliMain0001',
  qrRemera: 'KdDemoQrRemeraCounter2',
  braceletCashier: 'KdDemoNfcBraceletTag03',
} as const

export const KIGALI_ENTRY_DEVICES: StoredDevice[] = [
  device(1, 'STATIC_QR', KD_DEVICE_TOKENS.qrMain, 'Kigali Main counter QR', KD.branches.main, null),
  device(2, 'STATIC_QR', KD_DEVICE_TOKENS.qrRemera, 'Remera counter QR', KD.branches.remera, null),
  device(3, 'NFC_BRACELET', KD_DEVICE_TOKENS.braceletCashier, 'Cashier bracelet (Patrick)', KD.branches.main, KD.users.cashier),
]

export const KIGALI_ENTRY_DEVICE_ASSIGNMENTS: StoredAssignment[] = KIGALI_ENTRY_DEVICES.map((d, index) => ({
  id: `kd-eda-00${index + 1}`,
  deviceId: d.id,
  branchId: d.branchId,
  branchName: KIGALI_BRANCHES.find((b) => b.id === d.branchId)!.name,
  cashierUserId: d.cashierUserId,
  cashierName: d.cashierUserId ? KD_PEOPLE.cashier.name : null,
  validFrom: d.createdAt,
  validTo: null,
  assignedBy: KD_PEOPLE.owner.name,
  reason: null,
}))
