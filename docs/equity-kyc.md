# Equity KYC onboarding (R6b)

What OuPay collects from a business **owner** so Equity Bank can later open a business account for collections. It is separate from ordinary
merchant registration, which is unchanged. Nothing here contacts Equity, and nothing here can say that Equity has received, reviewed or
approved anything.

## What an application is, and the statuses

| Status | Meaning | Who can cause it |
| --- | --- | --- |
| `DRAFT` | The owner is still filling it in. Editable. | The owner (starts it) |
| `COLLECTED` | **Submitted to OuPay for review.** Not sent to, received by, or reviewed by Equity. | The owner (submits) |
| `HANDED_OFF` | Evidence shows it was really handed to the bank. | Evidence only |
| `MORE_INFO_REQUESTED` | The bank asked for more (an information request is recorded with its evidence). | Evidence only |
| `APPROVED` / `REJECTED` | The bank decided. Final; a rejected application stays for review and the business may apply again. | Evidence only |

"Evidence" is a verified bank event, or an operator citing written evidence with a second, different person checking (neither a member of
the business). It is recorded by `KycEvidenceService`, which has **no HTTP surface** and is **off** (`oupay.kyc.evidence-recording-enabled=false`);
`KycEvidenceStartupGuard` refuses to start with it on under any profile but `test`, and never together with `prod`. The database refuses the
bank states without evidence on its own (`ck_kyc_applications_*`, `guard_kyc_application`). No merchant request has a status, evidence or
decision field (an architecture test enforces it), and the demo (mock) service can never reach them.

## Reused information, collected once

The draft is prefilled from the business registration: legal name, business type, registration number, TIN, address (with sector, district
and province), contact phone and email, and the representative's name from the registration contact. The values are **copied into the
application** (marked `PREFILL`), so what is submitted is a snapshot that later registration edits never change. Nothing is written back to
the registration, and the merchant `status` is untouched. What registration cannot know (the representative's role and identity document
type, whether an Equity account exists) is asked, never guessed. Linked bank accounts are shown (masked) for information only.

## Requirement sets (configurable, versioned)

`kyc_requirement_sets` holds each published set as data (fields, conditions, documents, consent wording) per provider and version.
Published versions are immutable; Equity changes the list by publishing a **new version** (a new row). An application keeps the version it
started under (`requirement_set_version`), so a later version never changes or invalidates it. **Version 1 is provisional**: OuPay's own
minimal list, flagged `provisional`, not confirmed by Equity (see `equity-technical-questions.md`, section 5). The identity number is optional
for the same reason. A field or document can apply only when another answer has a given value (for example the registration number applies
only to registered businesses).

## Sensitive data and documents

* **Protected fields** (identity number, Equity account number) are stored only as AES-256-GCM ciphertext. The key is configuration
  (`oupay.kyc.encryption-key`, base64 of 32 bytes), never the database or the repository, and each value is bound to its business,
  application and field, so a copied ciphertext does not open elsewhere. **Without a key they are refused**, never stored in the clear.
* **No code path decrypts them except the reveal.** Completeness, consent and submission work from a marker and from the hash of the stored
  ciphertext, so a wrong, rotated or missing key can neither break the application nor replace a value; only the reveal needs the key, and
  it reports a value it cannot read as `409 sensitive_value_unreadable`, changing and recording nothing. Saving a protected value again
  (even unchanged) makes an earlier consent out of date.
* **Showing a saved value in full is disabled** (`oupay.kyc.reveal-enabled=false`, answered `501`): there is no step-up authentication or other
  separately secured workflow yet, so `KycEvidenceStartupGuard` refuses to start with it on outside the `test` profile (never with `prod`). A
  value can only be replaced by typing it again. When enabled (tests only) every reveal writes an event and an audit entry naming the field.
* They are absent from every ordinary response (only "a value exists" and a masked hint), from audit entries, events, snapshots and error
  messages (which name the field, never the value). Reading one back is a separate owner-only action that writes an event and an audit
  entry naming the field.
* **Documents:** OuPay has no secure private object storage, so **uploading is unavailable** (`501`) and nothing is ever stored. A document
  row only records that a requirement exists and that the owner says it is ready (`DECLARED_READY`); `STORED` needs a private object key, a
  content hash, size and type (a URL is refused) and cannot be reached today. Outstanding documents are listed, and a submission to OuPay
  does not pretend otherwise. A requirement set can mark a document `requiredAtSubmission`: only a **stored file** satisfies it, "ready"
  never does (`documents_required`); set 1 marks none, because uploading is unavailable.
* **Retention:** `oupay.kyc.retention-days` (default unset) sets `retention_until` at submission; periods and lawful basis await legal and
  Equity guidance. No deletion job exists.

## Consent

Consent is an explicit affirmation by the signed-in owner, recorded with their name, the requirement-set version, the consent-text version
and hash, the time, and a hash of the **exact answers it covers**. Changing any answer afterwards makes it out of date, and submission
needs a current consent. The wording says submission to OuPay does not mean Equity has received or approved anything.

## API (`/api/v1/merchants/{m}/kyc`, permission `kyc:manage`, owner only)

`GET /options`, `GET /applications`, `POST /applications` (`clientOperationId`, durable and idempotent), `GET /applications/{id}`,
`PUT /applications/{id}/answers` (`expectedVersion`; a blank value clears; the whole save is refused if any value is invalid),
`PUT .../documents/{key}` (declare ready), `POST .../documents/{key}/upload` (always 501), `POST .../consent`, `POST .../submit`
(`submissionRequestId`; a repeat returns the same result), `POST .../information-requests/{id}/response`,
`POST .../answers/{key}/reveal`. Every query is merchant-scoped (composite foreign keys; another business's application is "not found");
managers and cashiers get 403; responses are `Cache-Control: no-store`; writes are one transaction with their audit entry and event.

## Schema (V12)

`kyc_requirement_sets`, `kyc_applications` (with evidence columns, a frozen `submission_snapshot`, one live application per business and
provider), `kyc_answers` (editable only while a draft), `kyc_consents` (append-only), `kyc_documents`, `kyc_information_requests` and
`kyc_events` (append-only, no personal data). Additive; V1 to V11 untouched; V12 has not been applied anywhere persistent.

## Frontend

`/equity-activation` (owner only; navigation entry "Equity activation"): intro, then six steps (Business information, Representative
information, Equity account information, Document requirements, Consent and review, Application status) with Save draft, required and
optional marking, prefill notes, protected values shown only as hints, and status wording that never overstates. HTTP and mock services
share one contract; the demo is labelled and keeps no protected value at all, in storage or in memory (only a masked hint).

## Dependencies on Equity and open decisions

Whether Equity has a submission channel and what it accepts (questions 5.1 to 5.6); the confirmed requirement list; how it asks for more
information and communicates decisions; document storage, retention and the lawful basis (a legal decision); operator authentication.
