import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { collectionCodeService } from '@/services'
import { SAMPLE_MERCHANT_ID } from '@/services/mock/sampleMerchants'
import { getActiveTestBackend, useFastBackend } from '@/test/merchantTestDouble'
import { renderAppAt } from '@/test/renderApp'

type User = ReturnType<typeof userEvent.setup>

const M = SAMPLE_MERCHANT_ID
const heading = (name: string) => screen.findByRole('heading', { level: 1, name })
const table = () => within(screen.getByRole('table', { name: 'Collection codes' }))
const primaryNav = () => within(screen.getAllByRole('navigation', { name: 'Primary' })[0]!)

async function openPage(signedInAs: Parameters<typeof renderAppAt>[1] = {}) {
  const result = await renderAppAt('/collection-codes', signedInAs)
  await screen.findByRole('table', { name: 'Collection codes' })
  return result
}

/** Opens the details of one code from its row. */
async function openDetails(user: User, label: string) {
  await user.click(table().getByRole('button', { name: `View ${label}` }))
  return screen.findByRole('dialog', { name: 'Collection code' })
}

async function openAction(user: User, details: HTMLElement, button: string, title: string) {
  await user.click(within(details).getByRole('button', { name: button }))
  return screen.findByRole('dialog', { name: title })
}

/** Closes the details window with the keyboard (it also has an icon button named Close). */
async function closeDetails(user: User) {
  await user.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
}

const APPROVE_OR_ACTIVATE = /^(approve|activate|mark .*approved)/i

beforeEach(() => {
  useFastBackend()
})

describe('collection codes: the registry', () => {
  it('lists the business’s codes with plain status labels and tells the identities apart', async () => {
    await openPage()
    expect(await heading('Collection codes')).toBeInTheDocument()
    expect(screen.getByRole('note')).toHaveTextContent(/never creates a bank code/)
    expect(screen.getByRole('note')).toHaveTextContent(
      /not a payment instruction until the bank has provisioned it and it is eligible for collection now/,
    )
    expect(table().getAllByRole('row')).toHaveLength(6) // header + five codes; the cafe’s code is not here
    expect(table().queryByText('Cafe counter')).not.toBeInTheDocument()

    const counter = table().getByRole('row', { name: /Remera counter/ })
    expect(within(counter).getByText('Active')).toBeInTheDocument()
    expect(within(counter).getByText('CC-7KQ2M9XA')).toBeInTheDocument()
    expect(
      within(counter).getByText(/OuPay internal reference, not a payment code/),
    ).toBeInTheDocument()
    expect(within(counter).getByText(/Bank-issued code DEMO-ILLUSTRATIVE-001/)).toBeInTheDocument()
    expect(within(counter).getByText(/· Eligible for collection now/)).toBeInTheDocument()
    expect(within(counter).getByText('Aline Uwase (cashier)')).toBeInTheDocument()

    const declared = table().getByRole('row', { name: /City Centre till/ })
    expect(
      within(declared).getByText('Request declared by owner (not confirmed by Equity)'),
    ).toBeInTheDocument()
    expect(within(declared).getByText(/Equity-issued code: none yet/)).toBeInTheDocument()
    expect(within(declared).getByText(/Not eligible for collection now/)).toBeInTheDocument()
    expect(within(declared).getByText('Nobody yet')).toBeInTheDocument()

    expect(
      within(table().getByRole('row', { name: /Weekend market stall/ })).getByText(
        'Requested (not sent to Equity)',
      ),
    ).toBeInTheDocument()
    expect(
      within(table().getByRole('row', { name: /Old Remera kiosk/ })).getByText('Deactivated'),
    ).toBeInTheDocument()
    const simulated = table().getByRole('row', { name: /Demo stall/ })
    expect(
      within(simulated).getByText(/Bank-issued code SIM-0001 \(simulated\)/),
    ).toBeInTheDocument()
    expect(within(simulated).getByText(/Not eligible for collection now/)).toBeInTheDocument()
  })

  it('is reachable from the navigation and searches and filters', async () => {
    const user = userEvent.setup()
    await renderAppAt('/')
    await user.click(await primaryNav().findByRole('link', { name: 'Collection codes' }))
    expect(await heading('Collection codes')).toBeInTheDocument()
    await screen.findByRole('table', { name: 'Collection codes' })
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Filter by status' }),
      'REQUEST_DECLARED',
    )
    await waitFor(() => expect(table().getAllByRole('row')).toHaveLength(2))
    expect(table().getByText('City Centre till')).toBeInTheDocument()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Filter by status' }), '')
    await user.type(screen.getByRole('searchbox', { name: 'Search collection codes' }), 'zzzz')
    expect(await screen.findByText('No codes match')).toBeInTheDocument()
  })

  it('shows loading, empty and error states', async () => {
    vi.mocked(collectionCodeService.listCodes).mockImplementation(() => new Promise(() => {}))
    const first = await renderAppAt('/collection-codes')
    await waitFor(() => expect(screen.getAllByRole('status').length).toBeGreaterThan(0))
    first.unmount()

    vi.mocked(collectionCodeService.listCodes).mockResolvedValue({ items: [], nextCursor: null })
    const second = await renderAppAt('/collection-codes')
    expect(await screen.findByText('No collection codes yet')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Request a code' }).length).toBeGreaterThan(0)
    second.unmount()

    vi.mocked(collectionCodeService.listCodes).mockRejectedValue(new Error('boom'))
    await renderAppAt('/collection-codes')
    expect(await screen.findByText('The collection codes could not be loaded.')).toBeInTheDocument()
  })

  it('has no control anywhere that approves or activates a code', async () => {
    const user = userEvent.setup()
    await openPage()
    const buttons = () =>
      screen.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent ?? '')
    expect(buttons().filter((name) => APPROVE_OR_ACTIVATE.test(name.trim()))).toEqual([])
    for (const label of [
      'Remera counter',
      'City Centre till',
      'Weekend market stall',
      'Demo stall (simulated)',
    ]) {
      const details = await openDetails(user, label)
      const names = within(details)
        .getAllByRole('button')
        .map((b) => b.textContent ?? '')
      expect(names.filter((name) => APPROVE_OR_ACTIVATE.test(name.trim()))).toEqual([])
      expect(within(details).queryByText(/mark .* approved/i)).not.toBeInTheDocument()
      await closeDetails(user)
    }
  })
})

