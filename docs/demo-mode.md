# R9c: Demo Mode (a pre-loaded, browser-only demonstration)

Open Demo Mode and the application is **already full of realistic examples**: a fictional supermarket with branches, people, products, stock, sample carts,
payment points and simulated payments. You learn the screens by using them, add and edit anything, and **reset it whenever you like**.

It needs **no database, no SQL, no seed command, no terminal configuration and no importing.** Everything lives in your browser.

> **DEMO MODE: No real money moves.** This line is on every demo screen, including the customer payment pages.

## How to open it

**On your computer** (needs Node, nothing else):

```bash
npm run dev:demo
```

Open the address it prints (for example `http://localhost:5173`). You land on the demo entry screen: choose **Enter as Owner**, **Enter as Manager** or **Enter as Cashier**.

**As a built site** (what you would host):

```bash
npm run build:demo        # builds into dist-demo/ and writes its hosting file
npm run preview:demo      # serves dist-demo/ locally to look at it
```

**Hosted for other people:** `dist-demo/` is a plain static site. Host it as its **own** site (for example a separate Vercel project made from the `dist-demo` folder, or any
static host). **Do not** reuse the real application's Vercel project: that one is configured for the real backend. The hosting file `build:demo` writes into `dist-demo/vercel.json` is a
single-page-app fallback with **no `/api` rewrite**, so nothing on the demo site can be routed to the real API.

**From the real application (optional):** if the real build is given `VITE_DEMO_URL=<address of the demo site>`, its sign-in page shows a "Try the demo (no real money moves)" link that opens
the demo in a new tab. Unset (the default), nothing changes in the real application.

## Why it is a separate build (the design)

The application chooses its data source **once, at build time**: the real build talks to the backend over HTTP and has **no** in-browser bank simulator (a normal production build must contain no way to
create bank events from the browser). The "simulate a payment" tools and the mock services only exist in a build made for them. So Demo Mode is **the same code, built in a different mode**:

| | Real application | Demo Mode |
| --- | --- | --- |
| Build | `VITE_API_MODE=http` (Vercel) | `vite build --mode demo` (`.env.demo`: mock services, demo experience, demo tools) |
| Data | PostgreSQL through the backend | the browser's own storage |
| HTTP client | used | **never constructed** |
| Browser storage | none | its own `oupay.demo.*` namespace only |
| Bank simulator, simulated-payment buttons | not in the build | present, labelled |
| Fixtures | none | Kigali Demo Supermarket |

A server-backed build can **never** be a demo, whatever else is set (`DEMO_EXPERIENCE` is false whenever `VITE_API_MODE=http`). The Kigali fixtures are removed from every non-demo build by the bundler
(verified: the real `http` bundle contains none of them, and no demo banner or demo entry). A distinct `/demo` route inside the real application was rejected on purpose: it would need the simulator and
the mock services inside the production bundle, and a runtime switch between real and fake services on one page.

It reuses the **existing** mock services and contracts (the same ones the test suite exercises); there is no second frontend. The only changes to shared code are:
the selection of the starting records (`services/mock/seeds.ts`), the storage namespace, and a mock financial report for the demo build.

## What is in it: Kigali Demo Supermarket

