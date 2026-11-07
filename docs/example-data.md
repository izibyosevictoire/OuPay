# Built-in example data (R10)

Anyone who signs in to the **ordinary OuPay application** can see what a populated system looks like, without a demo site, a separate login, a database or an importer.
Each of ten pages ends with a collapsed section:

> **EXAMPLE DATA** · See how this looks when it is filled in

Dashboard, Branches, Cashiers, Catalog, Inventory, POS billing, Payments, Invoices, Payment points and Reports each have one. Open it to see the fictional **Kigali Demo Supermarket**
(three branches, an owner, a manager and a cashier, ten goods and two services with stock, two saved carts, four invoices, six simulated payments, two QR codes and an NFC bracelet), in the
same badges and table styles as real records. On a phone each row becomes a labelled card.

The data is the **same R9c fixtures** (`services/mock/kigaliDemo/*`); nothing is duplicated.

## Why it is safe

| Requirement | How |
| --- | --- |
| Never presented as the business's own data | A separate, dashed, amber section **below** the real content, labelled EXAMPLE DATA in its heading and again in a "not yours" notice. Never inside a real table. |
| Not the signed-in business's information | `ExampleData` takes no business and calls no service: it renders fixed fictional records. It works with no providers at all. |
| Read-only | The only control is the open/close toggle. No button, link, form or input for a record, and no handler that could act on one. |
| Not counted in real totals | Real dashboard, report, invoice, stock and payment figures come from the real services and are untouched; the examples are computed separately from the fixtures. Tests compare the real page text before and after opening the examples. |
| Can not reach a mutation endpoint | The HTTP client (the one door to the backend) refuses **any** request whose path, query or body contains the exact identifier of an example record (every fixture `kd-...` and `inv-kds-...` id), before a request or even a CSRF fetch leaves the browser. Exact match only, so a person's own text is never blocked. |
| No mock payment tools in the real build | The examples are **plain static data**. They import no service, no mock logic, no simulator (a test scans the imports). The production bundle is built and checked (below). |
| Real auth, tenants, backend, approvals, tax unchanged | No change to authentication, authorization, the backend, approval gates or tax logic. The only edits to shared code: two lines per page, the HTTP-client guard, and a file move of a pure date helper. |
| Real records | Real branches, products, staff and stock are still created through the existing workflows and persist in PostgreSQL. |

The separate demo build (R9c) is already a demonstration, so it shows no second layer of examples.

## Verifying the production bundle

```bash
npm run verify:bundle
```

builds the real server-backed bundle (`VITE_API_MODE=http`) and checks that none of the **266 strings that exist only in mock payment/financial code and the bank simulator** is in it, that
`simulateRequestPayment`, the simulator scenarios and the demo banner are absent, and that the examples (`EXAMPLE DATA`, `Kigali Demo Supermarket`) are present. A **negative control** (the same
check on a mock-mode build) must fail; both run in the test suite (`src/deploy/productionBundle.test.ts`).

## Tests

`src/features/examples/*.test.tsx` (what the examples show; read-only; static imports; accessibility; phone layout; hidden in the demo build; present on all ten real pages for an owner, manager,
cashier and a second business; identical for every business and free of real details; real totals unchanged), `src/services/http/exampleGuard.test.ts` (example ids can not reach the backend, through the
client or through the real service contracts), `src/deploy/productionBundle.test.ts`.

## Limits

* Examples are fixed and the same for everyone; they are not personalised and are not translated.
* Dates move with the day (the newest example is always about a day old).
* The section is collapsed until opened, so a page stays focused on the real business.
