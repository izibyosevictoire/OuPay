# Sales and bank reconciliation monitoring (R6f)

A merchant-facing view of how bank money relates to collection codes and code sales. It **enhances the existing Transactions and Payments screens**; it adds
no new dashboard and no new financial behaviour. Everything shown is read from APIs that already exist
([bank-attribution.md](bank-attribution.md), [code-sale-reconciliation.md](code-sale-reconciliation.md)), and nothing on these screens can confirm a payment,
resolve a code or allocate money outside the existing audited reconciliation.

## Five facts, never one status

| Fact | Words on screen | Field it is read from |
|---|---|---|
| Bank confirmation | Confirmed / Pending / Reversed / Failed | `transactionStatus` |
| Code attributed | Resolved / No code reported / Not recognised / Conflict | `attributionStatus`, `codeResolved` |
| Sale reference | Matched / Named, not matched / None | `saleReferenceNamed`, `saleReferenceMatched` |
| Money applied | "RWF x of RWF y applied, automatically / by hand" | `allocatedToSaleRwf`, `allocationOrigin` |
| Sale paid | Fully paid / Not fully paid | `saleFullyPaid` |

The stage badge (`Verified funds awaiting matching`, `Code resolved, sale not matched`, `Sale reference matched`, `Money allocated, sale not fully paid`,
`Sale fully paid`, `Conflict: needs investigation`, `Not confirmed by the bank`) comes from the server's derived `stage`. State is always carried by words, never by colour alone.
A payment applied **by hand** is described as applied by hand with its recorded reason; it is never called an automatic match, and it does not confirm the
bank code or the agent (they stay as the bank evidence left them).

## What changed on the screens

* **Transactions** (`/transactions`): a *Code payment* stage filter (all / code payments / not code payments / each stage); search also covers sale reference,
  agent and code label; **pagination** (15 per page, "Showing 1–15 of 40", Previous/Next, back to page 1 when a filter changes); each code payment shows its stage
  badge and its sale, code and (only when confirmed) agent. Phone: a stacked card list with the stage on every card; the table appears from the `lg` breakpoint.
* **Transaction details** (`/transactions/:id`): a *Code payment* panel with the five facts, the explanation of what happened and what a person can do, the sale
  reference, the collection code, the reported code (masked as the server masks it), the **original agent** (named only when confirmed), amounts received and applied,
  how it was applied, a link to the sale's invoice, and, for people who may reconcile, the **manual reconciliation history** (who applied or corrected money by hand,
  with the reason). Money for an ordinary invoice shows no panel and looks exactly as before.
* **Payments** (reconciliation queues): code payments carry their stage badge.
* **Manual allocation dialog**: the note says that a written reason (at least ten characters) is required when applying money to a code sale; the server's refusals
  (`reconciliation_reason_required`, `code_sale_evidence_mismatch`, `code_sale_not_payable`) are shown in plain words.

## Authorization and privacy (enforced by the server)

Owners see every incoming transaction; managers only attributed activity of branches they work at; cashiers only confirmed money for their **own** sales. A
transaction outside the caller's scope is simply not found. The agent is read from the sale's immutable snapshot, **never from timestamps or current assignments**.
Collection codes are masked as the API masks them. No bank secret, approval evidence, internal code reference or another business's data is in these views. The
frontend adds no authorization of its own: it renders what the API returned and hides reconcile-only actions from people without `payments:reconcile`.

## Simulated versus real

Everything the mock provider reports is labelled **Simulated**, and a code payment from it carries: "Simulated payment from the demo provider. It is not a deposit
into a real bank account." There is no control anywhere that confirms a bank transaction: confirmation exists only in the trusted bank-event processor (and the demo
simulator, which is a labelled demo tool outside these screens).

## API change

One read-only field: `saleInvoiceId` on `GET …/bank-attributions[/{id}]` (the sale's invoice, same visibility as the sale reference), so a screen can link to the
invoice. No migration.

## Mock and HTTP

`ReconciliationService` gained `listBankAttributions` and `getBankAttribution`. The HTTP service pages through `/bank-attributions` and normalises the server's
omitted nulls; the mock mirrors what the demo provider can produce: it reports no code, so nothing is ever resolved, matched, allocated or confirmed for an agent, a
payment carrying a code sale's reference only *names* the sale, and every mock code sale is a demonstration that never receives money. A test asserts the two produce
the same fields.

## Not built

No new "Sales" screen (the invoice list already shows sales and the transaction screens now show the bank side); no per-agent or per-code report; no code-sale panel
on the invoice detail page (needs a sale lookup by invoice, which the API does not offer); the attribution list is filtered client-side after loading all pages
(the server pages it, the screen requests every page); no UI for manual-allocation reason beyond the dialog hint.

## Future work (tracked, not implemented)

1. **Server-side filtering and pagination for high-volume merchants.** The transactions and attributions lists are loaded page by page and then filtered and paged in
   the browser. A merchant with very many transactions needs the filters (stage, status, search, date range) and the cursor paging done by the server.
2. **Invoice detail integration with code-sale context.** The invoice page should show the sale's code, mode, reference, agent and how it was paid. This needs a read
   endpoint for a code sale by invoice, which the API does not offer; today the transaction details link to the invoice but the invoice does not link back.
3. **Optional per-agent and per-code reporting.** Totals of sales, collected, outstanding and unmatched money by agent and by code, built on the same read models and the
   same scopes (owner, branch manager, own sales for an agent).
4. **Real-browser mobile verification of the payment-detail panel.** The transaction list was checked at 375px in a real browser; the code-payment panel was checked
   only in jsdom with axe, because the demo data has no code sale to open. It should be checked on a phone width once a demo or staging data set contains one.
