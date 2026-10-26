import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { staffService } from '@/services'
import {
  DEMO_INVITE_EXISTING_USER_TOKEN,
  DEMO_INVITE_NEW_USER_TOKEN,
  DEMO_PASSWORD,
} from '@/services/mock/sampleAccounts'
import { SAMPLE_MERCHANT_ID } from '@/services/mock/sampleMerchants'
import { getActiveTestBackend, useFastBackend } from '@/test/merchantTestDouble'
import { renderAppAt } from '@/test/renderApp'

const heading = (name: string | RegExp) => screen.findByRole('heading', { level: 1, name })
const navLabels = () =>
  within(screen.getAllByRole('navigation', { name: 'Primary' })[0]!)
    .getAllByRole('link')
    .map((link) => link.textContent)

beforeEach(() => {
  useFastBackend()
})

describe('invitation acceptance', () => {
  it('rejects links that do not exist', async () => {
    await renderAppAt('/accept-invitation/demo-nope', { signedInAs: null })
    expect(await heading('This invitation is not valid')).toBeInTheDocument()
  })

  it('lets an existing user sign in and accept, linking the invitation to their account', async () => {
    const user = userEvent.setup()
    await renderAppAt(`/accept-invitation/${DEMO_INVITE_EXISTING_USER_TOKEN}`, { signedInAs: null })
    expect(await heading('Join Sample Shop')).toBeInTheDocument()
    expect(screen.getByText(/as manager/)).toBeInTheDocument()
    expect(screen.getByText(/Demo mode/)).toBeInTheDocument()
    // Creating an account is not offered: this email already has one.
    expect(screen.queryByLabelText(/Full name/)).not.toBeInTheDocument()

    await user.click(screen.getByRole('link', { name: 'Sign in to accept' }))
    await heading('Sign in')
    await user.type(screen.getByLabelText(/Email address/), 'invitee@oupay.demo')
    await user.type(screen.getByLabelText(/^Password/), DEMO_PASSWORD)
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    // Back on the invitation, now signed in as the invited person.
    await user.click(await screen.findByRole('button', { name: 'Accept invitation' }))
    expect(await screen.findByText('You joined Sample Shop.')).toBeInTheDocument()
    expect(await heading('Dashboard')).toBeInTheDocument()
    expect(navLabels()).toContain('Cashiers')

    // The invited user's membership became ACTIVE, with the planned branch assignment.
    const { store } = getActiveTestBackend()
    expect(store.loadMemberships().find((m) => m.id === 'mem-008')?.status).toBe('ACTIVE')
    expect(
      store
        .loadBranchAssignments()
        .some((a) => a.membershipId === 'mem-008' && a.status === 'ACTIVE'),
    ).toBe(true)
  })

  it('lets a brand-new email create an account from the invitation and join', async () => {
    const user = userEvent.setup()
    await renderAppAt(`/accept-invitation/${DEMO_INVITE_NEW_USER_TOKEN}`, { signedInAs: null })
    expect(await heading('Join Sample Shop')).toBeInTheDocument()
    expect(screen.getByLabelText(/Email address/)).toHaveValue('new.hire@example.rw')
    expect(screen.getByLabelText(/Email address/)).toHaveAttribute('readonly')

    await user.click(screen.getByRole('button', { name: 'Create account and join' }))
    expect(await screen.findByText('Enter your full name.')).toBeInTheDocument()
    expect(screen.getByText('You must accept the terms to create an account.')).toBeInTheDocument()

    await user.type(screen.getByLabelText(/Full name/), 'Nadine Uwera')
    await user.type(screen.getByLabelText(/Phone number/), '0788 555 000')
    await user.type(screen.getByLabelText(/^Password/), 'Sunrise2026')
    await user.type(screen.getByLabelText(/Confirm password/), 'Sunrise2026')
    await user.click(screen.getByRole('checkbox', { name: /I agree/ }))
    await user.click(screen.getByRole('button', { name: 'Create account and join' }))

    expect(await heading('Dashboard')).toBeInTheDocument()
    // She joined as a cashier, so she gets the cashier navigation.
    expect(navLabels()).toEqual([
      'Dashboard',
      'Assigned invoices',
      'Payment confirmations',
      'My payment links',
      'Collection codes',
      'Settings',
    ])
    const { store } = getActiveTestBackend()
    const created = store.loadUsers().find((u) => u.email === 'new.hire@example.rw')!
    expect(created).toMatchObject({ status: 'ACTIVE', fullName: 'Nadine Uwera' })
    expect(
      store
        .loadMemberships()
        .find((m) => m.userId === created.id && m.merchantId === SAMPLE_MERCHANT_ID)?.status,
    ).toBe('ACTIVE')
  })

  it('does not let someone accept an invitation meant for another account', async () => {
    const user = userEvent.setup()
    await renderAppAt(`/accept-invitation/${DEMO_INVITE_EXISTING_USER_TOKEN}`, {
      signedInAs: 'cashier',
    })
    expect(await heading('This invitation is for a different account')).toBeInTheDocument()
    expect(screen.getByText(/signed in as cashier@oupay.demo/)).toBeInTheDocument()
    expect(staffService.acceptInvitation).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(await screen.findByRole('link', { name: 'Sign in to accept' })).toBeInTheDocument()
  })

  it('shows a used invitation and a cancelled invitation as such', async () => {
    const { store, fastStaff, signInAs } = getActiveTestBackend()
    signInAs('invitee')
    await fastStaff.acceptInvitation(DEMO_INVITE_EXISTING_USER_TOKEN)
    store.endSession()
    const first = await renderAppAt(`/accept-invitation/${DEMO_INVITE_EXISTING_USER_TOKEN}`, {
      signedInAs: null,
    })
    expect(await heading('Invitation already accepted')).toBeInTheDocument()
    first.unmount()

    signInAs('owner')
    await fastStaff.revokeMembership(SAMPLE_MERCHANT_ID, 'mem-009')
    store.endSession()
    await renderAppAt(`/accept-invitation/${DEMO_INVITE_NEW_USER_TOKEN}`, { signedInAs: null })
    expect(await heading('Invitation cancelled')).toBeInTheDocument()
  })

  it('shows an error and allows retrying when accepting fails', async () => {
    const user = userEvent.setup()
    vi.mocked(staffService.acceptInvitation).mockRejectedValueOnce(new Error('network'))
    getActiveTestBackend().signInAs('invitee')
    await renderAppAt(`/accept-invitation/${DEMO_INVITE_EXISTING_USER_TOKEN}`, { signedInAs: null })
    await user.click(await screen.findByRole('button', { name: 'Accept invitation' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong')
    await user.click(screen.getByRole('button', { name: 'Accept invitation' }))
    expect(await heading('Dashboard')).toBeInTheDocument()
  })

  it('shows a user who only has an invitation a clear message, not the dashboard', async () => {
    await renderAppAt('/', { signedInAs: 'invitee' })
    expect(await heading('No business access right now')).toBeInTheDocument()
    expect(screen.getByText(/you have been invited to a business/)).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.queryByRole('navigation', { name: 'Primary' })).not.toBeInTheDocument(),
    )
  })
})
