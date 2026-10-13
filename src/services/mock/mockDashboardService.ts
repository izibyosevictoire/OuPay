import { requiresReview } from '@/lib/ledger'
import type { DashboardService } from '@/services/dashboardService'
import type { DailyPaymentActivity, ProviderShare } from '@/types/business'
import type { BankTransactionView } from '@/types/payment'
import { buildTransactionViews } from './ledger/ledgerViews'
import { createLedgerStore, type LedgerStore } from './ledger/mockLedgerStore'
import { createMockAuthStore, type MockAuthStore } from './mockAuthStore'
import { simulateNetworkDelay } from './simulateNetwork'

const DAYS_SHOWN = 7

const kigaliDate = (iso: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kigali' }).format(new Date(iso))

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0)

const isVerifiedIncoming = (t: BankTransactionView) =>
  t.status === 'CONFIRMED' && t.direction === 'INCOMING'

interface MockDashboardServiceOptions {
  /** Staff counts come from the same memberships the Staff module edits. */
  authStore?: MockAuthStore
  /** The one shared ledger every payment figure is derived from. */
  ledger?: LedgerStore
}

function countActiveCashiers(store: MockAuthStore, merchantId: string) {
  const activeUserIds = new Set(
    store
      .loadUsers()
      .filter((user) => user.status === 'ACTIVE')
      .map((user) => user.id),
  )
  return store
    .loadMemberships()
    .filter(
      (m) =>
        m.merchantId === merchantId &&
        m.role === 'CASHIER' &&
        m.status === 'ACTIVE' &&
        activeUserIds.has(m.userId),
    ).length
}

export function createMockDashboardService({
  authStore = createMockAuthStore(),
  ledger = createLedgerStore(authStore),
}: MockDashboardServiceOptions = {}): DashboardService {
  const viewsFor = (merchantId: string, assignedUserId?: string) =>
    buildTransactionViews(authStore, ledger, merchantId, assignedUserId)

  return {
    getSummary({ merchantId, assignedUserId }) {
      const views = viewsFor(merchantId, assignedUserId)
      const verified = views.filter(isVerifiedIncoming)
      // A transaction's reversed allocations never count: allocatedAmount is ACTIVE ones only.
      const allocatedTotal = sum(views.map((t) => t.allocatedAmount))
      const allocationsByTransaction = new Map<string, number>()
      for (const view of views) allocationsByTransaction.set(view.id, view.allocatedAmount)
      const unapplied = assignedUserId ? 0 : sum(verified.map((t) => t.unappliedAmount))
      const requiresReviewCount = assignedUserId
        ? 0
        : views.filter((t) =>
            requiresReview(
              t,
              ledger.allocations.load().filter((a) => a.bankTransactionId === t.id),
            ),
          ).length
      return simulateNetworkDelay({
        // A cashier's "verified" money is what is applied to their own invoices.
        verifiedIncomingTotal: assignedUserId ? allocatedTotal : sum(verified.map((t) => t.amount)),
        allocatedTotal: assignedUserId
          ? allocatedTotal
          : sum(verified.map((t) => t.allocatedAmount)),
        unappliedConfirmedTotal: unapplied,
        requiresReviewCount,
        confirmedTransactionCount: verified.length,
        // Only people who can really work today: ACTIVE membership AND an ACTIVE user account.
        activeCashierCount: countActiveCashiers(authStore, merchantId),
      })
    },

    getRecentTransactions({ merchantId, assignedUserId }, limit) {
      return simulateNetworkDelay(viewsFor(merchantId, assignedUserId).slice(0, limit))
    },

    getDailyPaymentActivity({ merchantId, assignedUserId }) {
      const views = viewsFor(merchantId, assignedUserId).filter(
        (t) => t.status === 'CONFIRMED' || t.status === 'PENDING',
      )
      if (views.length === 0) return simulateNetworkDelay<DailyPaymentActivity[]>([])
      // The week ends on the latest day with activity, so sample data stays visible.
      const latest = views
        .map((t) => kigaliDate(t.providerOccurredAt))
        .sort()
        .at(-1)!
      const days: DailyPaymentActivity[] = []
      for (let offset = DAYS_SHOWN - 1; offset >= 0; offset -= 1) {
        const date = new Date(`${latest}T12:00:00Z`)
        date.setUTCDate(date.getUTCDate() - offset)
        const key = date.toISOString().slice(0, 10)
        const ofDay = views.filter((t) => kigaliDate(t.providerOccurredAt) === key)
        days.push({
          merchantId,
          date: `${key}T12:00:00Z`,
          confirmedAmountInRwf: sum(
            ofDay.filter((t) => t.status === 'CONFIRMED').map((t) => t.amount),
          ),
          pendingAmountInRwf: sum(ofDay.filter((t) => t.status === 'PENDING').map((t) => t.amount)),
        })
      }
      return simulateNetworkDelay(days)
    },

    getProviderBreakdown({ merchantId, assignedUserId }) {
      const totals = new Map<ProviderShare['providerId'], number>()
      for (const t of viewsFor(merchantId, assignedUserId).filter(isVerifiedIncoming)) {
        totals.set(t.provider, (totals.get(t.provider) ?? 0) + t.amount)
      }
      const shares: ProviderShare[] = [...totals]
        .map(([providerId, amountInRwf]) => ({ providerId, amountInRwf }))
        .sort((a, b) => b.amountInRwf - a.amountInRwf)
      return simulateNetworkDelay(shares)
    },
  }
}
