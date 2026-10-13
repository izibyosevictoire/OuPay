// SAMPLE DATA ONLY. Every transaction, allocation and payment link below is SIMULATED demo
// data. None of it came from a real bank, and nothing here is a real payment.
import type { BankConnection, PaymentDestination } from '@/types/banking'
import type { AuditEntry, BankTransaction, PaymentAllocation } from '@/types/payment'
import type { PaymentProfile, PaymentRequest } from '@/types/paymentProfile'
import { DEMO_USER_IDS } from './sampleAccounts'
import { SAMPLE_BRANCH_IDS } from './sampleOrganization'
import { SAMPLE_MERCHANT_ID, SAMPLE_SECOND_MERCHANT_ID } from './sampleMerchants'

export const SAMPLE_BANK_ACCOUNT_IDS = {
  shop: 'bacc-sample-001',
  cafe: 'bacc-sample-101',
} as const

const CREATED = '2026-09-02T09:00:00+02:00'

export const SAMPLE_BANK_CONNECTIONS: BankConnection[] = [
  {
    id: 'bcn-sample-001',
    merchantId: SAMPLE_MERCHANT_ID,
    providerId: 'EQUITY_MOCK',
    status: 'CONNECTED',
    accountNickname: 'Main collections account',
    bankAccountId: SAMPLE_BANK_ACCOUNT_IDS.shop,
    maskedAccount: '••••4821',
    isSimulated: true,
    lastError: null,
    createdAt: CREATED,
    updatedAt: CREATED,
  },
  {
    id: 'bcn-sample-101',
    merchantId: SAMPLE_SECOND_MERCHANT_ID,
    providerId: 'EQUITY_MOCK',
    status: 'CONNECTED',
    accountNickname: 'Cafe takings',
    bankAccountId: SAMPLE_BANK_ACCOUNT_IDS.cafe,
    maskedAccount: '••••7733',
    isSimulated: true,
    lastError: null,
    createdAt: CREATED,
    updatedAt: CREATED,
  },
]

export const SAMPLE_PAYMENT_DESTINATIONS: PaymentDestination[] = [
  {
    id: 'dst-sample-001',
    merchantId: SAMPLE_MERCHANT_ID,
    bankConnectionId: 'bcn-sample-001',
    label: 'Main collections account',
    bankAccountId: SAMPLE_BANK_ACCOUNT_IDS.shop,
    maskedAccount: '••••4821',
    providerId: 'EQUITY_MOCK',
    isSimulated: true,
    createdAt: CREATED,
  },
  {
    id: 'dst-sample-101',
    merchantId: SAMPLE_SECOND_MERCHANT_ID,
    bankConnectionId: 'bcn-sample-101',
    label: 'Cafe takings',
    bankAccountId: SAMPLE_BANK_ACCOUNT_IDS.cafe,
    maskedAccount: '••••7733',
    providerId: 'EQUITY_MOCK',
    isSimulated: true,
    createdAt: CREATED,
  },
]

