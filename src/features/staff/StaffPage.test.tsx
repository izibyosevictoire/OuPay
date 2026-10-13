import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { branchService, staffService } from '@/services'
import { OrganizationServiceError } from '@/services/organizationService'
import { useFastBackend } from '@/test/merchantTestDouble'
import { renderAppAt } from '@/test/renderApp'

type User = ReturnType<typeof userEvent.setup>

const heading = (name: string) => screen.findByRole('heading', { level: 1, name })
const table = () => within(screen.getByRole('table'))
const rowOf = (name: string | RegExp) => table().getByRole('row', { name })
// Cells are: phone, role, status, branches, date, actions (the name is the row header).
const statusOf = (row: HTMLElement) => within(row).getAllByRole('cell')[2]!

async function openStaff(signedInAs: Parameters<typeof renderAppAt>[1] = {}) {
  const result = await renderAppAt('/cashiers', signedInAs)
  await screen.findByRole('table')
  return result
}

async function openRowMenu(user: User, personName: string) {
  await user.click(table().getByRole('button', { name: `Actions for ${personName}` }))
  return screen.findByRole('menu')
}

const menuItems = (menu: HTMLElement) =>
  within(menu)
    .getAllByRole('menuitem')
    .map((item) => item.textContent?.trim())

beforeEach(() => {
  useFastBackend()
})

describe('staff list', () => {
  it('shows name, email, phone, role, status, branches and date', async () => {
    await openStaff()
    expect(await heading('Cashiers & staff')).toBeInTheDocument()
    const aline = rowOf(/Aline Uwase/)
    expect(within(aline).getByText('cashier@oupay.demo')).toBeInTheDocument()
    expect(within(aline).getByText('+250788000003')).toBeInTheDocument()
    expect(within(aline).getByText('Cashier')).toBeInTheDocument()
    expect(within(aline).getByText('Active')).toBeInTheDocument()
    expect(within(aline).getByText('Remera Main, City Centre')).toBeInTheDocument()
    expect(within(aline).getByText('01 Sept 2026')).toBeInTheDocument()
  })

  it('distinguishes invited, suspended and revoked members with text labels', async () => {
    await openStaff()
    expect(statusOf(rowOf(/Olivier Habineza/))).toHaveTextContent('Invited')
    expect(within(rowOf(/Olivier Habineza/)).getByText(/on acceptance/)).toBeInTheDocument()
    expect(within(rowOf(/Eric Niyonzima/)).getByText('Suspended')).toBeInTheDocument()
    expect(within(rowOf(/Diane Ingabire/)).getByText('Revoked')).toBeInTheDocument()
    // A pending invitation for a brand-new email has no name yet, so only the email shows.
    expect(statusOf(rowOf(/new\.hire@example\.rw/))).toHaveTextContent('Invited')
  })

  it('searches and filters by role, status and branch', async () => {
    const user = userEvent.setup()
    await openStaff()
    await user.type(screen.getByRole('searchbox', { name: 'Search staff' }), 'grace')
    expect(table().getAllByRole('row')).toHaveLength(2)
    await user.clear(screen.getByRole('searchbox', { name: 'Search staff' }))

    await user.selectOptions(screen.getByRole('combobox', { name: 'Filter by role' }), 'MANAGER')
    expect(table().getByText('Grace Mukamana')).toBeInTheDocument()
    expect(table().queryByText('Aline Uwase')).not.toBeInTheDocument()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Filter by role' }), 'ALL')

    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Filter by status' }),
      'SUSPENDED',
    )
    expect(table().getAllByRole('row')).toHaveLength(2)
    expect(table().getByText('Eric Niyonzima')).toBeInTheDocument()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Filter by status' }), 'ALL')

    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Filter by branch' }),
      'City Centre',
    )
    expect(table().getByText('Aline Uwase')).toBeInTheDocument()
    expect(table().queryByText('Grace Mukamana')).not.toBeInTheDocument()
  })

  it('explains an empty result and handles loading and errors', async () => {
    const user = userEvent.setup()
    await openStaff()
    await user.type(screen.getByRole('searchbox', { name: 'Search staff' }), 'nobody-here')
    expect(await screen.findByText('No staff match')).toBeInTheDocument()

    vi.mocked(staffService.listStaff).mockImplementation(() => new Promise(() => {}))
    const loading = await renderAppAt('/cashiers')
    expect((await screen.findAllByRole('status'))[0]).toHaveTextContent('Loading')
    loading.unmount()

    vi.mocked(staffService.listStaff).mockRejectedValue(new Error('down'))
    await renderAppAt('/cashiers')
    expect(await screen.findByRole('alert', {}, { timeout: 4000 })).toHaveTextContent(
      'Staff could not be loaded.',
    )
  })

  it('is reachable from the navigation', async () => {
    const user = userEvent.setup()
    await renderAppAt('/')
    await user.click(
      within(screen.getAllByRole('navigation', { name: 'Primary' })[0]!).getByRole('link', {
        name: 'Cashiers',
      }),
    )
    expect(await heading('Cashiers & staff')).toBeInTheDocument()
  })
})

