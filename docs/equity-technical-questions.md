# Questions for Equity Bank Rwanda: possible merchant collection codes and integration

**From:** OuPay (a business platform for merchants and their sales agents)
**To:** Equity Bank Rwanda, technical integration and merchant-services teams
**Purpose:** to confirm what Equity supports before we design or build anything against it.

## Context

OuPay serves merchants who bank with Equity. We would like to understand whether merchants can collect customer payments through
**Equity merchant payment codes** (if Equity offers them in this form), possibly with one merchant's Equity account associated with
**several collection codes** (for example one per sales agent or collection point), and with payment confirmation reliable enough to
apply to a customer's invoice. Every item below is a question, not a description of what Equity provides. If Equity does not offer
merchant codes in this form, please describe the closest supported option instead.

We have **not** integrated with Equity. We are **not** assuming any capability, endpoint, field, USSD syntax or message format. We will
only describe to customers, and build against, what Equity confirms in writing. Please answer with exact terms where possible and say
plainly where something is **not supported**.

How to answer each item: mark **Supported / Not supported / Partly (explain) / Not decided**, and add notes, documentation links and
limits. Items marked **(blocking)** decide the shape of our design.

## 1. Merchant codes and accounts (blocking)

If merchant codes do not exist in the form described here, please say so and describe what Equity offers for merchant collection.

1.1 Can **one Equity business account** have **multiple** merchant/till/collection codes at the same time? Is there a maximum?

1.2 Can a **distinct code be provisioned per sales agent or collection point** of the same merchant? What is Equity's term for this
(till, merchant code, agent code, other)?

1.3 Who **issues** codes: Equity only, or can a partner register its own identifiers? What is the format, length, character set, and
are codes unique across all merchants for ever (including after deactivation)?

1.4 How is a code **requested**, approved, activated, suspended, deactivated and re-issued? Through an API, a portal, forms, an
account manager? What is the approval time? Are there fees?

1.5 Is a code tied to a **named person**, or only to the merchant? May a merchant move a code between its own agents? Is anything
reported to Equity when it does?

1.6 What does the **payer see** when paying a code (merchant name, code, amount confirmation)? What does a customer need to know
or enter? Please describe the real customer journey on each channel Equity supports. We will not describe any channel you do not
confirm.

## 2. Identifying the payment (blocking)

2.1 Does Equity return the **original merchant/till code** on **every confirmed transaction** notification and statement line?

2.2 Can a payment carry an **additional unique reference** that we supply (for example a per-sale reference)? If so: where is it
entered, what length and characters are allowed, and is it returned **unchanged** on notifications and statements? Can the payer
mistype it, and how is that handled?

2.3 Is there a **bill-validation, dynamic-reference or pre-registration** mechanism by which a specific sale and amount can be bound
to a payment before the customer pays?

2.4 What identifiers does a transaction carry (unique transaction id, event id, payer account or name, narration), and which are
**guaranteed unique and stable**? Please state which fields may be absent.

2.5 Are **reversals, failures and chargebacks** reported as separate events, and with what identifiers and timing?

## 3. Notifications, reconciliation and settlement

3.1 How do we learn that a payment was **confirmed**: push (webhook), message queue, file, or polling? What are the delivery
guarantees, retry policy, ordering guarantees, expected latency and maximum replay window? May events arrive twice or out of
order?

3.2 Is there a **transaction status/query API** to verify a payment independently of a notification?

3.3 What **reconciliation reports or statements** exist (format, frequency, API or file), and do they include the code and any
reference?

3.4 What are the **settlement** timing, cut-off times, currency, **fees** (and whether amounts are reported gross or net), and
per-transaction or daily **limits**?

## 4. Security and authentication

4.1 How are Equity's notifications **authenticated** (signature, mutual TLS, IP allow-list, shared secret, other)? How are
credentials issued, **rotated** and revoked?

4.2 How should OuPay authenticate **to** Equity for any API call? Are there environment, IP or certificate requirements?

4.3 What are the **data protection**, logging, retention and data-residency requirements for transaction and customer data we
receive?

## 5. Merchant onboarding and KYC

5.1 Is there an **onboarding or KYC submission** integration (API, secure file transfer, portal)? If not, what is the accepted manual
process?

5.2 What **information and documents** are required for a business, by business type (company, cooperative, non-profit, sole
proprietor, informal vendor)? Please share the current list, accepted formats and size limits, and which fields are mandatory.

5.3 How does Equity treat **existing customers** versus new ones? What identifies an existing account safely?

5.4 What are the **authorised representative** requirements (identity document types, verification, signing authority)?

5.5 How and when does Equity **request additional information or documents** later, and how is **approval or rejection**
communicated to the merchant and to us (and in what form we can treat as evidence)?

5.6 What are the approval **timelines** and service levels, and who is the owner of the KYC data after submission?

## 6. Environments and commercial/legal

6.1 Is there a **sandbox/test environment** with realistic codes and notifications? What is needed to obtain access?

6.2 What is the **legal and commercial model** for a platform acting between the merchant and Equity (partner agreement, roles,
liability, merchant-of-record)? What approvals does OuPay need before going live?

6.3 What **support, escalation and incident** processes exist, and what are the **service levels** of the APIs and notifications?

## 7. Equity Rwanda specifically

7.1 For each answer above, please state whether it applies to **Equity Rwanda** or to Equity group in general, and note anything
that differs by country, product or channel.

7.2 Which of these capabilities are **planned but not yet available**, and when?

## Summary table (please complete)

| # | Capability | Supported / Not supported / Partly / Not decided | Notes and documentation |
| --- | --- | --- | --- |
| 1.1 | Multiple codes on one business account | | |
| 1.2 | A distinct code per agent or collection point | | |
| 1.3 | Codes issued by Equity (or registered by partner) | | |
| 2.1 | Original code returned on each confirmed transaction | | |
| 2.2 | Additional unique reference carried and returned | | |
| 2.3 | Bill validation / dynamic reference | | |
| 3.1 | Authenticated confirmed-payment notifications | | |
| 3.3 | Reconciliation and settlement reports | | |
| 4.1 | Authentication scheme for notifications | | |
| 5.1 | KYC/onboarding submission integration | | |
| 6.1 | Sandbox available | | |

Thank you. A written reply (or a working session with the technical team) lets us design only what Equity actually supports.
