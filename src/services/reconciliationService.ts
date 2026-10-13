import type {
  AllocationView,
  BankTransactionDetails,
  BankTransactionView,
  ManualAllocationInput,
} from '@/types/payment'

export interface PayableInvoice {
  invoiceId: string
  invoiceNumber: string
  customerName: string
  grandTotal: number
  remainingBalance: number
}

/**
 * Merchant-facing view of the financial ledger and the only ways a person may change it.
 *
 * There is deliberately NO method that creates a bank transaction, confirms a payment or marks
 * an invoice paid: bank confirmation can only come from the trusted provider boundary
 * (the bank-event processor), never from a user. People can only (a) apply already-confirmed
 * money to invoices, (b) correct an allocation, and (c) record that they reviewed something.
 *
 * Every method takes the merchant explicitly and the mock verifies the user's ACTIVE
 * membership and permissions. A real backend must enforce the same rules itself.
 */
export interface ReconciliationService {
  /** Cashiers receive only transactions applied to invoices assigned to them. */
  listBankTransactions(merchantId: string): Promise<BankTransactionView[]>
  getBankTransaction(merchantId: string, bankTransactionId: string): Promise<BankTransactionDetails>
  /** Allocation history, including reversed allocations. Same cashier scoping. */
  listAllocations(merchantId: string): Promise<AllocationView[]>
  /** Issued invoices with a balance, for choosing where to apply unmatched money. */
  listPayableInvoices(merchantId: string): Promise<PayableInvoice[]>
  /**
   * Applies confirmed, unapplied money to one or more invoices. Rejected with
   * `allocation_conflict` if anyone changed the transaction or an invoice balance since the
   * caller loaded them, and never allowed to exceed what is owed or what is unapplied.
   */
  allocateManually(
    merchantId: string,
    input: ManualAllocationInput,
  ): Promise<BankTransactionDetails>
  /** Corrects a wrong allocation. History is kept; the invoice balance is restored. */
  reverseAllocation(
    merchantId: string,
    allocationId: string,
    input: { reason: string },
  ): Promise<BankTransactionDetails>
  /** Records that a person looked at a flagged or unmatched transaction. Moves no money. */
  markReviewed(
    merchantId: string,
    bankTransactionId: string,
    input: { note: string; expectedTransactionVersion: number },
  ): Promise<BankTransactionDetails>
}