describe('permission-restricted actions', () => {
  it('gives owners the full set of row actions', async () => {
    const user = userEvent.setup()
    await openStaff()
    expect(menuItems(await openRowMenu(user, 'Aline Uwase'))).toEqual([
      'Manage branches',
      'Change role',
      'Suspend',
      'Revoke access',
    ])
  })

  it('hides role changes from managers and limits them to cashiers', async () => {
    const user = userEvent.setup()
    await openStaff({ signedInAs: 'manager' })
    expect(menuItems(await openRowMenu(user, 'Aline Uwase'))).toEqual([
      'Manage branches',
      'Suspend',
      'Revoke access',
    ])
    await user.keyboard('{Escape}')
    // Managers have no actions on themselves, owners or other managers.
    expect(
      table().queryByRole('button', { name: 'Actions for Grace Mukamana' }),
    ).not.toBeInTheDocument()
    expect(
      table().queryByRole('button', { name: 'Actions for Sample Owner' }),
    ).not.toBeInTheDocument()
    // Other managers cannot be managed by a manager either.
    expect(
      table().queryByRole('button', { name: 'Actions for Olivier Habineza' }),
    ).not.toBeInTheDocument()
  })

  it('offers managers only the cashier role when inviting', async () => {
    const user = userEvent.setup()
    await openStaff({ signedInAs: 'manager' })
    await user.click(screen.getByRole('button', { name: 'Invite staff' }))
    const dialog = await screen.findByRole('dialog', { name: 'Invite staff' })
    const options = within(within(dialog).getByLabelText(/^Role/)).getAllByRole('option')
    expect(options.map((o) => o.textContent)).toEqual(['Cashier'])
  })

  it('offers owners manager and cashier roles', async () => {
    const user = userEvent.setup()
    await openStaff()
    await user.click(screen.getByRole('button', { name: 'Invite staff' }))
    const dialog = await screen.findByRole('dialog', { name: 'Invite staff' })
    const options = within(within(dialog).getByLabelText(/^Role/)).getAllByRole('option')
    expect(options.map((o) => o.textContent)).toEqual(['Manager', 'Cashier'])
  })

  it('shows cashiers a 403', async () => {
    await renderAppAt('/cashiers', { signedInAs: 'cashier' })
    expect(await heading('Access denied')).toBeInTheDocument()
  })
})

