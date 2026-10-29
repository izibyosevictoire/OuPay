import { formatRwf } from '@/lib/format'
import type { BankAttribution } from '@/types/bankAttribution'

/**
 * Whether a transaction has anything to do with collection codes or code sales. Money applied to an ordinary invoice has none of it, and the
 * screens show it exactly as before. A code was reported (whether or not it was recognised), the evidence conflicts, or the payment carries
 * the exact reference of a code sale.
 */
export function isCodePayment(a: BankAttribution | undefined): a is BankAttribution {
  if (!a) return false
  return (
    a.attributionStatus === 'RESOLVED' ||
    a.attributionStatus === 'UNRESOLVED' ||
    a.attributionStatus === 'CONFLICT' ||
    a.saleReferenceNamed
  )
}

/** One row of the "what is established" list. `state` is carried by WORDS (`stateText`), never by colour alone. */
export interface CodePaymentFact {
  id: 'confirmed' | 'code' | 'sale' | 'allocated' | 'paid'
  label: string
  state: 'done' | 'open' | 'problem' | 'none'
  stateText: string
  detail: string
}

/**
 * The five facts, each read from its own field: the money is CONFIRMED; the code is ATTRIBUTED; the sale's reference is MATCHED; money is
 * ALLOCATED; the sale is FULLY PAID. None is inferred from another, so a sale can be paid while its code and agent stay unconfirmed.
 */
export function codePaymentFacts(a: BankAttribution): CodePaymentFact[] {
  const confirmed = a.transactionStatus === 'CONFIRMED'
  const conflict = a.attributionStatus === 'CONFLICT'
  const facts: CodePaymentFact[] = []

  facts.push({
    id: 'confirmed',
    label: 'Bank confirmation',
    state: confirmed ? 'done' : a.transactionStatus === 'PENDING' ? 'open' : 'problem',
    stateText: confirmed
      ? 'Confirmed'
      : a.transactionStatus === 'PENDING'
        ? 'Pending'
        : a.transactionStatus === 'REVERSED'
          ? 'Reversed'
          : 'Failed',
    detail: confirmed
      ? `${formatRwf(a.amountRwf)} verified by the bank.`
      : a.transactionStatus === 'PENDING'
        ? 'The bank has not confirmed this money yet.'
        : a.transactionStatus === 'REVERSED'
          ? 'The bank reversed this payment.'
          : 'The bank reported that this payment failed.',
  })

  let codeState: CodePaymentFact['state'] = 'none'
  let codeStateText = 'No code reported'
  let codeDetail = 'The bank did not report a collection code with this payment.'
  if (a.attributionStatus === 'RESOLVED') {
    codeState = 'done'
    codeStateText = 'Resolved'
    codeDetail = `The reported code is ${a.collectionCode?.label ?? 'one of your codes'}.`
  } else if (a.attributionStatus === 'UNRESOLVED') {
    codeState = 'problem'
    codeStateText = 'Not recognised'
    codeDetail = 'The bank reported a code that is not one of your codes on this account.'
  } else if (conflict) {
    codeState = 'problem'
    codeStateText = 'Conflict'
    codeDetail = 'The bank evidence contradicts itself.'
  } else if (a.attributionStatus === 'NOT_EVALUATED') {
    codeStateText = 'Not evaluated'
    codeDetail = 'This payment arrived before code attribution existed.'
  }
  facts.push({
    id: 'code',
    label: 'Collection code',
    state: codeState,
    stateText: codeStateText,
    detail: codeDetail,
  })

  facts.push({
    id: 'sale',
    label: 'Sale reference',
    state: a.saleReferenceMatched ? 'done' : a.saleReferenceNamed ? 'open' : 'none',
    stateText: a.saleReferenceMatched
      ? 'Matched'
      : a.saleReferenceNamed
        ? 'Named, not matched'
        : 'None',
    detail: a.saleReferenceMatched
      ? `Matched automatically to sale ${a.saleReference}.`
      : a.saleReferenceNamed
        ? `The payment names sale ${a.saleReference}, but it was not matched automatically.`
        : 'The payment carries no sale reference.',
  })

  const allocated = a.allocatedToSaleRwf > 0
  facts.push({
    id: 'allocated',
    label: 'Money applied',
    state: allocated ? 'done' : 'none',
    stateText: allocated ? 'Applied' : 'Nothing applied',
    detail: allocated
      ? `${formatRwf(a.allocatedToSaleRwf)} of ${formatRwf(a.amountRwf)} applied to the sale, ${
          a.allocationOrigin === 'MANUAL'
            ? 'by hand by an authorised person'
            : a.allocationOrigin === 'MIXED'
              ? 'partly automatically and partly by hand'
              : 'automatically on complete bank evidence'
        }.`
      : 'No money from this payment is applied to a sale.',
  })

  facts.push({
    id: 'paid',
    label: 'Sale paid',
    state: a.saleFullyPaid ? 'done' : a.saleReferenceNamed ? 'open' : 'none',
    stateText: a.saleFullyPaid
      ? 'Fully paid'
      : a.saleReferenceNamed
        ? 'Not fully paid'
        : 'Not applicable',
    detail: a.saleFullyPaid
      ? 'Money applied to the sale covers its full amount.'
      : a.saleReferenceNamed
        ? 'The sale still has a balance.'
        : 'No sale is involved.',
  })
  return facts
}

