import type { ReactNode } from 'react'
import {
  BankTransactionStatusBadge,
  BranchStatusBadge,
  InvoicePaymentStatusBadge,
  InvoiceStatusBadge,
  MembershipStatusBadge,
  RoleBadge,
  SimulatedBadge,
} from '@/components/common/StatusBadge'
import { formatDate, formatDateTime, formatRwf } from '@/lib/format'
import { formatStockQuantity } from '@/lib/formatStockQuantity'
import { daysSinceFixtureAnchor, rebaseSeedDates } from '@/lib/rebaseDates'
import {
  KIGALI_BRANCH_ASSIGNMENTS,
  KIGALI_BRANCHES,
  KIGALI_MEMBERSHIPS,
  KIGALI_USERS,
} from '@/services/mock/kigaliDemo/organization'
import { KIGALI_CATALOG_ITEMS, KIGALI_INVENTORY_BALANCES, KIGALI_POS_DRAFTS } from '@/services/mock/kigaliDemo/commerce'
import {
  KIGALI_BANK_TRANSACTIONS,
  KIGALI_ENTRY_DEVICES,
  KIGALI_INVOICES,
  KIGALI_PAYMENT_ALLOCATIONS,
} from '@/services/mock/kigaliDemo/payments'
import { DEVICE_TYPE_LABELS } from '@/features/entryDevices/entryDeviceLabels'

/**
 * What each page shows as its EXAMPLE DATA. Pure functions over the Kigali Demo Supermarket fixtures: no service, no query, no storage, no
 * network, no information about the signed-in business. The same examples for everyone.
 */
export type ExampleTopic =
  | 'dashboard'
  | 'branches'
  | 'staff'
  | 'catalog'
  | 'inventory'
  | 'pos'
  | 'payments'
  | 'invoices'
  | 'paymentPoints'
  | 'reports'

export interface ExampleColumn {
  key: string
  label: string
  numeric?: boolean
}

export interface ExampleRow {
  key: string
  cells: Record<string, ReactNode>
}

export interface ExampleTable {
  caption: string
  columns: ExampleColumn[]
  rows: ExampleRow[]
}

export interface ExampleStat {
  label: string
  value: string
  hint?: string
}

export interface ExampleView {
  /** What this example shows, in one sentence. */
  summary: string
  stats: ExampleStat[]
  tables: ExampleTable[]
}

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0)

/** The fixtures with their dates moved to "now", once: the newest example is always about a day old. */
const dated = (() => {
  let cached: {
    invoices: typeof KIGALI_INVOICES
    transactions: typeof KIGALI_BANK_TRANSACTIONS
    drafts: typeof KIGALI_POS_DRAFTS
    branches: typeof KIGALI_BRANCHES
  } | null = null
  return () => {
    if (cached) return cached
    const days = daysSinceFixtureAnchor()
    cached = {
      invoices: rebaseSeedDates(KIGALI_INVOICES, days),
      transactions: rebaseSeedDates(KIGALI_BANK_TRANSACTIONS, days),
      drafts: rebaseSeedDates(KIGALI_POS_DRAFTS, days),
      branches: rebaseSeedDates(KIGALI_BRANCHES, days),
    }
    return cached
  }
})()

// ---- ledger figures (the same rules as the real dashboard and report: confirmed money counted once, ACTIVE allocations only) -----------

function ledgerFigures() {
  const { invoices, transactions } = dated()
  const allocations = KIGALI_PAYMENT_ALLOCATIONS.filter((a) => a.allocationStatus === 'ACTIVE')
  const confirmed = transactions.filter((t) => t.status === 'CONFIRMED' && t.direction === 'INCOMING')
  const allocatedTo = (invoiceId: string) => sum(allocations.filter((a) => a.invoiceId === invoiceId).map((a) => a.amount))
  const allocatedFrom = (transactionId: string) => sum(allocations.filter((a) => a.bankTransactionId === transactionId).map((a) => a.amount))
  const issued = invoices.filter((i) => i.status === 'ISSUED')
  return {
    verifiedIncoming: sum(confirmed.map((t) => t.amount)),
    allocated: sum(allocations.map((a) => a.amount)),
    unapplied: sum(confirmed.map((t) => Math.max(t.amount - allocatedFrom(t.id), 0))),
    outstanding: sum(issued.map((i) => Math.min(i.grandTotal, Math.max(i.grandTotal - allocatedTo(i.id), 0)))),
    issuedCount: issued.length,
    issuedTotal: sum(issued.map((i) => i.grandTotal)),
    needsReview: transactions.filter((t) => t.reviewState === 'NEEDS_REVIEW').length,
    confirmedCount: confirmed.length,
    allocatedFrom,
  }
}

