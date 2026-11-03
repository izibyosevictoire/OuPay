# Payment-entry devices: field test (static QR and NFC)

This document separates **what software testing has proven** from **what needs a phone, a printer and an NFC tag**. Nothing marked PENDING has been
done: no physical phone, camera, NFC tag or NFC-capable phone was available when R8b was prepared, and **no browser or unit test is to be
described as a hardware validation**.

## 0. Before anything is printed or written for real: verify the domain

The permanent URL is `<customer domain>/e/{token}`. The customer domain is **configuration, not a fixed value**: the frontend reads
`VITE_PUBLIC_PAYMENT_BASE_URL`, and its default `https://pay.oupay.rw` is **illustrative, not a confirmed or deployed domain**. A QR code or NFC tag
carries that domain forever, so **before any real print run or tag write**: set the variable to the real, owned HTTPS domain; confirm it serves the
OuPay frontend and proxies `/api` to the backend; open a registered device's link on a phone to confirm it resolves; and only then print or write.
If the domain ever changes, every printed code and written tag must be replaced (the server cannot redirect a domain it does not control).

## 1. Status at a glance

| Area | Software (automated, real PostgreSQL / jsdom / real browser layout) | Physical hardware |
| --- | --- | --- |
| QR encodes exactly the permanent HTTPS URL | **Proven**: a real QR decoder (jsQR) reads the rendered code back to the URL, at print size and at a low-resolution raster; nothing but the URL is encoded | **PENDING**: phone camera recognises the printed code |
| QR readability when printed (size, contrast, lamination, distance) | Guidance shown on the print page | **PENDING** |
| NFC tag content | The instructions describe one NDEF URI record containing exactly the link; the tag never holds an amount or claim | **PENDING**: write a real tag, read it back, tap with a phone |
| Tap opens the same resolver as the QR | Same URL, same public resolver (tested) | **PENDING** |
| Revoking a device kills the link everywhere | **Proven** server side for every copy of the URL, and each device independently | **PENDING**: tap a revoked tag and see "not available" |
| Repeat sales on the same printed code | **Proven** (the path never changes; bill after bill; customers never mixed) | **PENDING** with a physical counter |

## 2. What the software tests proved

* `PaymentEntryJourneyIT`: one device, two sales in order; the same permanent path throughout; a second customer sees "payment in progress" without any
  detail; the cashier sees the device is busy; payment reaches the customer who holds the claim; a finished bill is never shown to a newcomer;
  the next bill is bound on the same printed code; the earlier customer keeps seeing their own bill; two devices are independently revocable;
  a demonstration journey creates no bank transaction, allocation, invoice, stock movement or reservation.
* `PaymentEntryRateLimitIT`: scanning and claiming floods are refused (429) with no data about the device, bill or business.
* `EntryJourney.test.tsx`: the printed QR decodes to the URL (and is byte-for-byte the same after sales and a new bill); the NFC instructions; what a
  cashier sees at a busy payment point and what closing a claim means.
* Real-browser layout checks at 375, 768 and 1280 px (see the R8b report).

## 3. Reproducible physical test: static QR

Equipment: the deployed or local app reachable from the phone over HTTPS (or a tunnel), one printer, two phones (an iPhone and an Android phone, both
using the stock camera app), a paper ruler.

1. Sign in as an owner. **Payment points → Register a payment point**: kind *Static QR code*, a name, a branch. Copy the permanent link; note it.
2. **Print QR code** (or *Download PNG* and print it elsewhere). Print black on white, with the white border, at **3 cm × 3 cm**, then at **6 cm × 6 cm**.
3. Point each phone camera at each print from 15 cm, 30 cm and 60 cm, in daylight and under a dim indoor light. **Record**: recognised? the URL the
   phone offers equals the copied link character for character?
4. Tap the offered link. Expect the customer page with *"A bill is ready here"* **only after a cashier binds a bill**; before that, *"No bill is ready…"*.
5. As the cashier (or owner): give the payment point a prepared bill (**Give a bill**). On phone A press **Show my bill**. **Record**: the amount and
   the sale reference equal the cashier's receipt.
6. With phone B, scan the **same printed code**. Expect **"Payment in progress"** and no amount, reference or code. The cashier sees *BUSY*.
7. Finish with phone A (**I am finished**), or let the 5-minute session run out. Expect *SESSION_ENDED* on A with the same bill and its real status
   (never "failed").
8. Give the payment point a **second** bill. Scan the **same printed code** again with phone B. Expect the second bill. The code was not reprinted.
9. Repeat step 3 after laminating the print (glare check).
10. **Revoke** the payment point; scan it again. Expect *"This payment point is not available"*.

Pass criteria: every scan in step 3 within 60 cm recognises the code and offers exactly the link; steps 5-8 behave as described.

## 4. Reproducible physical test: NFC tag

Equipment: two blank NFC tags (NDEF-capable, for example NTAG213/215/216, Type 2), an NFC writer app on an NFC-capable phone, a second NFC phone.

1. Register an *NFC tag or card* payment point (and, separately, a second one). Copy each permanent link.
2. In the writer app choose **Write → URL / URI** and paste **exactly** the link (https, no spaces, nothing added). Write **one** record per tag. Do **not**
   write an amount, a sale reference, a name or a bank code.
3. **Read the tag back** with the same app; compare to the link character by character.
4. Tap the tag with a second phone. Expect the same customer page as the QR (*READY* once a bill is bound).
5. Change the active bill (cashier gives another bill). Tap again. Expect the new bill **without rewriting the tag**.
6. Revoke the first payment point. Tap tag 1: *not available*. Tap tag 2: still works. (Independent identities.)
7. **Locking is not part of this procedure.** Locking a tag is optional and irreversible on some tags; OuPay does not need it, because revoking the
   device disables the link on the server whatever the tag holds. If you lock a tag, do it only after step 3 and 4 passed.

Pass criteria: the read-back equals the link; tap opens the resolver; step 5 needs no rewrite; step 6 revokes only the chosen device.

## 5. Recording the result

For each physical test keep: date, phone models and OS versions, tag type, print size, what happened. **Hardware verification remains PENDING until a
person records it here.** Do not copy results from a browser test into this table.

| Test | Date | Device(s) | Result |
| --- | --- | --- | --- |
| Static QR, 3 cm print | PENDING | | |
| Static QR, 6 cm print | PENDING | | |
| NFC tag write and read-back | PENDING | | |
| NFC tap resolves like the QR | PENDING | | |
| Revocation of one of two devices | PENDING | | |
