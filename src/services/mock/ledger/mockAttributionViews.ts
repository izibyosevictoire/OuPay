import type { Actor } from '@/services/mock/mockOrganizationAccess'
import type { StoredCodeSale } from '@/services/mock/mockCodeCheckoutService'
import { MOCK_STORAGE_KEYS } from '@/services/mock/mockStorageKeys'
import type { MockAuthStore } from '@/services/mock/mockAuthStore'
import type { BankAttribution } from '@/types/bankAttribution'
import type { LedgerStore } from './mockLedgerStore'
import { buildTransactionViews } from './ledgerViews'

/**
 * DEMO ONLY: the in-browser stand-in for the server's bank attribution read model (R6d). It mirrors the server's rules for what the DEMO
 * provider can produce, and nothing more:
 *  - the demo provider reports NO collection code, so every transaction is `NOT_REPORTED` / `ACCOUNT_ONLY` and no code is ever resolved;
 *  - a payment that carries the exact reference of a code sale NAMES that sale, but without a reported code the agent stays UNCONFIRMED;
 *  - every mock code sale is a demonstration, which never receives money, so nothing is ever matched or allocated to one.
 * Scope follows the server: owners see every incoming transaction; managers only attributed activity of their own branches; cashiers only
 * money confirmed for their own sales, which the demo can never produce.
 */
export function buildAttributionViews(
  store: MockAuthStore,
  ledger: LedgerStore,
  merchantId: string,
  actor: Actor,
): BankAttribution[] {
  const sales = store
    .loadRecords<StoredCodeSale>(MOCK_STORAGE_KEYS.codeSales, [])
    .filter((s) => s.merchantId === merchantId)
  const requests = new Map(ledger.paymentRequests.load().map((r) => [r.id, r]))
  const saleByReference = new Map(
    sales.flatMap((sale) => {
      const reference = requests.get(sale.paymentRequestId)?.publicReference
      return reference ? [[reference, sale] as const] : []
    }),
  )
  const role = actor.membership.role
  const managerBranches = new Set(
    role === 'MANAGER'
      ? store
          .loadBranchAssignments()
          .filter(
            (a) =>
              a.merchantId === merchantId &&
              a.membershipId === actor.membership.id &&
              a.status === 'ACTIVE',
          )
          .map((a) => a.branchId)
      : [],
  )

  return buildTransactionViews(store, ledger, merchantId)
    .filter((t) => t.direction === 'INCOMING')
    .flatMap<BankAttribution>((t) => {
      const sale = t.paymentReference ? saleByReference.get(t.paymentReference) : undefined
      // Managers: attributed activity (a named sale) of their own branches only. Cashiers: nothing the demo can confirm.
      if (role === 'MANAGER' && !(sale && managerBranches.has(sale.branchId))) return []
      if (role === 'CASHIER') return []
      return [
        {
          merchantId,
          transactionId: t.id,
          providerTransactionId: t.providerTransactionId,
          transactionStatus: t.status,
          amountRwf: t.amount,
          occurredAt: t.providerOccurredAt,
          reportedCode: null,
          reportedCodeMasked: false,
          collectionCode: null,
          attributionStatus: 'NOT_REPORTED',
          attributionBasis: 'ACCOUNT_ONLY',
          agentAttribution: sale ? 'SALE_NAMED_UNCONFIRMED' : 'UNRESOLVED',
          agentName: null,
          saleReference: sale ? (t.paymentReference ?? null) : null,
          saleInvoiceId: sale?.invoiceId ?? null,
          stage: t.status === 'CONFIRMED' ? 'AWAITING_MATCHING' : 'NOT_CONFIRMED',
          codeResolved: false,
          saleReferenceNamed: Boolean(sale),
          saleReferenceMatched: false,
          allocatedToSaleRwf: 0,
          allocationOrigin: null,
          saleFullyPaid: false,
          reviewState: t.reviewState,
          createdAt: t.createdAt,
        },
      ]
    })
}
