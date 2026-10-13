import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { branchService } from '@/services'
import { OrganizationServiceError } from '@/services/organizationService'
import { SAMPLE_BRANCH_IDS } from '@/services/mock/sampleOrganization'
import { useFastBackend } from '@/test/merchantTestDouble'
import { renderAppAt } from '@/test/renderApp'

type User = ReturnType<typeof userEvent.setup>

const heading = (name: string) => screen.findByRole('heading', { level: 1, name })
const table = () => within(screen.getByRole('table'))

async function openBranches(signedInAs: Parameters<typeof renderAppAt>[1] = {}) {
  const result = await renderAppAt('/branches', signedInAs)
  await screen.findByRole('table')
  return result
}

async function openRowMenu(user: User, branchName: string) {
  await user.click(table().getByRole('button', { name: `Actions for ${branchName}` }))
  return screen.findByRole('menu')
}

async function fillBranchForm(user: User, overrides: { name?: string; code?: string } = {}) {
  const dialog = await screen.findByRole('dialog')
  await user.type(
    within(dialog).getByLabelText(/Branch name/),
    overrides.name ?? 'Kimironko Market',
  )
  await user.type(within(dialog).getByLabelText(/Branch code/), overrides.code ?? 'kim1')
  await user.selectOptions(within(dialog).getByLabelText(/^Province/), 'Kigali City')
  await user.selectOptions(within(dialog).getByLabelText(/^District/), 'Gasabo')
  await user.selectOptions(within(dialog).getByLabelText(/^Sector/), 'Kimironko')
  await user.type(within(dialog).getByLabelText(/Physical address/), 'Market stall 4')
  return dialog
}

beforeEach(() => {
  useFastBackend()
})

describe('branch list', () => {
  it('shows name, code, location, status, staff count and creation date', async () => {
    await openBranches()
    expect(await heading('Branches')).toBeInTheDocument()
    const remera = table().getByRole('row', { name: /Remera Main/ })
    expect(within(remera).getByText('RM01')).toBeInTheDocument()
    expect(within(remera).getByText('Gasabo, Remera')).toBeInTheDocument()
    expect(within(remera).getByText('Active')).toBeInTheDocument()
    expect(within(remera).getByText('2')).toBeInTheDocument()
    expect(within(remera).getByText('02 Sept 2026')).toBeInTheDocument()
    const kiosk = table().getByRole('row', { name: /Nyamirambo Kiosk/ })
    expect(within(kiosk).getByText('Inactive')).toBeInTheDocument()
  })

  it('is reachable from the navigation', async () => {
    const user = userEvent.setup()
    await renderAppAt('/')
    await user.click(
      within(screen.getAllByRole('navigation', { name: 'Primary' })[0]!).getByRole('link', {
        name: 'Branches',
      }),
    )
    expect(await heading('Branches')).toBeInTheDocument()
  })

  it('searches by name, code and location, and filters by status', async () => {
    const user = userEvent.setup()
    await openBranches()
    await user.type(screen.getByRole('searchbox', { name: 'Search branches' }), 'kcc')
    expect(table().getAllByRole('row')).toHaveLength(2) // header + City Centre
    expect(table().getByText('City Centre')).toBeInTheDocument()

    await user.clear(screen.getByRole('searchbox', { name: 'Search branches' }))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Filter by status' }), 'INACTIVE')
    expect(table().getByText('Nyamirambo Kiosk')).toBeInTheDocument()
    expect(table().queryByText('Remera Main')).not.toBeInTheDocument()
  })

  it('explains when nothing matches', async () => {
    const user = userEvent.setup()
    await openBranches()
    await user.type(screen.getByRole('searchbox', { name: 'Search branches' }), 'zzzz')
    expect(await screen.findByText('No branches match')).toBeInTheDocument()
  })

  it('shows loading, empty and error states', async () => {
    vi.mocked(branchService.listBranches).mockImplementation(() => new Promise(() => {}))
    const { unmount } = await renderAppAt('/branches')
    expect(await screen.findByRole('status')).toHaveTextContent('Loading')
    unmount()

    vi.mocked(branchService.listBranches).mockResolvedValue([])
    const second = await renderAppAt('/branches')
    expect(await screen.findByText('No branches yet')).toBeInTheDocument()
    second.unmount()

    vi.mocked(branchService.listBranches).mockRejectedValue(new Error('down'))
    await renderAppAt('/branches')
    expect(await screen.findByRole('alert', {}, { timeout: 4000 })).toHaveTextContent(
      'Branches could not be loaded.',
    )
  })
})

