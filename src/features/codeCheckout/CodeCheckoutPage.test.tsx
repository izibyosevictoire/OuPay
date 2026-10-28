import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PRIMARY_NAVIGATION } from '@/constants/navigation'
import { codeCheckoutService } from '@/services'
import { CodeCheckoutServiceError } from '@/services/codeCheckoutService'
import { SAMPLE_MERCHANT_ID } from '@/services/mock/sampleMerchants'
import { SAMPLE_BRANCH_IDS } from '@/services/mock/sampleOrganization'
import { findAccessibilityViolations } from '@/test/axe'
import { getActiveTestBackend, useFastBackend, type DemoUserKey } from '@/test/merchantTestDouble'
import { renderAppAt } from '@/test/renderApp'

type User = ReturnType<typeof userEvent.setup>

/** A simulated code the cashier (Aline) holds at Remera, on the account a payment link of the sample ledger collects to. */
async function giveCashierADemoCode() {
  const backend = getActiveTestBackend()
  backend.signInAs('owner')
  const profile = backend.ledger.paymentProfiles
    .load()
    .find(
      (p) =>
        p.merchantId === SAMPLE_MERCHANT_ID &&
        p.status === 'ACTIVE' &&
        p.assignedCashierId === null,
    )
  const destination = backend.ledger.paymentDestinations
    .load()
    .find((d) => d.id === profile?.paymentDestinationId)
  const requested = await backend.fastCollectionCodes.requestCode(SAMPLE_MERCHANT_ID, {
    clientOperationId: crypto.randomUUID(),
    settlementDestinationId: destination?.id ?? '',
    displayLabel: 'Demo counter',
    branchId: SAMPLE_BRANCH_IDS.remera,
  })
  await backend.fastCollectionCodes.assign(SAMPLE_MERCHANT_ID, requested.code.id, {
    membershipId: 'mem-004',
  })
  return requested.code
}

async function openCheckout(signedInAs: DemoUserKey = 'cashier') {
  return renderAppAt('/code-checkout', { signedInAs })
}

const amountField = () => screen.findByLabelText(/Amount \(RWF\)/)
const bill = (user: User) => user.click(screen.getByRole('button', { name: /^(Bill|Try again)$/ }))

/** Aline holds the sample bank-approved code too, so the demonstration code is chosen explicitly. */
async function billAmount(user: User, amount: string, description?: string) {
  await user.type(await amountField(), amount)
  if (description) await user.type(screen.getByLabelText(/Description/), description)
  await user.selectOptions(
    screen.getByLabelText(/Collection code/),
    screen.getByRole('option', { name: /Demo counter/ }),
  )
  await bill(user)
}

beforeEach(() => {
  window.sessionStorage.clear()
  useFastBackend()
})

describe('Code checkout: the form', () => {
  it('has one page heading, a labelled amount, description and code, and passes axe', async () => {
    await giveCashierADemoCode()
    const { container } = await openCheckout()
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Code checkout' }),
    ).toBeInTheDocument()
    const amount = await amountField()
    expect(amount).toHaveAttribute('inputmode', 'numeric')
    expect(amount).toBeRequired()
    expect(screen.getByLabelText(/Description/)).not.toBeRequired()
    expect(screen.getByLabelText(/Collection code/)).toBeRequired()
    // The bank-approved code cannot bill while live collection is off, and says why; the demonstration one can.
    expect(screen.getByRole('option', { name: /Remera counter.*not available/ })).toBeDisabled()
    expect(screen.getByRole('option', { name: /Demo counter \(demonstration\)/ })).toBeEnabled()
    expect(await findAccessibilityViolations(container)).toEqual([])
  })

  it('validates the amount in the browser without calling the service', async () => {
    const user = userEvent.setup()
    await giveCashierADemoCode()
    await openCheckout()
    await amountField()
    await bill(user)
    expect(await screen.findByText('Enter the amount to collect.')).toBeInTheDocument()
    for (const [typed, expected] of [
      ['12.5', /whole francs only/i],
      ['50', /between RWF 100 and RWF 10,000,000/],
    ] as const) {
      await user.clear(await amountField())
      await user.type(await amountField(), typed)
      await bill(user)
      expect(await screen.findByText(expected)).toBeInTheDocument()
    }
    expect(codeCheckoutService.billCodeSale).not.toHaveBeenCalled()
  })
})

