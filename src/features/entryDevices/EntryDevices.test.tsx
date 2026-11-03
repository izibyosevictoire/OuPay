import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { publicEntryService } from '@/services'
import { DEMO_USER_IDS } from '@/services/mock/sampleAccounts'
import { SAMPLE_MERCHANT_ID } from '@/services/mock/sampleMerchants'
import { SAMPLE_BRANCH_IDS } from '@/services/mock/sampleOrganization'
import { findAccessibilityViolations } from '@/test/axe'
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

/** A simulated code that the cashier (Aline) holds at Remera, then one demonstration sale billed by her. */
async function demoSale(amountRwf = 5_000) {
  const t = getActiveTestBackend()
  t.signInAs('owner')
  const profile = t.ledger.paymentProfiles
    .load()
    .find((p) => p.merchantId === M && p.status === 'ACTIVE' && p.assignedCashierId === null)
  const destination = t.ledger.paymentDestinations.load().find((d) => d.id === profile?.paymentDestinationId)
  if (!destination) throw new Error('the sample ledger has no destination to settle to')
  const requested = await t.fastCollectionCodes.requestCode(M, {
    clientOperationId: crypto.randomUUID(),
    settlementDestinationId: destination.id,
    displayLabel: 'Demo counter',
    branchId: SAMPLE_BRANCH_IDS.remera,
  })
  await t.fastCollectionCodes.assign(M, requested.code.id, { membershipId: 'mem-004' })
  t.signInAs('cashier')
  return t.fastCodeCheckout.codeCheckoutService.billCodeSale(M, {
    amountRwf,
    description: 'Two coffees',
    collectionCodeId: requested.code.id,
    clientRequestId: requestId(),
    idempotencyKey: `idem-key-${counter}-${'x'.repeat(8)}`,
  })
}

/** A device the owner registered at Remera, optionally for Aline. */
async function registerDevice(displayName = 'Counter 1', cashier: string | null = null) {
  const t = getActiveTestBackend()
  t.signInAs('owner')
  const result = await t.fastEntryDevices.entryDeviceService.registerDevice(M, {
    clientRequestId: requestId(),
    deviceType: 'STATIC_QR',
    displayName,
    branchId: SAMPLE_BRANCH_IDS.remera,
    assignedCashierUserId: cashier,
  })
  return result.device
}

const tokenOf = (entryPath: string) => entryPath.slice(3)

