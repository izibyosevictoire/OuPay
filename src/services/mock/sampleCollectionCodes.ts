// SAMPLE DATA ONLY. Fictional collection codes for the demo businesses. Nothing here is a real Equity code, and no sample code is
// a payment instruction. The one "approved" non-simulated code uses an obviously illustrative value on purpose.
import type { CodeApproval, CollectionCodeStatus, AssigneeKind } from '@/types/collectionCodes'
import type { ProviderId } from '@/types/banking'
import { DEMO_USER_IDS } from './sampleAccounts'
import { SAMPLE_MERCHANT_ID, SAMPLE_SECOND_MERCHANT_ID } from './sampleMerchants'
import { SAMPLE_BRANCH_IDS } from './sampleOrganization'

export interface StoredCollectionCode {
  id: string
  merchantId: string
  internalRef: string
  displayLabel: string
  providerId: ProviderId
  settlementDestinationId: string
  /** Snapshots of the settlement account, copied when the code was requested. */
  settlementAccountLabel: string
  settlementAccountMasked: string
  simulated: boolean
  branchId: string | null
  status: CollectionCodeStatus
  statusReason: string | null
  bankRequestRef: string | null
  externalCode: string | null
  approval: CodeApproval | null
  /** SAMPLE DATA ONLY: the connection status of a fictional settlement account that has no connection record. */
  sampleConnectionStatus?: string
  /** The durable identity of the request and what made it (so a repeat is the same request). */
  clientRequestId: string
  fingerprint: string
  createdByUserId: string
  createdAt: string
  updatedAt: string
  seq: number
  version: number
}

export interface StoredCodeAssignment {
  id: string
  merchantId: string
  codeId: string
  assigneeKind: AssigneeKind
  membershipId: string | null
  assigneeUserId: string | null
  /** Snapshots: never rewritten when the person or the branch changes later. */
  assigneeName: string
  assigneeRole: string | null
  collectionPointLabel: string | null
  branchId: string | null
  branchName: string | null
  branchCode: string | null
  validFrom: string
  validTo: string | null
  assignedByName: string
  endedByName: string | null
  endReason: string | null
  seq: number
}

const at = (day: number, hour: number) =>
  `2026-09-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00+02:00`

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const OWNER_NAME = 'Sample Owner'

const code = (
  n: number,
  fields: Partial<StoredCollectionCode> &
    Pick<StoredCollectionCode, 'internalRef' | 'displayLabel' | 'status'>,
): StoredCollectionCode => ({
  id: `cc-sample-${String(n).padStart(3, '0')}`,
  merchantId: SAMPLE_MERCHANT_ID,
  providerId: 'EQUITY_MOCK',
  settlementDestinationId: 'dst-sample-001',
  settlementAccountLabel: 'Main collections account',
  settlementAccountMasked: '••••4821',
  simulated: true,
  branchId: null,
  statusReason: null,
  bankRequestRef: null,
  externalCode: null,
  approval: null,
  clientRequestId: uuid(n),
  fingerprint: `sample-${n}`,
  createdByUserId: DEMO_USER_IDS.owner,
  createdAt: at(10, 9),
  updatedAt: at(10, 9),
  seq: n,
  version: 0,
  ...fields,
})

