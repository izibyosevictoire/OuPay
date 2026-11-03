import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import jsQR from 'jsqr'
import { DEMO_USER_IDS } from '@/services/mock/sampleAccounts'
import { SAMPLE_MERCHANT_ID } from '@/services/mock/sampleMerchants'
import { SAMPLE_BRANCH_IDS } from '@/services/mock/sampleOrganization'
import { getActiveTestBackend, useFastBackend } from '@/test/merchantTestDouble'
import { renderAppAt } from '@/test/renderApp'

const M = SAMPLE_MERCHANT_ID
const URL_PATTERN = /^https:\/\/pay\.oupay\.rw\/e\/[A-Za-z0-9_-]{22}$/

beforeEach(() => {
  useFastBackend()
  window.sessionStorage.clear()
})

let counter = 0
const requestId = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`

/** Rasterises the on-screen SVG as drawn, so a real QR decoder (jsQR) can read it back: software validation, NOT a phone camera. */
function decodeQr(svg: Element, scale: number): string | null {
  const [, , width = 0] = (svg.getAttribute('viewBox') ?? '').split(' ').map(Number)
  const size = width * scale
  const pixels = new Uint8ClampedArray(size * size * 4).fill(255)
  const d = svg.querySelector('path')!.getAttribute('d')!
  for (const match of d.matchAll(/M(\d+) (\d+)h1v1h-1z/g)) {
    const [x, y] = [Number(match[1]), Number(match[2])]
    for (let dy = 0; dy < scale; dy += 1) {
      for (let dx = 0; dx < scale; dx += 1) {
        const offset = ((y * scale + dy) * size + (x * scale + dx)) * 4
        pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = 0
      }
    }
  }
  return jsQR(pixels, size, size)?.data ?? null
}

/** A simulated code that the cashier (Aline) holds at Remera, and demonstration sales billed by her on it. */
async function demoSales(...amounts: number[]) {
  const t = getActiveTestBackend()
  t.signInAs('owner')
  const profile = t.ledger.paymentProfiles
    .load()
    .find((p) => p.merchantId === M && p.status === 'ACTIVE' && p.assignedCashierId === null)
  const destination = t.ledger.paymentDestinations
    .load()
    .find((d) => d.id === profile?.paymentDestinationId)
  if (!destination) throw new Error('the sample ledger has no destination to settle to')
  const requested = await t.fastCollectionCodes.requestCode(M, {
    clientOperationId: crypto.randomUUID(),
    settlementDestinationId: destination.id,
    displayLabel: 'Demo counter',
    branchId: SAMPLE_BRANCH_IDS.remera,
  })
  await t.fastCollectionCodes.assign(M, requested.code.id, { membershipId: 'mem-004' })
  t.signInAs('cashier')
  const sales = []
  for (const amountRwf of amounts) {
    sales.push(
      await t.fastCodeCheckout.codeCheckoutService.billCodeSale(M, {
        amountRwf,
        description: 'Two coffees',
        collectionCodeId: requested.code.id,
        clientRequestId: requestId(),
        idempotencyKey: `idem-key-${counter}-${'x'.repeat(8)}`,
      }),
    )
  }
  return sales
}

async function registerDevice(displayName = 'Counter 1') {
  const t = getActiveTestBackend()
  t.signInAs('owner')
  const { device } = await t.fastEntryDevices.entryDeviceService.registerDevice(M, {
    clientRequestId: requestId(),
    deviceType: 'STATIC_QR',
    displayName,
    branchId: SAMPLE_BRANCH_IDS.remera,
    assignedCashierUserId: DEMO_USER_IDS.cashier,
  })
  return device
}

const tokenOf = (entryPath: string) => entryPath.slice(3)

describe('the printed QR code (software decode, not a phone camera)', () => {
  it('decodes, at print resolution and at a low-resolution photo size, to exactly the permanent URL and nothing else', async () => {
    const device = await registerDevice()
    await renderAppAt(`/entry-devices/${device.id}/print`)
    const qr = await screen.findByRole('img', { name: /QR code for Counter 1/ })
    const url = qr.getAttribute('data-qr-value') as string
    expect(url).toMatch(URL_PATTERN)
    expect(url.endsWith(device.entryPath)).toBe(true)
    // A real decoder reads exactly that string back, even from a small raster.
    expect(decodeQr(qr, 6)).toBe(url)
    expect(decodeQr(qr, 2)).toBe(url)
    // No amount, sale reference, claim, bank detail or person is encoded.
    expect(decodeQr(qr, 6)).not.toMatch(/OP-|EQ-|SIM-|claim|RWF|Aline|mrc-|bacc-|dst-/i)
    expect(screen.getByText(/at least 3 cm by 3 cm/)).toBeInTheDocument()
    expect(screen.getByText(/print it\s+once/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Download PNG/ })).toBeEnabled()
  })

  it('stays byte-for-byte the same after sales, claims and a new bill (the code is never regenerated)', async () => {
    const [first, second] = await demoSales(5_000, 7_000)
    const device = await registerDevice()
    const t = getActiveTestBackend()
    const before = await renderAppAt(`/entry-devices/${device.id}/print`)
    const urlBefore = (await screen.findByRole('img', { name: /QR code/ })).getAttribute(
      'data-qr-value',
    )
    before.unmount()
    t.signInAs('cashier')
    const bound = await t.fastEntryDevices.entryDeviceService.bindSale(M, device.id, {
      saleId: first!.saleId,
      expectedVersion: device.version,
    })
    const claim = await t.fastEntryDevices.publicEntryService.claim(tokenOf(device.entryPath))
    expect(claim.state).toBe('CLAIMED')
    await t.fastEntryDevices.entryDeviceService.unbindSale(M, device.id, {
      reason: 'Done',
      confirmActiveSession: true,
    })
    await t.fastEntryDevices.entryDeviceService.bindSale(M, device.id, {
      saleId: second!.saleId,
      expectedVersion: bound.version + 1,
    })
    await renderAppAt(`/entry-devices/${device.id}/print`)
    expect(
      (await screen.findByRole('img', { name: /QR code/ })).getAttribute('data-qr-value'),
    ).toBe(urlBefore)
  })
})

describe('writing the NFC tag', () => {
  it('describes one URI record with exactly the link, no sale data, no rewriting, and locking only as an option', async () => {
    const user = userEvent.setup()
    const t = getActiveTestBackend()
    t.signInAs('owner')
    const { device } = await t.fastEntryDevices.entryDeviceService.registerDevice(M, {
      clientRequestId: requestId(),
      deviceType: 'NFC_TAG',
      displayName: 'Door tag',
      branchId: SAMPLE_BRANCH_IDS.remera,
      assignedCashierUserId: null,
    })
    await renderAppAt('/entry-devices')
    const region = await screen.findByLabelText('Payment point Door tag')
    await user.click(within(region).getByRole('button', { name: /Writing the NFC tag/ }))
    expect(within(region).getByText(/exactly this link/)).toBeInTheDocument()
    expect(within(region).getByText(/Write ONE record/)).toBeInTheDocument()
    expect(
      within(region).getByText(/Never write a sale amount, a sale reference/),
    ).toBeInTheDocument()
    expect(
      within(region).getByText(/You never rewrite the tag when the bill changes/),
    ).toBeInTheDocument()
    expect(within(region).getByText(/Read the tag back/)).toBeInTheDocument()
    expect(
      within(region).getByText(/revoke the payment point and the link stops working everywhere/),
    ).toBeInTheDocument()
    // Locking is optional and is never an instruction.
    expect(
      within(region).getByText(/Locking the tag is OPTIONAL and cannot be undone on some tags/),
    ).toBeInTheDocument()
    expect(region.textContent ?? '').not.toMatch(/lock the tag after writing/i)
    const link = (within(region).getByLabelText(/Permanent link/) as HTMLInputElement).value
    expect(link).toMatch(URL_PATTERN)
    expect(link.endsWith(device.entryPath)).toBe(true)
  })
})

describe('the cashier at a busy payment point', () => {
  it('sees that a customer is looking, what ending it means, and the customer keeps their own bill', async () => {
    const user = userEvent.setup()
    const [first] = await demoSales(9_000)
    const device = await registerDevice()
    const t = getActiveTestBackend()
    t.signInAs('cashier')
    await t.fastEntryDevices.entryDeviceService.bindSale(M, device.id, {
      saleId: first!.saleId,
      expectedVersion: device.version,
    })
    const claimed = await t.fastEntryDevices.publicEntryService.claim(tokenOf(device.entryPath))
    const claim = claimed.claim?.claimToken as string

    await renderAppAt('/entry-devices', { signedInAs: 'cashier' })
    const region = await screen.findByLabelText('Payment point Counter 1')
    expect(
      within(region).getByText(/BUSY: a customer is looking at this bill right now/),
    ).toBeInTheDocument()
    expect(
      within(region).getByText(/Anyone else who scans sees "Payment in progress"/),
    ).toBeInTheDocument()

    await user.click(within(region).getByRole('button', { name: 'Stop opening this bill' }))
    const dialog = await screen.findByRole('dialog', { name: 'Stop opening this bill?' })
    expect(
      within(dialog).getByText(/does not cancel the bill and does not mean it failed/),
    ).toBeInTheDocument()
    expect(
      within(dialog).getByText(/only the bank\s+decides whether it was paid/),
    ).toBeInTheDocument()
    // Without the explicit confirmation the close is refused and the customer is not cut off.
    await user.click(within(dialog).getByRole('button', { name: 'Stop opening this bill' }))
    expect(
      await within(dialog).findByText(/A customer is looking at this bill right now\. Confirm/),
    ).toBeInTheDocument()
    expect(
      (await t.fastEntryDevices.publicEntryService.resolve(tokenOf(device.entryPath), claim)).state,
    ).toBe('CLAIMED')
    await user.click(within(dialog).getByRole('checkbox'))
    await user.click(within(dialog).getByRole('button', { name: 'Stop opening this bill' }))
    await waitFor(() =>
      expect(within(region).getByText(/Idle: no bill is open here/)).toBeInTheDocument(),
    )

    // The customer's tab shows the ended session, the very bill they had, and never "failed".
    window.sessionStorage.setItem(`oupay.entry.claim.${tokenOf(device.entryPath)}`, claim)
    const view = await renderAppAt(`/e/${tokenOf(device.entryPath)}`, { signedInAs: null })
    expect(
      await screen.findByText(/Your session at this payment point has ended/),
    ).toBeInTheDocument()
    expect((await screen.findAllByText(first!.saleReference)).length).toBeGreaterThan(0)
    expect(screen.getByText('Awaiting payment')).toBeInTheDocument()
    expect(document.body.textContent ?? '').not.toMatch(/failed/i)
    expect(
      screen.getByText(/permanent payment point: it stays the same for every customer/),
    ).toBeInTheDocument()
    view.unmount()
  })
})

describe('the customer page never shows a cached answer', () => {
  it('asks again on every visit, so a payment point that was busy and has since been freed shows as ready', async () => {
    const [sale] = await demoSales(6_000)
    const device = await registerDevice()
    const t = getActiveTestBackend()
    t.signInAs('cashier')
    await t.fastEntryDevices.entryDeviceService.bindSale(M, device.id, {
      saleId: sale!.saleId,
      expectedVersion: device.version,
    })
    const token = tokenOf(device.entryPath)
    const holder = await t.fastEntryDevices.publicEntryService.claim(token)
    const { router } = await renderAppAt(`/e/${token}`, { signedInAs: null })
    expect(await screen.findByRole('heading', { name: 'Payment in progress' })).toBeInTheDocument()
    // The holder finishes; this customer leaves the page and comes back within the same minute.
    await router.navigate('/e/AAAAAAAAAAAAAAAAAAAAAA')
    await screen.findByRole('heading', { name: 'This payment point is not available' })
    await t.fastEntryDevices.publicEntryService.release(token, holder.claim?.claimToken)
    await router.navigate(`/e/${token}`)
    expect(await screen.findByRole('button', { name: 'Show my bill' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Payment in progress' })).not.toBeInTheDocument()
  })
})