/** What happened and what a person can do, in plain words. Never says a manual allocation was matched automatically. */
export function explainCodePayment(a: BankAttribution): string {
  if (a.stage === 'CONFLICT') {
    return 'The bank evidence contradicts itself, for example a different code than the sale was billed through. Nothing was applied automatically, and a conflict can never be overridden by hand. Investigate it before deciding what to do.'
  }
  if (a.transactionStatus === 'REVERSED') {
    return 'The bank reversed this payment. Any money applied to a sale was reversed with it, and the history is kept.'
  }
  if (a.transactionStatus === 'PENDING') {
    return 'The bank has not confirmed this payment yet. Nothing is matched or applied until it does.'
  }
  if (a.transactionStatus === 'FAILED') {
    return 'The bank reported that this payment failed. Nothing was applied.'
  }
  if (a.allocatedToSaleRwf > 0 && a.allocationOrigin === 'MANUAL') {
    return 'This money was applied to the sale by hand by an authorised person, who recorded a reason (see the history). That does not confirm the bank code or the agent: they stay exactly as the bank evidence left them.'
  }
  if (a.allocatedToSaleRwf > 0 && a.allocationOrigin === 'MIXED') {
    return 'Part of this money was applied automatically on complete bank evidence and part by hand by an authorised person (see the history).'
  }
  if (a.allocatedToSaleRwf > 0) {
    return a.saleFullyPaid
      ? 'Matched automatically on complete bank evidence (the bank-reported code, the exact sale reference and the account all agreed) and applied. The sale is fully paid.'
      : 'Matched automatically on complete bank evidence and applied. The sale still has a balance.'
  }
  if (a.attributionStatus === 'UNRESOLVED') {
    return 'The bank reported a code that is not one of your codes on this account, so the payment was not matched. It stays verified but unmatched until someone reviews it.'
  }
  if (a.saleReferenceNamed && a.attributionStatus === 'NOT_REPORTED') {
    return 'The payment names a sale, but the bank did not report a collection code, so it was not matched automatically and the agent is not confirmed. An authorised person can apply it by hand with a written reason.'
  }
  if (a.attributionStatus === 'RESOLVED' && !a.saleReferenceNamed) {
    return 'The reported code is yours, but the payment carries no exact sale reference, so no sale was matched.'
  }
  return 'Verified funds that are not matched to a sale yet.'
}

/** The collector, only when the evidence confirms it; otherwise why not. */
export function agentLine(a: BankAttribution): string {
  if (a.agentAttribution === 'CONFIRMED_FROM_SALE_SNAPSHOT' && a.agentName) return a.agentName
  if (a.agentAttribution === 'SALE_NAMED_UNCONFIRMED') {
    return 'Not confirmed: the sale is named, but the bank did not report its code'
  }
  return 'Not identified'
}