describe('creating a branch', () => {
  it('requires the mandatory fields', async () => {
    const user = userEvent.setup()
    await openBranches()
    await user.click(screen.getByRole('button', { name: 'Add branch' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add a branch' })
    await user.click(within(dialog).getByRole('button', { name: 'Add branch' }))
    expect(await within(dialog).findByText('Branch name is required.')).toBeInTheDocument()
    expect(within(dialog).getByText('Branch code is required.')).toBeInTheDocument()
    expect(within(dialog).getByText('Choose a province.')).toBeInTheDocument()
    expect(within(dialog).getByText('Physical address is required.')).toBeInTheDocument()
    expect(within(dialog).getByLabelText(/Branch name/)).toHaveAttribute('aria-invalid', 'true')
    expect(branchService.createBranch).not.toHaveBeenCalled()
  })

  it('validates the code and the optional phone number', async () => {
    const user = userEvent.setup()
    await openBranches()
    await user.click(screen.getByRole('button', { name: 'Add branch' }))
    const dialog = await fillBranchForm(user, { code: 'bad code!' })
    await user.type(within(dialog).getByLabelText(/Contact phone/), '123')
    await user.click(within(dialog).getByRole('button', { name: 'Add branch' }))
    expect(
      await within(dialog).findByText('Use 2 to 12 letters, numbers or hyphens.'),
    ).toBeInTheDocument()
    expect(
      within(dialog).getByText(/Rwandan mobile number/, {
        selector: 'p.text-danger, p.text-xs.font-medium',
      }),
    ).toBeInTheDocument()
  })

  it('creates the branch, closes the dialog, confirms, and shows it in the list', async () => {
    const user = userEvent.setup()
    await openBranches()
    await user.click(screen.getByRole('button', { name: 'Add branch' }))
    const dialog = await fillBranchForm(user)
    await user.click(within(dialog).getByRole('button', { name: 'Add branch' }))

    expect(await screen.findByText('Kimironko Market was created.')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    const row = await waitFor(() => table().getByRole('row', { name: /Kimironko Market/ }))
    expect(within(row).getByText('KIM1')).toBeInTheDocument()
    expect(within(row).getByText('Gasabo, Kimironko')).toBeInTheDocument()
    expect(branchService.createBranch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ code: 'KIM1', status: 'ACTIVE' }),
    )
  })

  it('reports a duplicate code on the code field and keeps the dialog open', async () => {
    const user = userEvent.setup()
    await openBranches()
    await user.click(screen.getByRole('button', { name: 'Add branch' }))
    const dialog = await fillBranchForm(user, { code: 'rm01' })
    await user.click(within(dialog).getByRole('button', { name: 'Add branch' }))
    expect(
      await within(dialog).findByText('Another branch in this business already uses this code.'),
    ).toBeInTheDocument()
    expect(within(dialog).getByLabelText(/Branch code/)).toHaveAttribute('aria-invalid', 'true')
  })

  it('shows other failures as an alert and lets the user retry', async () => {
    const user = userEvent.setup()
    vi.mocked(branchService.createBranch).mockRejectedValueOnce(
      new OrganizationServiceError('service_unavailable', 'Service is down.'),
    )
    await openBranches()
    await user.click(screen.getByRole('button', { name: 'Add branch' }))
    const dialog = await fillBranchForm(user)
    await user.click(within(dialog).getByRole('button', { name: 'Add branch' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Service is down.')
    await user.click(within(dialog).getByRole('button', { name: 'Add branch' }))
    expect(await screen.findByText('Kimironko Market was created.')).toBeInTheDocument()
  })

  it('resets district and sector when the province changes', async () => {
    const user = userEvent.setup()
    await openBranches()
    await user.click(screen.getByRole('button', { name: 'Add branch' }))
    const dialog = await fillBranchForm(user)
    await user.selectOptions(within(dialog).getByLabelText(/^Province/), 'Southern Province')
    expect(within(dialog).getByLabelText(/^District/)).toHaveValue('')
  })
})

describe('editing and status', () => {
  it('edits a branch and keeps its immutable ID', async () => {
    const user = userEvent.setup()
    await openBranches()
    const menu = await openRowMenu(user, 'City Centre')
    await user.click(within(menu).getByRole('menuitem', { name: 'Edit' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit branch' })
    // Status is changed through its own confirmed action, never from the edit form.
    expect(within(dialog).queryByLabelText(/^Status/)).not.toBeInTheDocument()
    const name = within(dialog).getByLabelText(/Branch name/)
    await user.clear(name)
    await user.type(name, 'City Centre Plaza')
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByText('City Centre Plaza was updated.')).toBeInTheDocument()
    // The link still points at the same branch ID after renaming.
    await waitFor(() =>
      expect(table().getByRole('link', { name: 'City Centre Plaza' })).toHaveAttribute(
        'href',
        `/branches/${SAMPLE_BRANCH_IDS.cityCentre}`,
      ),
    )
  })

  it('asks before deactivating, explains the consequences, and keeps history', async () => {
    const user = userEvent.setup()
    await openBranches()
    const menu = await openRowMenu(user, 'Remera Main')
    await user.click(within(menu).getByRole('menuitem', { name: 'Deactivate' }))
    const dialog = await screen.findByRole('dialog', { name: 'Deactivate Remera Main?' })
    expect(within(dialog).getByText(/cannot receive new staff assignments/)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(branchService.changeBranchStatus).not.toHaveBeenCalled()

    const again = await openRowMenu(user, 'Remera Main')
    await user.click(within(again).getByRole('menuitem', { name: 'Deactivate' }))
    await user.click(await screen.findByRole('button', { name: 'Deactivate branch' }))
    expect(await screen.findByText('Remera Main is now inactive.')).toBeInTheDocument()
    await waitFor(() =>
      expect(
        within(table().getByRole('row', { name: /Remera Main/ })).getByText('Inactive'),
      ).toBeInTheDocument(),
    )
    // Staff assignments stay on the inactive branch.
    expect(
      within(table().getByRole('row', { name: /Remera Main/ })).getByText('2'),
    ).toBeInTheDocument()
  })

  it('reactivates an inactive branch', async () => {
    const user = userEvent.setup()
    await openBranches()
    const menu = await openRowMenu(user, 'Nyamirambo Kiosk')
    await user.click(within(menu).getByRole('menuitem', { name: 'Activate' }))
    await user.click(await screen.findByRole('button', { name: 'Activate branch' }))
    expect(await screen.findByText('Nyamirambo Kiosk is now active.')).toBeInTheDocument()
  })

  it('keeps the confirmation open and shows the error when the change fails', async () => {
    const user = userEvent.setup()
    vi.mocked(branchService.changeBranchStatus).mockRejectedValueOnce(
      new OrganizationServiceError('not_found', 'This branch could not be found.'),
    )
    await openBranches()
    const menu = await openRowMenu(user, 'Remera Main')
    await user.click(within(menu).getByRole('menuitem', { name: 'Deactivate' }))
    await user.click(await screen.findByRole('button', { name: 'Deactivate branch' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('This branch could not be found.')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })
})

describe('branch details', () => {
  it('shows general information, assigned staff, status and the future-activity placeholder', async () => {
    await renderAppAt(`/branches/${SAMPLE_BRANCH_IDS.remera}`)
    expect(await heading('Remera Main')).toBeInTheDocument()
    expect(screen.getByText(SAMPLE_BRANCH_IDS.remera)).toBeInTheDocument()
    expect(screen.getByText('KG 11 Ave, near Sample Plaza')).toBeInTheDocument()
    expect(screen.getByText('+250788000101')).toBeInTheDocument()
    expect(screen.getByText(/Can receive staff assignments/)).toBeInTheDocument()
    const staff = screen
      .getByRole('heading', { name: 'Assigned staff' })
      .closest('div')!.parentElement!
    expect(within(staff).getByText('Aline Uwase')).toBeInTheDocument()
    expect(within(staff).getByText('Grace Mukamana')).toBeInTheDocument()
    expect(screen.getByText('Invoices and payment activity')).toBeInTheDocument()
    expect(screen.getByText('Coming soon')).toBeInTheDocument()
  })

  it('deactivates from the details page and updates the status description', async () => {
    const user = userEvent.setup()
    await renderAppAt(`/branches/${SAMPLE_BRANCH_IDS.remera}`)
    await heading('Remera Main')
    await user.click(screen.getByRole('button', { name: 'Deactivate' }))
    await user.click(await screen.findByRole('button', { name: 'Deactivate branch' }))
    expect(await screen.findByText(/Keeps all history/)).toBeInTheDocument()
  })

  it('says a branch is not found for unknown ids and for another business’s branch', async () => {
    const { unmount } = await renderAppAt('/branches/brn-nope')
    expect(await heading('Branch not found')).toBeInTheDocument()
    unmount()
    await renderAppAt(`/branches/${SAMPLE_BRANCH_IDS.cafe}`)
    expect(await heading('Branch not found')).toBeInTheDocument()
    expect(screen.queryByText('Cafe Nyamirambo')).not.toBeInTheDocument()
  })
})

describe('permissions', () => {
  it('lets managers manage branches', async () => {
    await openBranches({ signedInAs: 'manager' })
    expect(screen.getByRole('button', { name: 'Add branch' })).toBeInTheDocument()
  })

  it('shows cashiers a 403 instead of the page', async () => {
    await renderAppAt('/branches', { signedInAs: 'cashier' })
    expect(await heading('Access denied')).toBeInTheDocument()
    await renderAppAt(`/branches/${SAMPLE_BRANCH_IDS.remera}`, { signedInAs: 'cashier' })
    expect(
      await screen.findAllByRole('heading', { level: 1, name: 'Access denied' }),
    ).not.toHaveLength(0)
  })

  it('only shows a business its own branches', async () => {
    await openBranches({ signedInAs: 'cafeOwner' })
    expect(table().getByText('Cafe Nyamirambo')).toBeInTheDocument()
    expect(table().queryByText('Remera Main')).not.toBeInTheDocument()
  })
})