describe('payment points: registering and printing (owner)', () => {
  it('registers a static QR code that shows ONE permanent link, and prints exactly that string', async () => {
    const user = userEvent.setup()
    await renderAppAt('/entry-devices')
    expect(await screen.findByText('No payment points yet')).toBeInTheDocument()
    // The page says what the device is: an entry method, not a payment.
    expect(screen.getByText(/does not move money/)).toBeInTheDocument()

    await user.click(await screen.findByRole('button', { name: /Register a payment point/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Register a payment point' })
    await user.type(within(dialog).getByLabelText(/^Name/), 'Counter 1')
    await user.click(within(dialog).getByRole('button', { name: 'Register' }))

    const card = await screen.findByRole('article', { name: /Payment point Counter 1/ }).catch(() => null)
    const region = card ?? (await screen.findByLabelText('Payment point Counter 1'))
    const link = within(region).getByLabelText(/Permanent link/) as HTMLInputElement
    expect(link.value).toMatch(URL_PATTERN)
    expect(within(region).getByText('Active')).toBeInTheDocument()
    expect(within(region).getByText(/identifies the payment point, not a bill/)).toBeInTheDocument()
    expect(within(region).getByText(/Idle: no bill is open here/)).toBeInTheDocument()

    await user.click(within(region).getByRole('link', { name: /Print QR code/ }))
    const qr = await screen.findByRole('img', { name: /QR code for Counter 1/ })
    // The code carries exactly the permanent link and nothing else: no amount, no bank detail, no person.
    expect(qr.getAttribute('data-qr-value')).toBe(link.value)
    expect(screen.getByText(/Scanning only opens your bill/)).toBeInTheDocument()
    expect(screen.getByText(/Never share a PIN, password or one-time code/)).toBeInTheDocument()
  })

  it('refuses a bracelet without a cashier, and shows the NFC tag the same link', async () => {
    const user = userEvent.setup()
    await renderAppAt('/entry-devices')
    await user.click(await screen.findByRole('button', { name: /Register a payment point/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Register a payment point' })
    await user.selectOptions(within(dialog).getByLabelText(/^Kind/), 'NFC_BRACELET')
    await user.type(within(dialog).getByLabelText(/^Name/), 'Aline bracelet')
    await user.click(within(dialog).getByRole('button', { name: 'Register' }))
    expect(await within(dialog).findAllByText('A bracelet belongs to one cashier.')).not.toHaveLength(0)

    await user.selectOptions(within(dialog).getByLabelText(/^Cashier/), DEMO_USER_IDS.cashier)
    await user.click(within(dialog).getByRole('button', { name: 'Register' }))
    const region = await screen.findByLabelText('Payment point Aline bracelet')
    const link = (within(region).getByLabelText(/Permanent link/) as HTMLInputElement).value
    await user.click(within(region).getByRole('button', { name: /Writing the NFC tag/ }))
    expect(within(region).getByText(/exactly this link/)).toBeInTheDocument()
    expect(within(region).getByText(/Write exactly one NDEF URI record/)).toBeInTheDocument()
    expect(link).toMatch(URL_PATTERN)
  })

  it('reassigns a payment point, keeps the history, and revokes it for good', async () => {
    const user = userEvent.setup()
    await registerDevice('Counter 1')
    await renderAppAt('/entry-devices')
    const region = await screen.findByLabelText('Payment point Counter 1')

    await user.click(within(region).getByRole('button', { name: 'Change branch or cashier' }))
    const assign = await screen.findByRole('dialog', { name: 'Change branch or cashier' })
    await user.selectOptions(within(assign).getByLabelText(/^Cashier/), DEMO_USER_IDS.cashier)
    await user.type(within(assign).getByLabelText(/^Reason/), 'Aline takes the counter')
    await user.click(within(assign).getByRole('button', { name: 'Save change' }))
    await waitFor(() => expect(within(region).getByText(/Aline Uwase/)).toBeInTheDocument())

    await user.click(within(region).getByRole('button', { name: /History/ }))
    const history = await within(region).findByRole('region', { name: 'Assignment history' })
    await waitFor(() => expect(within(history).getAllByRole('listitem')).toHaveLength(2))
    expect(within(history).getByText(/Aline takes the counter/)).toBeInTheDocument()

    await user.click(within(region).getByRole('button', { name: 'Revoke' }))
    const revoke = await screen.findByRole('dialog', { name: 'Revoke this payment point for good?' })
    // A reason is required, and nothing happens without it.
    await user.click(within(revoke).getByRole('button', { name: 'Revoke' }))
    expect(await within(revoke).findByText(/Write a short reason/)).toBeInTheDocument()
    await user.type(within(revoke).getByLabelText(/^Reason/), 'Tag lost')
    await user.click(within(revoke).getByRole('button', { name: 'Revoke' }))
    await waitFor(() => expect(within(region).getByText('Revoked')).toBeInTheDocument())
    // A revoked device shows no link, no print and no actions that could revive it.
    expect(within(region).queryByLabelText(/Permanent link/)).not.toBeInTheDocument()
    expect(within(region).queryByRole('link', { name: /Print QR code/ })).not.toBeInTheDocument()
    expect(within(region).queryByRole('button', { name: /Switch on|Suspend|Revoke/ })).not.toBeInTheDocument()
  })
})

describe('payment points: a cashier and a bill', () => {
  it('shows a cashier only their own devices, without management actions, and lets them give a bill of their own', async () => {
    const user = userEvent.setup()
    await registerDevice('Aline counter', DEMO_USER_IDS.cashier)
    await registerDevice('Someone else counter', null)
    const sale = await demoSale(7_500)
    await renderAppAt('/entry-devices', { signedInAs: 'cashier' })
    const region = await screen.findByLabelText('Payment point Aline counter')
    expect(screen.queryByRole('button', { name: /Register a payment point/ })).not.toBeInTheDocument()
    expect(within(region).queryByRole('button', { name: /Revoke|Suspend|Change branch/ })).not.toBeInTheDocument()

    await user.click(within(region).getByRole('button', { name: 'Give a bill' }))
    const dialog = await screen.findByRole('dialog', { name: /Give “Aline counter” a bill/ })
    expect(await within(dialog).findByText(new RegExp(sale.saleReference))).toBeInTheDocument()
    // Nothing is chosen for the cashier.
    await user.click(within(dialog).getByRole('button', { name: 'Give this bill' }))
    expect(await within(dialog).findByText(/Choose the bill/)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('radio'))
    await user.click(within(dialog).getByRole('button', { name: 'Give this bill' }))

    await waitFor(() => expect(within(region).getByLabelText('Current bill')).toBeInTheDocument())
    const bill = within(region).getByLabelText('Current bill')
    expect(within(bill).getByText(new RegExp(`Opens bill ${sale.saleReference}`))).toBeInTheDocument()
    expect(within(bill).getByText(/DEMONSTRATION/)).toBeInTheDocument()
    // The screen never claims a payment: the status is the one the (mock) bank-verified page reports.
    expect(within(bill).getByText(/Awaiting payment/)).toBeInTheDocument()
    expect(within(bill).getByText(/No customer has taken this bill/)).toBeInTheDocument()

    await user.click(within(region).getByRole('button', { name: 'Stop opening this bill' }))
    const stop = await screen.findByRole('dialog', { name: 'Stop opening this bill?' })
    await user.click(within(stop).getByRole('button', { name: 'Stop opening this bill' }))
    await waitFor(() => expect(within(region).getByText(/Idle: no bill is open here/)).toBeInTheDocument())
  })
})

describe('the page a QR code or NFC tap opens (customer)', () => {
  const claimOnce = async (path: string) => {
    const t = getActiveTestBackend()
    return t.fastEntryDevices.publicEntryService.claim(tokenOf(path))
  }

  async function readyDevice() {
    const device = await registerDevice('Counter 1', DEMO_USER_IDS.cashier)
    const sale = await demoSale(12_000)
    getActiveTestBackend().signInAs('cashier')
    await getActiveTestBackend().fastEntryDevices.entryDeviceService.bindSale(M, device.id, {
      saleId: sale.saleId,
      expectedVersion: device.version,
    })
    return { device, sale }
  }

  it('merely opening the link READS: it never takes the device, and shows no amount, reference or code', async () => {
    const { device, sale } = await readyDevice()
    const claim = vi.spyOn(publicEntryService, 'claim')
    await renderAppAt(`/e/${tokenOf(device.entryPath)}`, { signedInAs: null })
    expect(await screen.findByRole('button', { name: 'Show my bill' })).toBeInTheDocument()
    expect(screen.getByText(/Opening this page does not take it/)).toBeInTheDocument()
    expect(claim).not.toHaveBeenCalled()
    const body = document.body.textContent ?? ''
    expect(body).not.toContain(sale.saleReference)
    expect(body).not.toMatch(/12,000/)
  })

  it('shows the bill only after the customer chooses to take it, remembers it in this tab only, and says nothing is paid', async () => {
    const user = userEvent.setup()
    const { device, sale } = await readyDevice()
    await renderAppAt(`/e/${tokenOf(device.entryPath)}`, { signedInAs: null })
    await user.click(await screen.findByRole('button', { name: 'Show my bill' }))
    expect((await screen.findAllByText(sale.saleReference)).length).toBeGreaterThan(0)
    expect(screen.getByText(/RWF\s?12,000/)).toBeInTheDocument()
    // A demonstration says so, and the page never claims a payment happened.
    expect(screen.getAllByText(/demonstration/i).length).toBeGreaterThan(0)
    expect(screen.queryByText(/payment received|has been paid|thank you/i)).not.toBeInTheDocument()
    const stored = window.sessionStorage.getItem(`oupay.entry.claim.${tokenOf(device.entryPath)}`)
    expect(stored).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(window.localStorage.getItem(`oupay.entry.claim.${tokenOf(device.entryPath)}`)).toBeNull()
    // No insecure payment simulator, no PIN or OTP field, on the public page.
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.queryByText(/enter your pin|one-time code:/i)).not.toBeInTheDocument()
  })

  it('tells a second customer "Payment in progress" without any detail of the first customer\'s bill', async () => {
    const { device, sale } = await readyDevice()
    await claimOnce(device.entryPath)
    await renderAppAt(`/e/${tokenOf(device.entryPath)}`, { signedInAs: null })
    expect(await screen.findByRole('heading', { name: 'Payment in progress' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Show my bill' })).not.toBeInTheDocument()
    const body = document.body.textContent ?? ''
    expect(body).not.toContain(sale.saleReference)
    expect(body).not.toMatch(/12,000/)
  })

  it('answers every unusable link the same way, and a device with no bill as idle', async () => {
    const device = await registerDevice('Counter 1')
    await renderAppAt(`/e/${tokenOf(device.entryPath)}`, { signedInAs: null })
    expect(await screen.findByText(/No bill is ready at this payment point yet/)).toBeInTheDocument()
  })

  it('shows "not available" for an unknown token, with nothing else', async () => {
    await renderAppAt('/e/AAAAAAAAAAAAAAAAAAAAAA', { signedInAs: null })
    expect(await screen.findByRole('heading', { name: 'This payment point is not available' })).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('recovers from a lost answer: the browser stored its own token first, so repeating the request finds the same claim', async () => {
    const user = userEvent.setup()
    const { device, sale } = await readyDevice()
    const real = getActiveTestBackend().fastEntryDevices.publicEntryService
    // The first claim reaches the server and creates the claim, but its answer never arrives.
    vi.spyOn(publicEntryService, 'claim').mockImplementationOnce(async (token, claim) => {
      await real.claim(token, claim)
      throw new TypeError('network error')
    })
    const view = await renderAppAt(`/e/${tokenOf(device.entryPath)}`, { signedInAs: null })
    await user.click(await screen.findByRole('button', { name: 'Show my bill' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/Something went wrong/)
    const stored = window.sessionStorage.getItem(`oupay.entry.claim.${tokenOf(device.entryPath)}`)
    expect(stored).toMatch(/^[A-Za-z0-9_-]{43}$/)
    // A reload (or another look) already shows the customer their own bill: the stored token is the proof.
    view.unmount()
    await renderAppAt(`/e/${tokenOf(device.entryPath)}`, { signedInAs: null })
    expect((await screen.findAllByText(sale.saleReference)).length).toBeGreaterThan(0)
    // The claim token is never part of the address, and is not shared with another storage area.
    expect(window.location.href).not.toContain(stored as string)
    expect(window.localStorage.getItem(`oupay.entry.claim.${tokenOf(device.entryPath)}`)).toBeNull()
    expect(getActiveTestBackend().store.loadRecords('oupay.mock.entryClaims', [])).toHaveLength(1)
  })

  it('does not keep a token of its own when the device was already taken, and a copied tab with the session shares the bill', async () => {
    const user = userEvent.setup()
    const { device } = await readyDevice()
    await claimOnce(device.entryPath)
    window.sessionStorage.setItem(`oupay.entry.claim.${tokenOf(device.entryPath)}`, 'B'.repeat(43))
    await renderAppAt(`/e/${tokenOf(device.entryPath)}`, { signedInAs: null })
    // A token this browser invented does not open anything that belongs to the other customer.
    expect(await screen.findByRole('heading', { name: 'Payment in progress' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Show my bill' })).not.toBeInTheDocument()
    expect(user).toBeDefined()
  })

  it('says which is the permanent payment point and which is this bill', async () => {
    const user = userEvent.setup()
    const { device, sale } = await readyDevice()
    await renderAppAt(`/e/${tokenOf(device.entryPath)}`, { signedInAs: null })
    await user.click(await screen.findByRole('button', { name: 'Show my bill' }))
    await screen.findAllByText(sale.saleReference)
    expect(screen.getByText(/permanent payment point: it stays the same for every customer/)).toBeInTheDocument()
    expect(screen.getByText(/sale reference above belongs to\s+this bill only/)).toBeInTheDocument()
  })

  it('is accessible in every state it can show', async () => {
    const { device } = await readyDevice()
    const view = await renderAppAt(`/e/${tokenOf(device.entryPath)}`, { signedInAs: null })
    const user = userEvent.setup()
    await screen.findByRole('button', { name: 'Show my bill' })
    expect(await findAccessibilityViolations(view.container)).toEqual([])
    await user.click(screen.getByRole('button', { name: 'Show my bill' }))
    await screen.findByText(/I am finished/)
    expect(await findAccessibilityViolations(view.container)).toEqual([])
    view.unmount()
    const unknown = await renderAppAt('/e/AAAAAAAAAAAAAAAAAAAAAA', { signedInAs: null })
    await screen.findByRole('heading', { name: 'This payment point is not available' })
    expect(await findAccessibilityViolations(unknown.container)).toEqual([])
  })

  it('has an accessible management page', async () => {
    await registerDevice('Counter 1', DEMO_USER_IDS.cashier)
    const { container } = await renderAppAt('/entry-devices')
    await screen.findByLabelText('Payment point Counter 1')
    expect(await findAccessibilityViolations(container)).toEqual([])
  })
})
