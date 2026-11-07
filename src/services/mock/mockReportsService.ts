import type { ReportDateRange, ReportsService, ReportSummary } from '@/services/reportsService'
import { createLedgerStore, type LedgerStore } from './ledger/mockLedgerStore'
import { createMockAuthStore, type MockAuthStore } from './mockAuthStore'
import { createOperationRunner, requireActor } from './mockOrganizationAccess'

interface MockReportsServiceOptions {
  authStore?: MockAuthStore
  /** The one shared ledger every figure is derived from, so a report can never disagree with the dashboard or the payments screen. */
  ledger?: LedgerStore
  delayInMilliseconds?: number
}

const kigaliDate = (iso: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kigali' }).format(new Date(iso))

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0)

/**
 * DEMO ONLY: the financial summary of a period, derived from the SAME mock ledger as every other screen, with the SAME rules as the server's
 * report (issued invoices of the period; ACTIVE allocations only; confirmed incoming money of the period and the part not applied to an
 * invoice). It is only wired into the separate demo build: an ordinary mock build still says reports need the server, and the server-backed
 * build uses the server's own report. It proves nothing about real money.
 */
export function createMockReportsService({
  authStore = createMockAuthStore(),
  ledger = createLedgerStore(authStore),
  delayInMilliseconds = 300,
}: MockReportsServiceOptions = {}): ReportsService {
  const run = createOperationRunner(delayInMilliseconds)
  const inRange = (iso: string, range: ReportDateRange) => {
    const day = kigaliDate(iso)
    return day >= range.from && day <= range.to
  }

  return {
    getSummary: (merchantId, range) =>
      run((): ReportSummary => {
        requireActor(authStore, merchantId, 'reports:view')
        const allocations = ledger.allocations.load().filter((a) => a.merchantId === merchantId && a.allocationStatus === 'ACTIVE')
        const allocatedToInvoice = (invoiceId: string) => sum(allocations.filter((a) => a.invoiceId === invoiceId).map((a) => a.amount))
        const allocatedFromTransaction = (transactionId: string) =>
          sum(allocations.filter((a) => a.bankTransactionId === transactionId).map((a) => a.amount))

        const issued = authStore
          .loadInvoices()
          .filter((i) => i.merchantId === merchantId && i.status === 'ISSUED' && i.issuedAt !== undefined && inRange(i.issuedAt, range))
        const confirmed = ledger.bankTransactions
          .load()
          .filter((t) => t.merchantId === merchantId && t.direction === 'INCOMING' && t.status === 'CONFIRMED' && inRange(t.providerOccurredAt, range))

        return {
          from: range.from,
          to: range.to,
          issuedInvoiceCount: issued.length,
          issuedTotalRwf: sum(issued.map((i) => i.grandTotal)),
          activeAllocatedToIssuedInvoicesRwf: sum(issued.map((i) => allocatedToInvoice(i.id))),
          outstandingForIssuedInvoicesRwf: sum(issued.map((i) => Math.min(i.grandTotal, Math.max(i.grandTotal - allocatedToInvoice(i.id), 0)))),
          confirmedIncomingDuringPeriodRwf: sum(confirmed.map((t) => t.amount)),
          unappliedConfirmedDuringPeriodRwf: sum(confirmed.map((t) => Math.max(t.amount - allocatedFromTransaction(t.id), 0))),
        }
      }),
  }
}