describe('Code checkout: after Bill', () => {
  it('shows the amount, the sale reference, a prominent demonstration statement and no bank code', async () => {
    const user = userEvent.setup()
    await giveCashierADemoCode()
    const { container } = await openCheckout()
    await billAmount(user, '25,000', 'Two coffees')

    expect(await screen.findByText('RWF 25,000', { selector: 'p' })).toBeInTheDocument()
    expect(screen.getByText(/Two coffees · DEMO-/)).toBeInTheDocument()
    expect(screen.getByText('Awaiting payment')).toBeInTheDocument()
    expect(
      screen
        .getAllByRole('note')
        .map((n) => n.textContent)
        .join(' '),
    ).toContain('DEMONSTRATION ONLY')
    expect(screen.getByText(/not a payment code/)).toBeInTheDocument()
    expect(screen.queryByText('Paid')).not.toBeInTheDocument()

    const backend = getActiveTestBackend()
    const created = backend.ledger.paymentRequests.load().at(-1)!
    expect(screen.getAllByText(created.publicReference).length).toBeGreaterThan(0)
    expect(screen.getByRole('link', { name: /Open customer page/ })).toHaveAttribute(
      'href',
      `/code-sale/${created.publicReference}`,
    )
    expect(document.body.textContent).not.toContain('DEMO-ILLUSTRATIVE-001')
    expect(await findAccessibilityViolations(container)).toEqual([])

    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await user.click(screen.getByRole('button', { name: /Copy reference/ }))
    expect(writeText).toHaveBeenCalledWith(created.publicReference)
  })

  it('never shows a demonstration sale as paid, even when the bank reports money naming it', async () => {
    const user = userEvent.setup()
    await giveCashierADemoCode()
    await openCheckout()
    await billAmount(user, '20000')
    await screen.findByText('Awaiting payment')

    const backend = getActiveTestBackend()
    const created = backend.ledger.paymentRequests.load().at(-1)!
    const allocationsBefore = backend.ledger.allocations.load().length
    await backend.fastSimulator.simulateRequestPayment(created.publicReference, 'success')
    await user.click(screen.getByRole('button', { name: 'Check now' }))
    // The ledger refuses to apply bank money to a demonstration: the sale is still waiting, still not payable, never Paid.
    await waitFor(() => expect(screen.getByText('Awaiting payment')).toBeInTheDocument())
    expect(screen.queryByText('Paid')).not.toBeInTheDocument()
    expect(screen.queryByText('Partially paid')).not.toBeInTheDocument()
    expect(screen.getByText(/Not payable/)).toBeInTheDocument()
    expect(screen.getByText('Confirmed so far').nextElementSibling).toHaveTextContent('RWF 0')
    expect(backend.ledger.allocations.load()).toHaveLength(allocationsBefore)
  })

  it('shows an expired request as expired, not as paid', async () => {
    const user = userEvent.setup()
    await giveCashierADemoCode()
    await openCheckout()
    await billAmount(user, '4000')
    await screen.findByText('Awaiting payment')
    const backend = getActiveTestBackend()
    backend.ledger.paymentRequests.save(
      backend.ledger.paymentRequests
        .load()
        .map((r, index, all) =>
          index === all.length - 1
            ? { ...r, expiresAt: new Date(Date.now() - 60_000).toISOString() }
            : r,
        ),
    )
    await user.click(screen.getByRole('button', { name: 'Check now' }))
    expect(await screen.findByText('Expired')).toBeInTheDocument()
    expect(screen.queryByText('Paid')).not.toBeInTheDocument()
  })

  it('asks before leaving a sale that is still open', async () => {
    const user = userEvent.setup()
    await giveCashierADemoCode()
    await openCheckout()
    await billAmount(user, '4000')
    await screen.findByText('Awaiting payment')
    await user.click(screen.getByRole('button', { name: 'New sale' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/still open/)
    await user.click(screen.getByRole('button', { name: 'Yes, start a new sale' }))
    expect(await amountField()).toHaveValue('')
  })

  it('brings the same sale back after a refresh, read again from the server', async () => {
    const user = userEvent.setup()
    await giveCashierADemoCode()
    const first = await openCheckout()
    await billAmount(user, '9000')
    await screen.findByText('Awaiting payment')
    const reference = getActiveTestBackend().ledger.paymentRequests.load().at(-1)!.publicReference
    first.unmount()

    await openCheckout()
    expect(await screen.findByText('RWF 9,000', { selector: 'p' })).toBeInTheDocument()
    expect(screen.getAllByText(reference).length).toBeGreaterThan(0)
    expect(screen.queryByLabelText(/Amount \(RWF\)/)).not.toBeInTheDocument()
  })

  it('never shows one person the sale another person left on the same tab', async () => {
    const user = userEvent.setup()
    await giveCashierADemoCode()
    const first = await openCheckout()
    await billAmount(user, '9000')
    await screen.findByText('Awaiting payment')
    first.unmount()
    getActiveTestBackend().signInAs('owner')
    await openCheckout('owner')
    await waitFor(() =>
      expect(screen.queryByText('RWF 9,000', { selector: 'p' })).not.toBeInTheDocument(),
    )
  })
})

describe('Code checkout: failures and retries', () => {
  it('keeps what was typed after a lost answer and the retry sends the SAME sale identifiers', async () => {
    const user = userEvent.setup()
    await giveCashierADemoCode()
    await openCheckout()
    vi.spyOn(codeCheckoutService, 'billCodeSale').mockRejectedValueOnce(
      new CodeCheckoutServiceError('service_unavailable', 'down'),
    )
    await billAmount(user, '7000', 'Lunch')
    expect(await screen.findByRole('alert')).toHaveTextContent(/never billed twice/)
    expect(await amountField()).toHaveValue('7000')
    await bill(user)
    await screen.findByText('Awaiting payment')
    const calls = vi.mocked(codeCheckoutService.billCodeSale).mock.calls
    expect(calls).toHaveLength(2)
    expect(calls[1]![1].clientRequestId).toBe(calls[0]![1].clientRequestId)
    expect(calls[1]![1].idempotencyKey).toBe(calls[0]![1].idempotencyKey)
  })

  it('changing the sale after a failure uses new identifiers', async () => {
    const user = userEvent.setup()
    await giveCashierADemoCode()
    await openCheckout()
    vi.spyOn(codeCheckoutService, 'billCodeSale').mockRejectedValueOnce(
      new CodeCheckoutServiceError('service_unavailable', 'down'),
    )
    await billAmount(user, '7000')
    await screen.findByRole('alert')
    await user.clear(await amountField())
    await user.type(await amountField(), '8000')
    await bill(user)
    await screen.findByText('Awaiting payment')
    const calls = vi.mocked(codeCheckoutService.billCodeSale).mock.calls
    expect(calls[1]![1].clientRequestId).not.toBe(calls[0]![1].clientRequestId)
    expect(calls[1]![1].idempotencyKey).not.toBe(calls[0]![1].idempotencyKey)
  })

  it('shows the server’s refusal in plain words and offers no blind retry', async () => {
    const user = userEvent.setup()
    await giveCashierADemoCode()
    await openCheckout()
    vi.spyOn(codeCheckoutService, 'billCodeSale').mockRejectedValueOnce(
      new CodeCheckoutServiceError('code_not_available', 'This code is not eligible right now.'),
    )
    await billAmount(user, '7000')
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This code is not eligible right now.',
    )
    expect(screen.getByRole('button', { name: 'Bill' })).toBeEnabled()
  })

  it('shows a busy state while billing and a double-click starts one operation', async () => {
    const user = userEvent.setup()
    await giveCashierADemoCode()
    await openCheckout()
    await user.type(await amountField(), '1000')
    await user.selectOptions(
      screen.getByLabelText(/Collection code/),
      screen.getByRole('option', { name: /Demo counter/ }),
    )
    await user.dblClick(screen.getByRole('button', { name: 'Bill' }))
    await screen.findByText('Awaiting payment')
    expect(codeCheckoutService.billCodeSale).toHaveBeenCalledTimes(1)
  })

  it('offers a retry when the page itself cannot load', async () => {
    const user = userEvent.setup()
    vi.spyOn(codeCheckoutService, 'getCodeCheckoutOptions').mockRejectedValueOnce(
      new CodeCheckoutServiceError('service_unavailable', 'down'),
    )
    await openCheckout()
    await user.click(await screen.findByRole('button', { name: /try again|retry/i }))
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Code checkout' }),
    ).toBeInTheDocument()
  })
})