describe('branch assignments', () => {
  it('changes assignments and updates the list', async () => {
    const user = userEvent.setup()
    await openStaff()
    const menu = await openRowMenu(user, 'Aline Uwase')
    await user.click(within(menu).getByRole('menuitem', { name: 'Manage branches' }))
    const dialog = await screen.findByRole('dialog', { name: 'Manage branches' })
    const group = within(dialog).getByRole('group', { name: 'Assigned branches' })
    expect(within(group).getByRole('checkbox', { name: /Remera Main/ })).toBeChecked()
    await user.click(within(group).getByRole('checkbox', { name: /Remera Main/ }))
    await user.click(within(dialog).getByRole('button', { name: 'Save branches' }))

    expect(await screen.findByText('Branches updated for Aline Uwase.')).toBeInTheDocument()
    await waitFor(() =>
      expect(within(rowOf(/Aline Uwase/)).getByText('City Centre')).toBeInTheDocument(),
    )
    expect(within(rowOf(/Aline Uwase/)).queryByText(/Remera/)).not.toBeInTheDocument()
  })

  it('does not let an inactive branch be newly assigned', async () => {
    const user = userEvent.setup()
    await openStaff()
    const menu = await openRowMenu(user, 'Aline Uwase')
    await user.click(within(menu).getByRole('menuitem', { name: 'Manage branches' }))
    const dialog = await screen.findByRole('dialog', { name: 'Manage branches' })
    const kiosk = within(dialog).getByRole('checkbox', { name: /Nyamirambo Kiosk/ })
    expect(kiosk).toBeDisabled()
    expect(within(dialog).getByText(/cannot be assigned/)).toBeInTheDocument()
  })

  it('shows the service’s validation error and keeps the dialog open', async () => {
    const user = userEvent.setup()
    vi.mocked(branchService.updateBranchAssignments).mockRejectedValueOnce(
      new OrganizationServiceError(
        'branch_inactive',
        'City Centre is inactive and cannot receive new assignments.',
      ),
    )
    await openStaff()
    const menu = await openRowMenu(user, 'Aline Uwase')
    await user.click(within(menu).getByRole('menuitem', { name: 'Manage branches' }))
    const dialog = await screen.findByRole('dialog', { name: 'Manage branches' })
    await user.click(within(dialog).getByRole('button', { name: 'Save branches' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('is inactive')
  })
})

describe('roles and membership lifecycle', () => {
  it('changes a role (owner only)', async () => {
    const user = userEvent.setup()
    await openStaff()
    const menu = await openRowMenu(user, 'Aline Uwase')
    await user.click(within(menu).getByRole('menuitem', { name: 'Change role' }))
    const dialog = await screen.findByRole('dialog', { name: 'Change role' })
    expect(within(dialog).getByRole('button', { name: 'Save role' })).toBeDisabled()
    await user.selectOptions(within(dialog).getByLabelText(/^Role/), 'MANAGER')
    await user.click(within(dialog).getByRole('button', { name: 'Save role' }))
    expect(await screen.findByText('Aline Uwase is now manager.')).toBeInTheDocument()
    await waitFor(() =>
      expect(within(rowOf(/Aline Uwase/)).getByText('Manager')).toBeInTheDocument(),
    )
  })

  it('suspends with confirmation, then reactivates', async () => {
    const user = userEvent.setup()
    await openStaff()
    let menu = await openRowMenu(user, 'Aline Uwase')
    await user.click(within(menu).getByRole('menuitem', { name: 'Suspend' }))
    const dialog = await screen.findByRole('dialog', { name: 'Suspend Aline Uwase?' })
    expect(
      within(dialog).getByText(/lose access to this business straight away/),
    ).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Suspend access' }))
    expect(await screen.findByText('Aline Uwase was suspended.')).toBeInTheDocument()
    await waitFor(() =>
      expect(within(rowOf(/Aline Uwase/)).getByText('Suspended')).toBeInTheDocument(),
    )

    menu = await openRowMenu(user, 'Aline Uwase')
    expect(menuItems(menu)).toEqual(['Change role', 'Reactivate', 'Revoke access'])
    await user.click(within(menu).getByRole('menuitem', { name: 'Reactivate' }))
    await user.click(await screen.findByRole('button', { name: 'Reactivate access' }))
    await waitFor(() =>
      expect(within(rowOf(/Aline Uwase/)).getByText('Active')).toBeInTheDocument(),
    )
  })

  it('warns that revoking is permanent, then only offers a new invitation', async () => {
    const user = userEvent.setup()
    await openStaff()
    const menu = await openRowMenu(user, 'Aline Uwase')
    await user.click(within(menu).getByRole('menuitem', { name: 'Revoke access' }))
    const dialog = await screen.findByRole('dialog', { name: 'Revoke access for Aline Uwase?' })
    expect(within(dialog).getByText(/cannot be undone/)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Revoke access' }))
    expect(await screen.findByText('Access was revoked for Aline Uwase.')).toBeInTheDocument()
    await waitFor(() =>
      expect(within(rowOf(/Aline Uwase/)).getByText('Revoked')).toBeInTheDocument(),
    )
    expect(within(rowOf(/Aline Uwase/)).getByText('No branches')).toBeInTheDocument()

    expect(menuItems(await openRowMenu(user, 'Aline Uwase'))).toEqual(['Send new invitation'])
  })

  it('cancels a pending invitation', async () => {
    const user = userEvent.setup()
    await openStaff()
    const menu = await openRowMenu(user, 'Olivier Habineza')
    expect(menuItems(menu)).toEqual(['Open demo invitation', 'Cancel invitation'])
    await user.click(within(menu).getByRole('menuitem', { name: 'Cancel invitation' }))
    await user.click(await screen.findByRole('button', { name: 'Cancel invitation' }))
    expect(await screen.findByText('The invitation was cancelled.')).toBeInTheDocument()
    await waitFor(() =>
      expect(within(rowOf(/Olivier Habineza/)).getByText('Revoked')).toBeInTheDocument(),
    )
  })

  it('shows the reason, such as the last-owner rule, without closing the dialog', async () => {
    const user = userEvent.setup()
    vi.mocked(staffService.suspendMembership).mockRejectedValueOnce(
      new OrganizationServiceError(
        'last_owner',
        'This is the last active owner. Promote another owner first.',
      ),
    )
    await openStaff()
    const menu = await openRowMenu(user, 'Aline Uwase')
    await user.click(within(menu).getByRole('menuitem', { name: 'Suspend' }))
    await user.click(await screen.findByRole('button', { name: 'Suspend access' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('last active owner')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('invites a previously revoked person again with their email pre-filled', async () => {
    const user = userEvent.setup()
    await openStaff()
    const menu = await openRowMenu(user, 'Diane Ingabire')
    await user.click(within(menu).getByRole('menuitem', { name: 'Send new invitation' }))
    const dialog = await screen.findByRole('dialog', { name: 'Invite staff' })
    expect(within(dialog).getByLabelText(/Email address/)).toHaveValue('revoked@oupay.demo')
    expect(within(dialog).getByLabelText(/^Role/)).toHaveValue('MANAGER')
  })
})

describe('inviting staff', () => {
  it('creates an invitation, shows the demo link, and lists the person as invited', async () => {
    const user = userEvent.setup()
    await openStaff()
    await user.click(screen.getByRole('button', { name: 'Invite staff' }))
    const dialog = await screen.findByRole('dialog', { name: 'Invite staff' })
    await user.type(within(dialog).getByLabelText(/Email address/), 'Nadine@Example.rw')
    await user.selectOptions(within(dialog).getByLabelText(/^Role/), 'CASHIER')
    await user.click(within(dialog).getByRole('checkbox', { name: /Remera Main/ }))
    await user.type(within(dialog).getByLabelText(/Note/), 'See you Monday')
    await user.click(within(dialog).getByRole('button', { name: 'Send invitation' }))

    const created = await screen.findByRole('dialog', { name: 'Invitation created' })
    expect(within(created).getByText(/Demo mode: no email is sent/)).toBeInTheDocument()
    expect(within(created).getByText(/stays invited until they accept/)).toBeInTheDocument()
    expect(
      within(created).getByRole('link', { name: /Open demo invitation for nadine@example.rw/ }),
    ).toHaveAttribute('href', expect.stringMatching(/^\/accept-invitation\/demo-invite-/))
    await user.click(within(created).getByRole('button', { name: 'Done' }))

    const row = await waitFor(() => rowOf(/nadine@example\.rw/))
    expect(statusOf(row)).toHaveTextContent('Invited')
    expect(within(row).getByText(/Remera Main/)).toBeInTheDocument()
    expect(staffService.inviteStaff).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        // The service normalises the address to lower case.
        email: 'Nadine@Example.rw',
        role: 'CASHIER',
        note: 'See you Monday',
      }),
    )
  })

  it('validates the email and reports duplicates on the email field', async () => {
    const user = userEvent.setup()
    await openStaff()
    await user.click(screen.getByRole('button', { name: 'Invite staff' }))
    const dialog = await screen.findByRole('dialog', { name: 'Invite staff' })
    await user.click(within(dialog).getByRole('button', { name: 'Send invitation' }))
    expect(await within(dialog).findByText('Email address is required.')).toBeInTheDocument()
    expect(staffService.inviteStaff).not.toHaveBeenCalled()

    await user.type(within(dialog).getByLabelText(/Email address/), 'cashier@oupay.demo')
    await user.click(within(dialog).getByRole('button', { name: 'Send invitation' }))
    expect(
      await within(dialog).findByText(
        'This person is already a member or has a pending invitation.',
      ),
    ).toBeInTheDocument()
    expect(within(dialog).getByLabelText(/Email address/)).toHaveAttribute('aria-invalid', 'true')
  })

  it('disables inactive branches in the invitation picker', async () => {
    const user = userEvent.setup()
    await openStaff()
    await user.click(screen.getByRole('button', { name: 'Invite staff' }))
    const dialog = await screen.findByRole('dialog', { name: 'Invite staff' })
    expect(await within(dialog).findByRole('checkbox', { name: /Nyamirambo Kiosk/ })).toBeDisabled()
  })
})