const unitOf = (itemId: string) => KIGALI_CATALOG_ITEMS.find((i) => i.id === itemId)!

const paymentsTable = (): ExampleTable => {
  const { transactions } = dated()
  const { allocatedFrom } = ledgerFigures()
  return {
    caption: 'Example payments (simulated)',
    columns: [
      { key: 'when', label: 'When' },
      { key: 'payer', label: 'Paid by' },
      { key: 'reference', label: 'Reference' },
      { key: 'amount', label: 'Amount', numeric: true },
      { key: 'status', label: 'Status' },
      { key: 'applied', label: 'Applied to invoices', numeric: true },
    ],
    rows: [...transactions]
      .sort((a, b) => b.providerOccurredAt.localeCompare(a.providerOccurredAt))
      .map((t) => ({
        key: t.id,
        cells: {
          when: formatDateTime(t.providerOccurredAt),
          payer: t.payerDisplayName ?? '—',
          reference: t.paymentReference ?? '—',
          amount: formatRwf(t.amount),
          status: (
            <span className="inline-flex flex-wrap items-center gap-1">
              <BankTransactionStatusBadge status={t.status} />
              <SimulatedBadge />
            </span>
          ),
          applied: formatRwf(allocatedFrom(t.id)),
        },
      })),
  }
}

const staffCountByBranch = (branchId: string) =>
  KIGALI_BRANCH_ASSIGNMENTS.filter((a) => a.branchId === branchId && a.status === 'ACTIVE').length