describe('collection codes: details', () => {
  it('shows an approved, eligible code as four separate facts, with its evidence for the owner', async () => {
    const user = userEvent.setup()
    await openPage()
    const details = await openDetails(user, 'Remera counter')
    expect(
      within(details).getByText('OuPay internal reference, not a payment code'),
    ).toBeInTheDocument()
    expect(within(details).getByText('Bank-issued code')).toBeInTheDocument()
    expect(within(details).getByText('DEMO-ILLUSTRATIVE-001')).toBeInTheDocument()
    expect(within(details).getByText(/Evidence: DEMO-EVIDENCE-0001/)).toBeInTheDocument()
    expect(within(details).getByText(/an authorised operator holding the bank/)).toBeInTheDocument()
    const facts = within(within(details).getByRole('region', { name: 'Collection readiness' }))
    expect(facts.getByText('Provisioned by the bank').nextElementSibling).toHaveTextContent('Yes')
    expect(facts.getByText('Assigned to').nextElementSibling).toHaveTextContent(
      'Aline Uwase (cashier)',
    )
    expect(facts.getByText('Eligible for collection now').nextElementSibling).toHaveTextContent(
      'Yes: it can be given to customers.',
    )
    expect(facts.getByText('Simulated').nextElementSibling).toHaveTextContent('Not simulated')
    expect(
      within(details).getByText('Equity business account (illustrative) ••••0000'),
    ).toBeInTheDocument()
    expect(within(details).getByText('Remera Main (RM01)')).toBeInTheDocument()
    // The history shows both holders, with the earlier one ended.
    const history = within(within(details).getByRole('region', { name: 'Assignment history' }))
    expect(await history.findByText(/Front desk \(collection point\)/)).toBeInTheDocument()
    expect(history.getByText(/Ended by Sample Owner: Moved to a named agent\./)).toBeInTheDocument()
    expect(history.getByText(/Aline Uwase \(cashier\)/)).toBeInTheDocument()
    expect(history.getByText(/\(current\)/)).toBeInTheDocument()
  })

  it('flags a simulated code as never live and never eligible', async () => {
    const user = userEvent.setup()
    await openPage()
    const details = await openDetails(user, 'Demo stall (simulated)')
    const facts = within(within(details).getByRole('region', { name: 'Collection readiness' }))
    expect(facts.getByText('Simulated').nextElementSibling).toHaveTextContent(
      'Simulated: never a live code',
    )
    expect(facts.getByText('Provisioned by the bank').nextElementSibling).toHaveTextContent('No')
    expect(facts.getByText('Eligible for collection now').nextElementSibling).toHaveTextContent(
      'No',
    )
    expect(
      within(details).getByText('It is a simulated code, never a live one.'),
    ).toBeInTheDocument()
    expect(within(details).queryByText(/can be given to customers/)).not.toBeInTheDocument()
  })

  it('shows a declared request without implying that Equity received or accepted anything', async () => {
    const user = userEvent.setup()
    await openPage()
    const details = await openDetails(user, 'City Centre till')
    expect(
      within(details).getAllByText('Request declared by owner (not confirmed by Equity)').length,
    ).toBeGreaterThan(0)
    expect(within(details).getByText('Equity-issued code')).toBeInTheDocument()
    expect(within(details).getByText('None issued yet')).toBeInTheDocument()
    expect(within(details).getByText(/Do not give customers any code yet/)).toBeInTheDocument()
    expect(within(details).getByText('EQ-REQ-DEMO-0002')).toBeInTheDocument()
    expect(
      within(details).getByText(/Owner-declared and unverified\. Equity has not confirmed it\./),
    ).toBeInTheDocument()
    const facts = within(within(details).getByRole('region', { name: 'Collection readiness' }))
    expect(facts.getByText('Provisioned by the bank').nextElementSibling).toHaveTextContent('No')
    expect(facts.getByText('Assigned to').nextElementSibling).toHaveTextContent('Nobody')
    expect(within(details).getByText('The bank has not provisioned it.')).toBeInTheDocument()
    expect(within(details).getByText('Nobody holds it.')).toBeInTheDocument()
    expect(within(details).queryByText(/Bank-issued code$/)).not.toBeInTheDocument()
    expect(within(details).queryByText(/pay (to|using) (this|the) code/i)).not.toBeInTheDocument()
    expect(within(details).queryByText(/can be given to customers/)).not.toBeInTheDocument()
    expect(
      within(details).queryByText(
        /\b(received|reviewing|under review|accepted|processing|awaiting equity)\b/i,
      ),
    ).not.toBeInTheDocument()
  })

  it('says a requested code has not been sent to Equity', async () => {
    const user = userEvent.setup()
    await openPage()
    const details = await openDetails(user, 'Weekend market stall')
    expect(
      within(details).getByText(/Nothing has been sent to Equity, so no code has been issued\./),
    ).toBeInTheDocument()
  })

  it('warns when the holder is no longer active, shows the code as not eligible and leaves the history alone', async () => {
    const user = userEvent.setup()
    const backend = getActiveTestBackend()
    backend.store.saveMemberships(
      backend.store
        .loadMemberships()
        .map((m) => (m.id === 'mem-004' ? { ...m, status: 'SUSPENDED' as const } : m)),
    )
    await openPage()
    expect(table().getByRole('alert')).toHaveTextContent(/Aline Uwase is suspended/)
    expect(
      within(table().getByRole('row', { name: /Remera counter/ })).getByText(
        /Not eligible for collection now/,
      ),
    ).toBeInTheDocument()
    const details = await openDetails(user, 'Remera counter')
    expect(within(details).getAllByRole('alert')[0]).toHaveTextContent(
      /so this code is not eligible for collection\. They still hold it until you remove or replace them/,
    )
    expect(within(details).getByText('The person holding it is not active.')).toBeInTheDocument()
    const facts = within(within(details).getByRole('region', { name: 'Collection readiness' }))
    expect(facts.getByText('Provisioned by the bank').nextElementSibling).toHaveTextContent('Yes')
    expect(facts.getByText('Eligible for collection now').nextElementSibling).toHaveTextContent(
      'No',
    )
    expect(within(details).getAllByText(/Aline Uwase \(cashier\)/).length).toBeGreaterThan(0)
  })
})