interface TxSpec {
  id: string
  merchantId?: string
  accountId?: string
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
  merchantId: spec.merchantId ?? SAMPLE_MERCHANT_ID,
  bankAccountId: spec.accountId ?? SAMPLE_BANK_ACCOUNT_IDS.shop,
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

export const SAMPLE_BANK_TRANSACTIONS: BankTransaction[] = [
  tx({
    id: 'btx-001',
    amount: 72_000,
    status: 'CONFIRMED',
    reference: 'SMP-INV-1042',
    payer: 'Imena Stationery',
    at: '2026-10-05T09:10:00+02:00',
  }),
  tx({
    id: 'btx-002',
    amount: 100_000,
    status: 'CONFIRMED',
    reference: 'SMP-INV-1043',
    payer: 'Umuhuza Hardware',
    at: '2026-10-11T10:00:00+02:00',
  }),
  tx({
    id: 'btx-003',
    amount: 9_500,
    status: 'CONFIRMED',
    reference: null,
    payer: 'M. Uwase',
    at: '2026-10-11T14:31:00+02:00',
  }),
  tx({
    id: 'btx-004',
    amount: 128_500,
    status: 'PENDING',
    reference: 'OP-DEMOINV0044',
    payer: 'Kivu Fresh Foods',
    at: '2026-10-12T08:15:00+02:00',
    paymentRequestId: 'pr-sample-002',
  }),
  tx({
    id: 'btx-005',
    amount: 15_000,
    status: 'FAILED',
    reference: null,
    payer: 'Unknown payer',
    at: '2026-10-11T18:20:00+02:00',
  }),
  tx({
    id: 'btx-006',
    amount: 54_000,
    status: 'REVERSED',
    reference: 'SMP-INV-1041',
    payer: 'Bella Salon',
    at: '2026-10-09T11:12:00+02:00',
  }),
  tx({
    id: 'btx-007',
    amount: 260_000,
    status: 'CONFIRMED',
    reference: 'SMP-INV-9999',
    payer: 'Nyabugogo Logistics',
    at: '2026-10-10T16:05:00+02:00',
    review: { state: 'NEEDS_REVIEW', reason: 'The reference does not match any invoice.' },
  }),
  tx({
    id: 'btx-008',
    amount: 45_000,
    status: 'CONFIRMED',
    reference: 'OP-DEMO000001',
    payer: 'Walk-in customer',
    at: '2026-10-12T08:42:00+02:00',
    paymentRequestId: 'pr-sample-001',
  }),
  tx({
    id: 'btx-101',
    merchantId: SAMPLE_SECOND_MERCHANT_ID,
    accountId: SAMPLE_BANK_ACCOUNT_IDS.cafe,
    amount: 12_500,
    status: 'CONFIRMED',
    reference: 'SMP-CAFE-2001',
    payer: 'Sample Catering Client',
    at: '2026-10-11T12:30:00+02:00',
  }),
  tx({
    id: 'btx-102',
    merchantId: SAMPLE_SECOND_MERCHANT_ID,
    accountId: SAMPLE_BANK_ACCOUNT_IDS.cafe,
    amount: 7_000,
    status: 'PENDING',
    reference: null,
    payer: 'Cafe customer',
    at: '2026-10-12T09:05:00+02:00',
  }),
]

const allocation = (
  id: string,
  merchantId: string,
  bankTransactionId: string,
  invoiceId: string,
  amount: number,
  at: string,
  reversed = false,
): PaymentAllocation => ({
  id,
  merchantId,
  bankTransactionId,
  invoiceId,
  amount,
  allocationStatus: reversed ? 'REVERSED' : 'ACTIVE',
  origin: 'AUTO_REFERENCE',
  createdByUserId: null,
  createdAt: at,
  ...(reversed
    ? {
        reversedAt: '2026-10-09T15:00:00+02:00',
        reversedByUserId: null,
        reversalKind: 'BANK_REVERSAL' as const,
        reversalReason: 'The bank reversed the transaction.',
      }
    : {}),
})

export const SAMPLE_PAYMENT_ALLOCATIONS: PaymentAllocation[] = [
  allocation(
    'alc-001',
    SAMPLE_MERCHANT_ID,
    'btx-001',
    'inv-smp-inv-1042',
    72_000,
    '2026-10-05T09:10:00+02:00',
  ),
  allocation(
    'alc-002',
    SAMPLE_MERCHANT_ID,
    'btx-002',
    'inv-smp-inv-1043',
    100_000,
    '2026-10-11T10:00:00+02:00',
  ),
  allocation(
    'alc-006',
    SAMPLE_MERCHANT_ID,
    'btx-006',
    'inv-smp-inv-1041',
    54_000,
    '2026-10-09T11:12:00+02:00',
    true,
  ),
  allocation(
    'alc-101',
    SAMPLE_SECOND_MERCHANT_ID,
    'btx-101',
    'inv-smp-cafe-2001',
    12_500,
    '2026-10-11T12:30:00+02:00',
  ),
]

const entry = (
  id: string,
  merchantId: string,
  transactionId: string,
  kind: AuditEntry['kind'],
  message: string,
  at: string,
  invoiceId: string | null = null,
): AuditEntry => ({
  id,
  merchantId,
  bankTransactionId: transactionId,
  invoiceId,
  kind,
  actorUserId: null,
  message,
  createdAt: at,
})

export const SAMPLE_AUDIT_ENTRIES: AuditEntry[] = [
  ...SAMPLE_BANK_TRANSACTIONS.map((transaction, index) =>
    entry(
      `aud-c-${index}`,
      transaction.merchantId,
      transaction.id,
      'TRANSACTION_CREATED',
      `Simulated ${transaction.status.toLowerCase()} event received from the simulated Equity provider.`,
      transaction.createdAt,
    ),
  ),
  entry(
    'aud-a-001',
    SAMPLE_MERCHANT_ID,
    'btx-001',
    'AUTO_ALLOCATED',
    'Matched the exact reference SMP-INV-1042 and applied RWF 72,000.',
    '2026-10-05T09:10:01+02:00',
    'inv-smp-inv-1042',
  ),
  entry(
    'aud-a-002',
    SAMPLE_MERCHANT_ID,
    'btx-002',
    'AUTO_ALLOCATED',
    'Matched the exact reference SMP-INV-1043 and applied RWF 100,000.',
    '2026-10-11T10:00:01+02:00',
    'inv-smp-inv-1043',
  ),
  entry(
    'aud-a-006',
    SAMPLE_MERCHANT_ID,
    'btx-006',
    'AUTO_ALLOCATED',
    'Matched the exact reference SMP-INV-1041 and applied RWF 54,000.',
    '2026-10-09T11:12:01+02:00',
    'inv-smp-inv-1041',
  ),
  entry(
    'aud-r-006',
    SAMPLE_MERCHANT_ID,
    'btx-006',
    'BANK_REVERSAL',
    'The bank reversed this transaction; its allocation was reversed and the invoice balance restored.',
    '2026-10-09T15:00:00+02:00',
    'inv-smp-inv-1041',
  ),
  entry(
    'aud-f-007',
    SAMPLE_MERCHANT_ID,
    'btx-007',
    'FLAGGED_FOR_REVIEW',
    'The reference SMP-INV-9999 does not match any invoice, so nothing was applied.',
    '2026-10-10T16:05:01+02:00',
  ),
  entry(
    'aud-a-101',
    SAMPLE_SECOND_MERCHANT_ID,
    'btx-101',
    'AUTO_ALLOCATED',
    'Matched the exact reference SMP-CAFE-2001 and applied RWF 12,500.',
    '2026-10-11T12:30:01+02:00',
    'inv-smp-cafe-2001',
  ),
]

export const SAMPLE_PAYMENT_PROFILES: PaymentProfile[] = [
  {
    id: 'pp-sample-001',
    merchantId: SAMPLE_MERCHANT_ID,
    paymentProfileId: 'Rk4mQ8vTz2Xn',
    merchantDisplayName: 'Sample Shop',
    label: 'Shop counter',
    branchId: null,
    assignedCashierId: null,
    paymentDestinationId: 'dst-sample-001',
    status: 'ACTIVE',
    createdAt: CREATED,
    updatedAt: CREATED,
  },
  {
    id: 'pp-sample-002',
    merchantId: SAMPLE_MERCHANT_ID,
    paymentProfileId: 'Bn7wL3cYp9Ds',
    merchantDisplayName: 'Sample Shop',
    label: 'Aline at Remera Main',
    branchId: SAMPLE_BRANCH_IDS.remera,
    assignedCashierId: DEMO_USER_IDS.cashier,
    paymentDestinationId: 'dst-sample-001',
    status: 'ACTIVE',
    createdAt: CREATED,
    updatedAt: CREATED,
  },
  {
    id: 'pp-sample-003',
    merchantId: SAMPLE_MERCHANT_ID,
    paymentProfileId: 'Hs5tV2jMq8Gf',
    merchantDisplayName: 'Sample Shop',
    label: 'City Centre counter',
    branchId: SAMPLE_BRANCH_IDS.cityCentre,
    assignedCashierId: null,
    paymentDestinationId: 'dst-sample-001',
    status: 'INACTIVE',
    createdAt: CREATED,
    updatedAt: CREATED,
  },
  {
    id: 'pp-sample-004',
    merchantId: SAMPLE_MERCHANT_ID,
    paymentProfileId: 'Zc6uE4nWr1Ka',
    merchantDisplayName: 'Sample Shop',
    label: 'Old shop counter link',
    branchId: null,
    assignedCashierId: null,
    paymentDestinationId: 'dst-sample-001',
    status: 'REVOKED',
    createdAt: CREATED,
    updatedAt: '2026-10-01T09:00:00+02:00',
    replacedByProfileId: 'pp-sample-001',
  },
  {
    id: 'pp-sample-101',
    merchantId: SAMPLE_SECOND_MERCHANT_ID,
    paymentProfileId: 'Cf8xN3dQm5Wb',
    merchantDisplayName: 'Sample Corner Cafe',
    label: 'Cafe counter',
    branchId: null,
    assignedCashierId: null,
    paymentDestinationId: 'dst-sample-101',
    status: 'ACTIVE',
    createdAt: CREATED,
    updatedAt: CREATED,
  },
]

/** Stored requests carry no `status`: it is derived from the ledger on every read. */
export type StoredPaymentRequest = Omit<PaymentRequest, 'status'>

export const SAMPLE_PAYMENT_REQUESTS: StoredPaymentRequest[] = [
  {
    id: 'pr-sample-001',
    merchantId: SAMPLE_MERCHANT_ID,
    paymentProfileId: 'pp-sample-001',
    invoiceId: null,
    requestedAmount: 45_000,
    currency: 'RWF',
    publicReference: 'OP-DEMO000001',
    expiresAt: '2030-12-31T00:00:00Z',
    createdAt: '2026-10-12T08:30:00+02:00',
    updatedAt: '2026-10-12T08:30:00+02:00',
  },
  {
    id: 'pr-sample-002',
    merchantId: SAMPLE_MERCHANT_ID,
    paymentProfileId: 'pp-sample-002',
    invoiceId: 'inv-smp-inv-1044',
    requestedAmount: 708_000,
    currency: 'RWF',
    publicReference: 'OP-DEMOINV0044',
    expiresAt: '2030-12-31T00:00:00Z',
    createdAt: '2026-10-12T08:00:00+02:00',
    updatedAt: '2026-10-12T08:00:00+02:00',
  },
  {
    id: 'pr-sample-003',
    merchantId: SAMPLE_MERCHANT_ID,
    paymentProfileId: 'pp-sample-001',
    invoiceId: null,
    requestedAmount: 10_000,
    currency: 'RWF',
    publicReference: 'OP-DEMOEXP0003',
    expiresAt: '2026-01-01T00:00:00Z',
    createdAt: '2025-12-31T10:00:00Z',
    updatedAt: '2025-12-31T10:00:00Z',
  },
]