| Area | Examples |
| --- | --- |
| Business | Kigali Demo Supermarket, business mode, three branches: **Kigali Main**, **Remera**, **Kimironko** |
| People | Owner **Eric Habimana** (all three branches), Manager **Diane Uwimana** (Kigali Main, Remera), Cashier **Patrick Nsengimana** (Kigali Main) |
| Catalog | **10 goods** (rice, sugar, maize flour, beans, salt, cooking oil, soda, water, notebook, soap; rice has a price history) and **2 services** (phone charging, delivery within Kigali), with packages |
| Inventory | opening stock at **every** branch (Kigali Main carries the whole range), plus a receipt and an adjustment as history; services carry no stock |
| POS carts | **2 drafts**: the cashier's groceries at Kigali Main, the manager's school supplies at Remera (a draft is not a sale) |
| Payment points | **2 static QR** (Kigali Main, Remera) and **1 NFC bracelet** (the cashier's) |
| Payments | 4 invoices (paid, part paid, unpaid, draft) and 6 **simulated** bank events (confirmed, pending, failed, one needing review), allocations and audit lines, all marked simulated |
| Dashboard and report | derived from that same ledger: verified incoming RWF 356,120; applied to invoices RWF 295,520; unmatched RWF 60,600; outstanding RWF 242,000 |

Every record uses one set of IDs, branches, people, catalog references, currency (RWF) and amounts; the tests prove they agree (see below). The example **dates move with the day you first open the demo**
(by whole days, so order and gaps never change), so the newest example is always about a day old and "this month" is never empty.

The three demo accounts are public and fictional; their shared password (`DemoPass123!`) is shown on the entry screen and protects nothing.

## What you can do

All through the existing screens, with the same business rules as the rest of the mock application (permissions per role, branch eligibility, duplicate codes refused, stock cannot go below zero, a
changed price must be reviewed, immutable stock and price history):

add branches, invite staff, create and edit catalog items, change prices, receive and adjust stock, prepare POS carts, register more QR / NFC payment points, bill a cart and open the customer payment-entry
journey, review the simulated transactions, the dashboard and the report.

**The customer journey** (QR or NFC): the cashier bills a cart on a code and binds the bill to a payment point; the customer opens the link (this only *reads*), claims the device, and sees the bill. The
codes in the demo are **simulated**, so by the application's existing rule a bill made with one is a **demonstration that can never be paid and is never shown as paid**, even if the simulator reports a
payment. Nothing is processed by any bank.

## Persistence and reset

* The example data is written **once, the first time the demo opens** (`oupay.demo.demoInitialisedAt`), then **never again**: a refresh, a closed tab or a restarted browser keeps everything you
  did, and an edited record is never put back. (Signing in is remembered, so you come back to the same place.)
* **Reset demo data** (in the banner on every screen) asks for confirmation, then removes the demo's own records, its sign-in marker and its leftover cart/claim state, and reloads the original examples. It
  never touches anything outside the demo (the ordinary mock namespace, other sites' data).
* The data belongs to **this browser on this address**: another browser, a private window or cleared site data starts from the examples again. If a browser blocks storage entirely the demo still runs, but
  forgets on reload.

## Safety (what Demo Mode never does)

* Never sends a request to any server (no `fetch`; the HTTP client is not even created), so a demo change can never reach a production API.
* Never reads or writes the real application's data: the demo has its own storage namespace, no real session, merchant, bank or PostgreSQL. Demo totals and the demo report are derived only from the demo ledger and
  are never mixed with a real report (the real report is the server's).
* Every fake transaction carries `isSimulated`, a `SIM-` identifier and "simulated" wording; none is presented as an Equity confirmation. The collection codes are simulated; there is no real code or approval.
* Never asks for a PIN, one-time code or bank credential.
* The real application's deployment files and security guards are unchanged (`vercel.json`, the backend, CSP/headers); a test fails if they change.

## Limitations (so nobody is surprised)

* A demonstration bill is never "paid" (above): the demo shows the journey up to the bill, not a completed payment.
* Tax classes on the demo catalog are demonstration values only (salt is deliberately unclassified, to show that an unclassified item cannot be billed). They are not tax advice.
* Physical NFC and phone-camera QR scanning are not exercised here (they need real hardware); the QR/NFC *screens and links* are.
* Single browser, single user at a time: there is no sync and no sharing between devices or people.

## Tests

`src/services/mock/kigaliDemo/*.test.ts`, `src/lib/demoExperience.test.ts`, `src/features/demo/DemoMode.test.tsx`, `src/deploy/demoDeploy.test.ts`:

* the fixtures are internally consistent (people, branches, carts, stock, payment points, ledger, invoices, codes) and simulated;
* the demo opens with the examples in every module, per role; the dashboard and the report agree;
* users can add their own data and the business rules still refuse what they should;
* changes survive a refresh and are not reseeded; reset restores the originals and touches nothing else;
* a whole journey sends **no network request** and writes only `oupay.demo.*`; another business is "not found";
* the QR and NFC journeys run on simulated money only; a demonstration bill is never paid;
* build flags: a server build is never the demo, never reads demo data, and keeps using the server;
* the demo hosting file has no `/api` rewrite; the real `vercel.json` is unchanged.