export function exampleView(topic: ExampleTopic): ExampleView {
  switch (topic) {
    case 'dashboard': {
      const f = ledgerFigures()
      return {
        summary: 'How the dashboard looks for a shop with a few weeks of simulated payments.',
        stats: [
          { label: 'Verified incoming', value: formatRwf(f.verifiedIncoming), hint: `${f.confirmedCount} confirmed payments` },
          { label: 'Applied to invoices', value: formatRwf(f.allocated) },
          { label: 'Unmatched collections', value: formatRwf(f.unapplied), hint: 'Confirmed, not applied to any invoice' },
          { label: 'Outstanding balances', value: formatRwf(f.outstanding), hint: 'Remaining on issued invoices' },
          { label: 'Issued invoices', value: formatRwf(f.issuedTotal), hint: `${f.issuedCount} issued` },
          { label: 'Needs review', value: String(f.needsReview), hint: 'Flagged or unmatched payments' },
        ],
        tables: [paymentsTable()],
      }
    }
    case 'reports': {
      const f = ledgerFigures()
      return {
        summary: 'How the financial report reads for the example shop (all example dates).',
        stats: [
          { label: 'Issued invoices', value: String(f.issuedCount), hint: formatRwf(f.issuedTotal) },
          { label: 'Applied to issued invoices', value: formatRwf(sum(KIGALI_PAYMENT_ALLOCATIONS.map((a) => a.amount))) },
          { label: 'Outstanding', value: formatRwf(f.outstanding) },
          { label: 'Confirmed incoming', value: formatRwf(f.verifiedIncoming) },
          { label: 'Unapplied collections', value: formatRwf(f.unapplied) },
        ],
        tables: [],
      }
    }
    case 'branches':
      return {
        summary: 'Three branches, each with its own staff and stock.',
        stats: [],
        tables: [
          {
            caption: 'Example branches',
            columns: [
              { key: 'name', label: 'Branch' },
              { key: 'code', label: 'Code' },
              { key: 'location', label: 'Location' },
              { key: 'status', label: 'Status' },
              { key: 'staff', label: 'Staff', numeric: true },
            ],
            rows: dated().branches.map((b) => ({
              key: b.id,
              cells: {
                name: b.name,
                code: b.code,
                location: `${b.location.district}, ${b.location.sector}`,
                status: <BranchStatusBadge status={b.status} />,
                staff: String(staffCountByBranch(b.id)),
              },
            })),
          },
        ],
      }
    case 'staff':
      return {
        summary: 'An owner, a manager and a cashier, each assigned to the branches they work at.',
        stats: [],
        tables: [
          {
            caption: 'Example staff',
            columns: [
              { key: 'name', label: 'Name' },
              { key: 'role', label: 'Role' },
              { key: 'status', label: 'Status' },
              { key: 'branches', label: 'Branches' },
            ],
            rows: KIGALI_MEMBERSHIPS.map((m) => ({
              key: m.id,
              cells: {
                name: KIGALI_USERS.find((u) => u.id === m.userId)!.fullName,
                role: <RoleBadge role={m.role} />,
                status: <MembershipStatusBadge status={m.status} />,
                branches: KIGALI_BRANCH_ASSIGNMENTS.filter((a) => a.membershipId === m.id && a.status === 'ACTIVE')
                  .map((a) => KIGALI_BRANCHES.find((b) => b.id === a.branchId)!.name)
                  .join(', '),
              },
            })),
          },
        ],
      }
    case 'catalog':
      return {
        summary: 'Ten goods and two services, each with a price per selling unit.',
        stats: [],
        tables: [
          {
            caption: 'Example catalog',
            columns: [
              { key: 'name', label: 'Item' },
              { key: 'code', label: 'Code' },
              { key: 'type', label: 'Type' },
              { key: 'price', label: 'Price', numeric: true },
            ],
            rows: KIGALI_CATALOG_ITEMS.map((i) => ({
              key: i.id,
              cells: {
                name: i.name,
                code: i.code ?? '—',
                type: i.itemType === 'GOODS' ? 'Goods' : 'Service',
                price: `${formatRwf(i.pricePerSaleUnitRwf)} / ${i.saleUnit}`,
              },
            })),
          },
        ],
      }
    case 'inventory':
      return {
        summary: 'Stock held at each branch, in each good’s own unit.',
        stats: [],
        tables: [
          {
            caption: 'Example stock by branch',
            columns: [
              { key: 'item', label: 'Item' },
              { key: 'branch', label: 'Branch' },
              { key: 'onHand', label: 'In stock', numeric: true },
            ],
            rows: KIGALI_INVENTORY_BALANCES.map((b) => ({
              key: b.id,
              cells: {
                item: unitOf(b.itemId).name,
                branch: KIGALI_BRANCHES.find((x) => x.id === b.branchId)!.name,
                onHand: formatStockQuantity(b.quantityOnHand, unitOf(b.itemId).stockUnit!),
              },
            })),
          },
        ],
      }
    case 'pos':
      return {
        summary: 'Two saved carts. A cart is a draft: it is not a sale and reserves no stock.',
        stats: [],
        tables: [
          {
            caption: 'Example POS drafts',
            columns: [
              { key: 'branch', label: 'Branch' },
              { key: 'by', label: 'Prepared by' },
              { key: 'lines', label: 'Cart' },
              { key: 'total', label: 'Total', numeric: true },
            ],
            rows: dated().drafts.map((d) => ({
              key: d.id,
              cells: {
                branch: d.branchName,
                by: d.createdByName,
                lines: d.lines.map((l) => `${l.name} ${l.enteredQuantity} ${l.enteredUnit ?? ''}`.trim()).join(' · '),
                total: formatRwf(d.totalRwf),
              },
            })),
          },
        ],
      }
    case 'payments':
      return {
        summary: 'Simulated bank events, one needing review. Every one is made up.',
        stats: [],
        tables: [paymentsTable()],
      }
    case 'invoices':
      return {
        summary: 'Four invoices: paid, part paid, unpaid and a draft.',
        stats: [],
        tables: [
          {
            caption: 'Example invoices',
            columns: [
              { key: 'number', label: 'Invoice' },
              { key: 'customer', label: 'Customer' },
              { key: 'branch', label: 'Branch' },
              { key: 'total', label: 'Total', numeric: true },
              { key: 'status', label: 'Status' },
              { key: 'due', label: 'Due' },
            ],
            rows: dated().invoices.map((i) => ({
              key: i.id,
              cells: {
                number: i.invoiceNumber,
                customer: i.customer.name,
                branch: i.branchSnapshot.name,
                total: formatRwf(i.grandTotal),
                status: (
                  <span className="inline-flex flex-wrap items-center gap-1">
                    <InvoiceStatusBadge status={i.status} />
                    {i.status === 'ISSUED' && <InvoicePaymentStatusBadge status={i.paymentStatus} />}
                  </span>
                ),
                due: formatDate(i.dueAt),
              },
            })),
          },
        ],
      }
    case 'paymentPoints':
      return {
        summary: 'Two static QR codes and an NFC bracelet. A payment point only opens a bill: it never moves money.',
        stats: [],
        tables: [
          {
            caption: 'Example payment points',
            columns: [
              { key: 'name', label: 'Payment point' },
              { key: 'type', label: 'Kind' },
              { key: 'branch', label: 'Branch' },
              { key: 'holder', label: 'Assigned to' },
            ],
            rows: KIGALI_ENTRY_DEVICES.map((d) => ({
              key: d.id,
              cells: {
                name: d.displayName,
                type: DEVICE_TYPE_LABELS[d.deviceType],
                branch: KIGALI_BRANCHES.find((b) => b.id === d.branchId)!.name,
                holder: d.cashierUserId ? KIGALI_USERS.find((u) => u.id === d.cashierUserId)!.fullName : 'The branch',
              },
            })),
          },
        ],
      }
  }
}