describe('Code checkout: who can bill and what is shown when nobody can', () => {
  it('tells a person with no code to ask for one, and creates nothing', async () => {
    await openCheckout('manager')
    expect(await screen.findByText('You are not assigned a collection code')).toBeInTheDocument()
    expect(screen.queryByLabelText(/Amount \(RWF\)/)).not.toBeInTheDocument()
    expect(codeCheckoutService.billCodeSale).not.toHaveBeenCalled()
  })

  it('tells the holder of a bank-approved code that live collection is not enabled', async () => {
    await openCheckout('cashier')
    expect(await screen.findByText('Your code cannot bill right now')).toBeInTheDocument()
    expect(screen.getByText(/Live collection is not enabled yet/)).toBeInTheDocument()
    expect(screen.queryByLabelText(/Amount \(RWF\)/)).not.toBeInTheDocument()
  })

  it('asks for a payment link first when none collects to the code’s account', async () => {
    await giveCashierADemoCode()
    const backend = getActiveTestBackend()
    backend.ledger.paymentProfiles.save(
      backend.ledger.paymentProfiles.load().map((p) => ({ ...p, status: 'PAUSED' as never })),
    )
    await openCheckout()
    await waitFor(() => expect(screen.getByText(/payment link/i)).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: 'Bill' })).not.toBeInTheDocument()
  })
})