describe('collection codes: requesting and lifecycle', () => {
  it('records an internal request and says nothing was sent to Equity', async () => {
    const user = userEvent.setup()
    await openPage()
    await user.click(screen.getAllByRole('button', { name: 'Request a code' })[0]!)
    const dialog = await screen.findByRole('dialog', { name: 'Request a collection code' })
    expect(
      within(dialog).getByText(/does not contact Equity and it does not create a bank code/),
    ).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Record request' }))
    expect(
      await within(dialog).findByText('Enter a label, for example “Remera counter”.'),
    ).toBeInTheDocument()
    await user.type(within(dialog).getByLabelText(/^Label/), 'Airport kiosk')
    await user.selectOptions(within(dialog).getByLabelText(/^Settlement account/), 'dst-sample-001')
    expect(
      within(dialog).getByText(/simulated demo account, so a code on it can never be live/),
    ).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Record request' }))
    expect(
      await screen.findByText('Code request recorded in OuPay. Nothing has been sent to Equity.'),
    ).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    const row = await waitFor(() => table().getByRole('row', { name: /Airport kiosk/ }))
    expect(within(row).getByText('Requested (not sent to Equity)')).toBeInTheDocument()
    expect(within(row).getByText(/Equity-issued code: none yet/)).toBeInTheDocument()
  })

  it('keeps one request identity across a retry of the same submission and a new one after an edit', async () => {
    const user = userEvent.setup()
    const create = vi.mocked(collectionCodeService.requestCode)
    create.mockRejectedValueOnce(new Error('network')).mockRejectedValueOnce(new Error('network'))
    await openPage()
    await user.click(screen.getAllByRole('button', { name: 'Request a code' })[0]!)
    const dialog = await screen.findByRole('dialog', { name: 'Request a collection code' })
    await user.type(within(dialog).getByLabelText(/^Label/), 'Retry kiosk')
    await user.selectOptions(within(dialog).getByLabelText(/^Settlement account/), 'dst-sample-001')
    await user.click(within(dialog).getByRole('button', { name: 'Record request' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/will not be created twice/)
    await user.click(within(dialog).getByRole('button', { name: 'Record request' }))
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2))
    const [first, second] = create.mock.calls.map((call) => call[1].clientRequestId)
    expect(first).toBe(second)
    await user.type(within(dialog).getByLabelText(/^Label/), ' 2')
    await user.click(within(dialog).getByRole('button', { name: 'Record request' }))
    await waitFor(() => expect(create).toHaveBeenCalledTimes(3))
    expect(create.mock.calls[2]![1].clientRequestId).not.toBe(first)
  })

  it('records the owner’s declared bank request, which Equity has not confirmed', async () => {
    const user = userEvent.setup()
    await openPage()
    const details = await openDetails(user, 'Weekend market stall')
    const dialog = await openAction(
      user,
      details,
      'Record a request made to the bank',
      'Record a request made to the bank',
    )
    expect(
      within(dialog).getByText(
        /not verified or confirmed by Equity, and it does not approve the code/,
      ),
    ).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Record my declaration' }))
    expect(
      await within(dialog).findByText('Enter the reference the bank gave you for the request.'),
    ).toBeInTheDocument()
    await user.type(within(dialog).getByLabelText(/^Reference you were given/), 'EQ-CASE-9')
    await user.click(within(dialog).getByRole('button', { name: 'Record my declaration' }))
    expect(
      await screen.findByText('Your declaration was recorded. Equity has not confirmed anything.'),
    ).toBeInTheDocument()
    await waitFor(() =>
      expect(
        within(screen.getByRole('dialog', { name: 'Collection code' })).getByText('EQ-CASE-9'),
      ).toBeInTheDocument(),
    )
    await closeDetails(user)
    expect(
      within(table().getByRole('row', { name: /Weekend market stall/ })).getByText(
        'Request declared by owner (not confirmed by Equity)',
      ),
    ).toBeInTheDocument()
  })

  it('suspends an active code with a reason, and deactivation says it is for good', async () => {
    const user = userEvent.setup()
    await openPage()
    let details = await openDetails(user, 'Remera counter')
    let dialog = await openAction(user, details, 'Suspend', 'Suspend this code')
    await user.click(within(dialog).getByRole('button', { name: 'Suspend code' }))
    expect(
      await within(dialog).findByText('Give a reason. It is kept in the history.'),
    ).toBeInTheDocument()
    await user.type(within(dialog).getByLabelText(/^Reason/), 'Counter audit')
    await user.click(within(dialog).getByRole('button', { name: 'Suspend code' }))
    expect(await screen.findByText('The code was suspended.')).toBeInTheDocument()
    details = screen.getByRole('dialog', { name: 'Collection code' })
    await waitFor(() => expect(within(details).getAllByText('Suspended').length).toBeGreaterThan(0))
    expect(within(details).queryByRole('button', { name: 'Suspend' })).not.toBeInTheDocument()
    expect(within(details).queryByText(/can be given to customers/)).not.toBeInTheDocument()

    dialog = await openAction(user, details, 'Deactivate', 'Deactivate this code')
    expect(
      within(dialog).getByText(/closed for good: it cannot be reassigned or reused/),
    ).toBeInTheDocument()
    await user.type(within(dialog).getByLabelText(/^Reason/), 'Closed')
    await user.click(within(dialog).getByRole('button', { name: 'Deactivate code' }))
    expect(await screen.findByText('The code was deactivated.')).toBeInTheDocument()
    await waitFor(() =>
      expect(
        within(screen.getByRole('dialog', { name: 'Collection code' })).getByText(
          'This code is closed. It cannot be changed or reassigned.',
        ),
      ).toBeInTheDocument(),
    )
  })

  it('tells the person to reload when the code changed under them', async () => {
    const user = userEvent.setup()
    const backend = getActiveTestBackend()
    await openPage()
    const details = await openDetails(user, 'Remera counter')
    // Someone else changes the code after this window loaded it.
    const current = await backend.fastCollectionCodes.getCode(M, 'cc-sample-001')
    await backend.fastCollectionCodes.suspend(M, 'cc-sample-001', {
      expectedVersion: current.version,
      reason: 'Someone else',
    })
    await backend.fastCollectionCodes.deactivate(M, 'cc-sample-002', {
      expectedVersion: 1,
      reason: 'Unrelated',
    })
    const dialog = await openAction(user, details, 'Deactivate', 'Deactivate this code')
    await user.type(within(dialog).getByLabelText(/^Reason/), 'Mine')
    await user.click(within(dialog).getByRole('button', { name: 'Deactivate code' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      /changed by someone else.*Close this window/,
    )
  })
})

describe('collection codes: assigning', () => {
  it('assigns a collection point to a code nobody holds', async () => {
    const user = userEvent.setup()
    await openPage()
    const details = await openDetails(user, 'Weekend market stall')
    const dialog = await openAction(user, details, 'Assign', 'Assign this code')
    await user.selectOptions(within(dialog).getByLabelText(/^Give it to/), 'COLLECTION_POINT')
    await user.click(within(dialog).getByRole('button', { name: 'Assign code' }))
    expect(await within(dialog).findByText(/Enter the collection point/)).toBeInTheDocument()
    await user.type(within(dialog).getByLabelText(/^Collection point/), 'Market stall')
    await user.click(within(dialog).getByRole('button', { name: 'Assign code' }))
    expect(await screen.findByText('The code was assigned.')).toBeInTheDocument()
    await waitFor(() =>
      expect(
        within(screen.getByRole('dialog', { name: 'Collection code' })).getAllByText(
          /Market stall \(collection point\)/,
        ).length,
      ).toBeGreaterThan(0),
    )
  })

  it('assigns a team member, offering only people who can hold the code', async () => {
    const user = userEvent.setup()
    await openPage()
    const details = await openDetails(user, 'City Centre till')
    const dialog = await openAction(user, details, 'Assign', 'Assign this code')
    await user.click(within(dialog).getByRole('button', { name: 'Assign code' }))
    expect(await within(dialog).findByText('Choose a team member.')).toBeInTheDocument()
    const select = within(dialog).getByLabelText(/^Team member/)
    const names = within(select)
      .getAllByRole('option')
      .map((o) => o.textContent)
    // Only people assigned to City Centre; not Grace (Remera only), the suspended or the invited.
    expect(names).toEqual(['Choose…', 'Aline Uwase (cashier)'])
    await user.selectOptions(select, 'mem-004')
    await user.click(within(dialog).getByRole('button', { name: 'Assign code' }))
    expect(await screen.findByText('The code was assigned.')).toBeInTheDocument()
    await closeDetails(user)
    await waitFor(() =>
      expect(
        within(table().getByRole('row', { name: /City Centre till/ })).getByText(
          'Aline Uwase (cashier)',
        ),
      ).toBeInTheDocument(),
    )
  })

  it('reassigns with a required reason and keeps the previous holder in the history', async () => {
    const user = userEvent.setup()
    await openPage()
    const details = await openDetails(user, 'Remera counter')
    const dialog = await openAction(user, details, 'Reassign', 'Reassign this code')
    await user.selectOptions(within(dialog).getByLabelText(/^Give it to/), 'COLLECTION_POINT')
    await user.type(within(dialog).getByLabelText(/^Collection point/), 'Counter 2')
    await user.click(within(dialog).getByRole('button', { name: 'Reassign code' }))
    expect(
      await within(dialog).findByText('Give a reason for replacing the current agent.'),
    ).toBeInTheDocument()
    await user.type(within(dialog).getByLabelText(/^Reason/), 'Rota change')
    await user.click(within(dialog).getByRole('button', { name: 'Reassign code' }))
    expect(
      await screen.findByText(
        /The code was reassigned\. The previous assignment is kept in the history\./,
      ),
    ).toBeInTheDocument()
    const history = () =>
      within(
        within(screen.getByRole('dialog', { name: 'Collection code' })).getByRole('region', {
          name: 'Assignment history',
        }),
      )
    expect(await history().findByText(/Counter 2 \(collection point\)/)).toBeInTheDocument()
    expect(history().getByText(/Ended by Sample Owner: Rota change/)).toBeInTheDocument()
    expect(history().getByText(/Aline Uwase \(cashier\)/)).toBeInTheDocument()
  })

  it('removes the current agent with a reason', async () => {
    const user = userEvent.setup()
    await openPage()
    const details = await openDetails(user, 'Demo stall (simulated)')
    const dialog = await openAction(user, details, 'Remove agent', 'Remove the current agent')
    await user.type(within(dialog).getByLabelText(/^Reason/), 'Stall closed')
    await user.click(within(dialog).getByRole('button', { name: 'Remove agent' }))
    expect(await screen.findByText('The assignment was ended.')).toBeInTheDocument()
    await waitFor(() =>
      expect(
        within(screen.getByRole('dialog', { name: 'Collection code' })).getByText(
          /Ended by Sample Owner: Stall closed/,
        ),
      ).toBeInTheDocument(),
    )
    expect(
      within(screen.getByRole('dialog', { name: 'Collection code' })).getByRole('button', {
        name: 'Assign',
      }),
    ).toBeInTheDocument()
  })

  it('shows the server’s refusal when someone is not eligible', async () => {
    const user = userEvent.setup()
    vi.mocked(collectionCodeService.assign).mockRejectedValueOnce(
      Object.assign(new Error('Only an active member of this business can hold a code.'), {
        name: 'CollectionCodeServiceError',
      }),
    )
    await openPage()
    const details = await openDetails(user, 'Weekend market stall')
    const dialog = await openAction(user, details, 'Assign', 'Assign this code')
    await user.selectOptions(within(dialog).getByLabelText(/^Team member/), 'mem-004')
    await user.click(within(dialog).getByRole('button', { name: 'Assign code' }))
    expect(await within(dialog).findByRole('alert')).toBeInTheDocument()
  })
})

describe('collection codes: who sees what', () => {
  it('lets a manager see the registry but not request, suspend or deactivate, and act only on branch codes', async () => {
    const user = userEvent.setup()
    await openPage({ signedInAs: 'manager' })
    expect(screen.queryByRole('button', { name: 'Request a code' })).not.toBeInTheDocument()

    let details = await openDetails(user, 'Remera counter')
    expect(within(details).getByRole('button', { name: 'Reassign' })).toBeInTheDocument()
    expect(within(details).getByRole('button', { name: 'Remove agent' })).toBeInTheDocument()
    expect(within(details).queryByRole('button', { name: 'Suspend' })).not.toBeInTheDocument()
    expect(within(details).queryByRole('button', { name: 'Deactivate' })).not.toBeInTheDocument()
    await closeDetails(user)

    // A code with no branch is the owner’s to hand out.
    details = await openDetails(user, 'Weekend market stall')
    expect(within(details).queryByRole('button', { name: 'Assign' })).not.toBeInTheDocument()
    expect(
      within(details).queryByRole('button', { name: 'Record a request made to the bank' }),
    ).not.toBeInTheDocument()
    expect(within(details).getByRole('note')).toHaveTextContent(/Owners provision codes/)
  })

  it('gives the owner the provisioning controls', async () => {
    const user = userEvent.setup()
    await openPage()
    expect(screen.getAllByRole('button', { name: 'Request a code' }).length).toBeGreaterThan(0)
    const details = await openDetails(user, 'Remera counter')
    for (const name of ['Reassign', 'Remove agent', 'Suspend', 'Deactivate']) {
      expect(within(details).getByRole('button', { name })).toBeInTheDocument()
    }
  })

  it('shows a cashier only their own code, with the code value only because it is eligible', async () => {
    await renderAppAt('/collection-codes', { signedInAs: 'cashier' })
    expect(await heading('My collection code')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    const card = await screen.findByLabelText('Your collection code')
    expect(within(card).getByText('Remera counter')).toBeInTheDocument()
    expect(within(card).getByText('DEMO-ILLUSTRATIVE-001')).toBeInTheDocument()
    expect(within(card).getByText('Active')).toBeInTheDocument()
    expect(
      within(card).getByText(/provisioned by the bank and eligible for collection now/),
    ).toBeInTheDocument()
    expect(screen.queryByText('Weekend market stall')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /request|assign|suspend|deactivate/i }),
    ).not.toBeInTheDocument()
    expect(primaryNav().getByRole('link', { name: 'Collection codes' })).toBeInTheDocument()
  })

  it('shows a cashier no code value once their code is not eligible', async () => {
    const backend = getActiveTestBackend()
    backend.signInAs('owner')
    const code = await backend.fastCollectionCodes.getCode(M, 'cc-sample-001')
    await backend.fastCollectionCodes.suspend(M, 'cc-sample-001', {
      expectedVersion: code.version,
      reason: 'Check',
    })
    await renderAppAt('/collection-codes', { signedInAs: 'cashier' })
    const card = await screen.findByLabelText('Your collection code')
    expect(within(card).queryByText('DEMO-ILLUSTRATIVE-001')).not.toBeInTheDocument()
    expect(within(card).getByText('No code to give customers right now.')).toBeInTheDocument()
    expect(within(card).getByText('Suspended')).toBeInTheDocument()
    expect(within(card).getByText(/Do not give it to customers/)).toBeInTheDocument()
  })

  it('tells a cashier with no code that nothing is assigned', async () => {
    const backend = getActiveTestBackend()
    backend.signInAs('owner')
    const open = (await backend.fastCollectionCodes.getCode(M, 'cc-sample-001')).currentAssignment!
    await backend.fastCollectionCodes.endAssignment(M, 'cc-sample-001', {
      expectedAssignmentId: open.id,
      reason: 'Moved',
    })
    await renderAppAt('/collection-codes', { signedInAs: 'cashier' })
    expect(await screen.findByText('No collection code is assigned to you')).toBeInTheDocument()
  })

  it('shows each business only its own registry and works in both operating modes', async () => {
    await renderAppAt('/collection-codes', { signedInAs: 'cafeOwner' })
    await screen.findByRole('table', { name: 'Collection codes' })
    expect(table().getByText('Cafe counter')).toBeInTheDocument()
    expect(table().queryByText('Remera counter')).not.toBeInTheDocument()
  })

  it('tells a manager that evidence exists without showing it, and never shows a declared reference', async () => {
    const user = userEvent.setup()
    await openPage({ signedInAs: 'manager' })
    let details = await openDetails(user, 'Remera counter')
    expect(
      within(details).getByText(/Evidence recorded; visible to owners only\./),
    ).toBeInTheDocument()
    expect(within(details).queryByText(/DEMO-EVIDENCE-0001/)).not.toBeInTheDocument()
    await closeDetails(user)
    details = await openDetails(user, 'City Centre till')
    expect(
      within(details).getByText(/Unverified\. The reference is visible to owners only\./),
    ).toBeInTheDocument()
    expect(within(details).queryByText(/EQ-REQ-DEMO-0002/)).not.toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/DEMO-EVIDENCE|EQ-REQ-DEMO/)
  })

  it('shows the evidence and the declared reference to the owner only', async () => {
    const user = userEvent.setup()
    await openPage()
    const approved = await openDetails(user, 'Remera counter')
    expect(within(approved).getByText(/Evidence: DEMO-EVIDENCE-0001/)).toBeInTheDocument()
    await closeDetails(user)
    const declared = await openDetails(user, 'City Centre till')
    expect(within(declared).getByText('EQ-REQ-DEMO-0002')).toBeInTheDocument()
  })

  it('labels the internal reference as not a payment code wherever it appears, and shows only masked accounts', async () => {
    const user = userEvent.setup()
    await openPage()
    expect(table().getAllByText(/OuPay internal reference, not a payment code/).length).toBe(5)
    expect(table().queryByText(/OuPay reference \(internal\)/)).not.toBeInTheDocument()
    const details = await openDetails(user, 'Remera counter')
    expect(
      within(details).getByText('OuPay internal reference, not a payment code'),
    ).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/acct-|bankAccountId|providerAccountId/)
    expect(document.body.textContent).toMatch(/••••0000/)
  })

  it('never says Equity is awaited, reviewing or has received anything', async () => {
    const user = userEvent.setup()
    await openPage()
    const claim =
      /(awaiting equity|equity (is|has) (reviewing|received|accepted)|under review|sent to equity successfully)/i
    expect(document.body.textContent).not.toMatch(claim)
    for (const label of ['City Centre till', 'Weekend market stall']) {
      await openDetails(user, label)
      expect(document.body.textContent).not.toMatch(claim)
      await closeDetails(user)
    }
  })

  it('is available to a simplified business too', async () => {
    const backend = getActiveTestBackend()
    backend.signInAs('owner')
    await backend.fastMerchants.updateMerchantSettings(M, {
      operatingMode: 'SIMPLIFIED',
      expectedVersion: 0,
    })
    await renderAppAt('/collection-codes')
    await screen.findByRole('table', { name: 'Collection codes' })
    expect(primaryNav().getByRole('link', { name: 'Collection codes' })).toBeInTheDocument()
  })
})