export const SAMPLE_COLLECTION_CODES: StoredCollectionCode[] = [
  // Bank-approved and active, on an account that is NOT a simulation. The value is illustrative, never a real code.
  code(1, {
    internalRef: 'CC-7KQ2M9XA',
    displayLabel: 'Remera counter',
    status: 'ACTIVE',
    simulated: false,
    settlementDestinationId: 'dst-sample-illustrative',
    settlementAccountLabel: 'Equity business account (illustrative)',
    settlementAccountMasked: '••••0000',
    sampleConnectionStatus: 'CONNECTED',
    branchId: SAMPLE_BRANCH_IDS.remera,
    bankRequestRef: 'EQ-REQ-DEMO-0001',
    externalCode: 'DEMO-ILLUSTRATIVE-001',
    approval: { source: 'OPERATOR', evidenceRef: 'DEMO-EVIDENCE-0001', approvedAt: at(12, 10) },
    updatedAt: at(12, 10),
    version: 3,
  }),
  // The owner declared a request to the bank. OuPay has no confirmation from Equity.
  code(2, {
    internalRef: 'CC-4P8TW3NB',
    displayLabel: 'City Centre till',
    status: 'REQUEST_DECLARED',
    branchId: SAMPLE_BRANCH_IDS.cityCentre,
    bankRequestRef: 'EQ-REQ-DEMO-0002',
    updatedAt: at(11, 9),
    version: 1,
  }),
  // An internal request only: nothing has been sent to Equity.
  code(3, {
    internalRef: 'CC-9HD6RJ2E',
    displayLabel: 'Weekend market stall',
    status: 'REQUESTED',
  }),
  // Closed for good. Its history stays.
  code(4, {
    internalRef: 'CC-3XM5YF7C',
    displayLabel: 'Old Remera kiosk',
    status: 'DEACTIVATED',
    statusReason: 'Replaced by the Remera counter.',
    branchId: SAMPLE_BRANCH_IDS.remera,
    createdAt: at(5, 9),
    updatedAt: at(9, 9),
    version: 2,
  }),
  // Active on a SIMULATED account: shown, but never a live code.
  code(5, {
    internalRef: 'CC-6RN2QK8D',
    displayLabel: 'Demo stall (simulated)',
    status: 'ACTIVE',
    simulated: true,
    branchId: SAMPLE_BRANCH_IDS.cityCentre,
    externalCode: 'SIM-0001',
    approval: { source: 'OPERATOR', evidenceRef: 'SIMULATED-EVIDENCE', approvedAt: at(11, 14) },
    updatedAt: at(11, 14),
    version: 2,
  }),
  // The second business has its own, separate registry.
  {
    ...code(6, {
      internalRef: 'CC-8WE4HT5M',
      displayLabel: 'Cafe counter',
      status: 'REQUESTED',
    }),
    merchantId: SAMPLE_SECOND_MERCHANT_ID,
    settlementDestinationId: 'dst-sample-101',
    settlementAccountLabel: 'Cafe takings',
    settlementAccountMasked: '••••7733',
    createdByUserId: DEMO_USER_IDS.cafeOwner,
  },
]

const assignment = (
  n: number,
  fields: Partial<StoredCodeAssignment> &
    Pick<StoredCodeAssignment, 'codeId' | 'assigneeName' | 'validFrom' | 'assigneeKind'>,
): StoredCodeAssignment => ({
  id: `cca-sample-${String(n).padStart(3, '0')}`,
  merchantId: SAMPLE_MERCHANT_ID,
  membershipId: null,
  assigneeUserId: null,
  assigneeRole: null,
  collectionPointLabel: null,
  branchId: null,
  branchName: null,
  branchCode: null,
  validTo: null,
  assignedByName: OWNER_NAME,
  endedByName: null,
  endReason: null,
  seq: n,
  ...fields,
})

export const SAMPLE_CODE_ASSIGNMENTS: StoredCodeAssignment[] = [
  // The Remera counter: first the front desk, now Aline.
  assignment(1, {
    codeId: 'cc-sample-001',
    assigneeKind: 'COLLECTION_POINT',
    assigneeName: 'Front desk',
    collectionPointLabel: 'Front desk',
    branchId: SAMPLE_BRANCH_IDS.remera,
    branchName: 'Remera Main',
    branchCode: 'RM01',
    validFrom: at(12, 11),
    validTo: at(14, 8),
    endedByName: OWNER_NAME,
    endReason: 'Moved to a named agent.',
  }),
  assignment(2, {
    codeId: 'cc-sample-001',
    assigneeKind: 'MEMBER',
    membershipId: 'mem-004',
    assigneeUserId: DEMO_USER_IDS.cashier,
    assigneeName: 'Aline Uwase',
    assigneeRole: 'CASHIER',
    branchId: SAMPLE_BRANCH_IDS.remera,
    branchName: 'Remera Main',
    branchCode: 'RM01',
    validFrom: at(14, 8),
  }),
  // The closed kiosk code: its history is kept.
  assignment(3, {
    codeId: 'cc-sample-004',
    assigneeKind: 'MEMBER',
    membershipId: 'mem-005',
    assigneeUserId: DEMO_USER_IDS.suspended,
    assigneeName: 'Eric Niyonzima',
    assigneeRole: 'CASHIER',
    branchId: SAMPLE_BRANCH_IDS.remera,
    branchName: 'Remera Main',
    branchCode: 'RM01',
    validFrom: at(5, 10),
    validTo: at(9, 9),
    endedByName: OWNER_NAME,
    endReason: 'Code deactivated.',
  }),
  assignment(4, {
    codeId: 'cc-sample-005',
    assigneeKind: 'COLLECTION_POINT',
    assigneeName: 'Market stall',
    collectionPointLabel: 'Market stall',
    branchId: SAMPLE_BRANCH_IDS.cityCentre,
    branchName: 'City Centre',
    branchCode: 'KCC',
    validFrom: at(11, 15),
  }),
]