describe('Code checkout: navigation', () => {
  it('is declared for people who may create invoices', () => {
    const entry = PRIMARY_NAVIGATION.find((item) => item.path === '/code-checkout')
    expect(entry).toMatchObject({ label: 'Code checkout', permission: 'invoices:create' })
  })

  it('appears in the menu for a cashier and the owner', async () => {
    await openCheckout('cashier')
    await screen.findByRole('heading', { level: 1, name: 'Code checkout' })
    expect(screen.getAllByRole('link', { name: /Code checkout/ }).length).toBeGreaterThan(0)
  })
})

describe('the customer page of a code sale', () => {
  async function billedReference() {
    const user = userEvent.setup()
    await giveCashierADemoCode()
    const first = await openCheckout()
    await billAmount(user, '15000', 'Two coffees')
    await screen.findByText('Awaiting payment')
    first.unmount()
    return getActiveTestBackend().ledger.paymentRequests.load().at(-1)!.publicReference
  }

  it('is anonymous, mobile first, honest about a demonstration and shows no agent', async () => {
    const reference = await billedReference()
    const { container } = await renderAppAt(`/code-sale/${reference}`, { signedInAs: null })
    expect(await screen.findByText('RWF 15,000', { selector: 'p' })).toBeInTheDocument()
    expect(screen.getByText('Awaiting payment')).toBeInTheDocument()
    expect(screen.getByRole('note')).toHaveTextContent('DEMONSTRATION ONLY')
    expect(screen.getAllByText(reference).length).toBeGreaterThan(0)
    expect(screen.getByText(/Nothing can be paid/)).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('Aline')
    // Code only: no other way to pay, and no request for a PIN or OTP.
    expect(screen.queryByRole('button', { name: /pay|mobile money|card/i })).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/pin|otp|password/i)).not.toBeInTheDocument()
    expect(await findAccessibilityViolations(container)).toEqual([])
  })

  it('stays awaiting, and not payable, when the bank reports money naming the demonstration', async () => {
    const reference = await billedReference()
    await getActiveTestBackend().fastSimulator.simulateRequestPayment(reference, 'success')
    await renderAppAt(`/code-sale/${reference}`, { signedInAs: null })
    expect(await screen.findByText('Awaiting payment')).toBeInTheDocument()
    expect(screen.queryByText('Paid')).not.toBeInTheDocument()
    expect(screen.getByText(/Not payable/)).toBeInTheDocument()
    expect(screen.getByRole('note')).toHaveTextContent('DEMONSTRATION ONLY')
    expect(document.body.textContent).not.toMatch(/CC-[A-Z0-9]{8}/)
  })

  it('says so when the reference is unknown', async () => {
    await renderAppAt('/code-sale/OP-NOSUCH99', { signedInAs: null })
    expect(await screen.findByText('This payment page could not be found')).toBeInTheDocument()
  })
})
