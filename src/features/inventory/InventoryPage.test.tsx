import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { inventoryService } from '@/services'
import { SAMPLE_MERCHANT_ID } from '@/services/mock/sampleMerchants'
import { SAMPLE_BRANCH_IDS } from '@/services/mock/sampleOrganization'
import { getActiveTestBackend, useFastBackend } from '@/test/merchantTestDouble'
import { renderAppAt } from '@/test/renderApp'

type User = ReturnType<typeof userEvent.setup>

const M = SAMPLE_MERCHANT_ID
const heading = (name: string) => screen.findByRole('heading', { level: 1, name })
const table = () => within(screen.getByRole('table'))
const primaryNav = () => within(screen.getAllByRole('navigation', { name: 'Primary' })[0]!)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

async function openInventory(signedInAs: Parameters<typeof renderAppAt>[1] = {}) {
  const result = await renderAppAt('/inventory', signedInAs)
  await screen.findByRole('table')
  return result
}

async function openDialog(user: User, button: string, title: string) {
  await user.click(screen.getByRole('button', { name: button }))
  return screen.findByRole('dialog', { name: title })
}

const optionNames = (select: HTMLElement) =>
  within(select)
    .getAllByRole('option')
    .map((option) => option.textContent)

async function fillReceive(
  user: User,
  dialog: HTMLElement,
  { item = 'Rice (RICE)', amount = '2.5' }: { item?: string; amount?: string } = {},
) {
  await user.selectOptions(within(dialog).getByLabelText(/^Branch/), 'Remera Main (RM01)')
  await user.selectOptions(within(dialog).getByLabelText(/^Item/), item)
  const quantity = within(dialog).getByLabelText(/^Quantity/)
  await user.clear(quantity)
  await user.type(quantity, amount)
}

beforeEach(() => {
  useFastBackend()
})

describe('inventory: stock list', () => {
  it('shows each good at each branch with its exact stock and the selling-unit equivalent', async () => {
    await openInventory()
    expect(await heading('Inventory')).toBeInTheDocument()
    const rice = table().getAllByRole('row', { name: /Rice/ })
    expect(rice).toHaveLength(2)
    const remera = rice.find((row) => within(row).queryByText('Remera Main'))!
    expect(within(remera).getByText('RICE')).toBeInTheDocument()
    expect(within(remera).getByText('746,500 g')).toBeInTheDocument()
    expect(within(remera).getByText('746.5 kg')).toBeInTheDocument()
    const tiles = table().getByRole('row', { name: /Floor tiles/ })
    expect(within(tiles).getByText('25,000,000 mm²')).toBeInTheDocument()
    expect(within(tiles).getByText('25 m²')).toBeInTheDocument()
    expect(table().queryByText('Haircut')).not.toBeInTheDocument()
  })

  it('is reachable from the navigation', async () => {
    const user = userEvent.setup()
    await renderAppAt('/')
    await user.click(await primaryNav().findByRole('link', { name: 'Inventory' }))
    expect(await heading('Inventory')).toBeInTheDocument()
  })

  it('searches by item name or code and filters by branch', async () => {
    const user = userEvent.setup()
    await openInventory()
    await user.type(screen.getByRole('searchbox', { name: 'Search stock' }), 'rice')
    await waitFor(() => expect(table().getAllByRole('row')).toHaveLength(3))
    await user.clear(screen.getByRole('searchbox', { name: 'Search stock' }))
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Filter by branch' }),
      'City Centre',
    )
    await waitFor(() => expect(table().getAllByRole('row')).toHaveLength(3))
    expect(table().getAllByText('City Centre')).toHaveLength(2)
    await user.type(screen.getByRole('searchbox', { name: 'Search stock' }), 'zzzz')
    expect(await screen.findByText('No stock matches')).toBeInTheDocument()
  })

  it('shows loading, empty and error states', async () => {
    vi.mocked(inventoryService.listBalances).mockImplementation(() => new Promise(() => {}))
    const first = await renderAppAt('/inventory')
    await waitFor(() => expect(screen.getAllByRole('status').length).toBeGreaterThan(0))
    first.unmount()

    vi.mocked(inventoryService.listBalances).mockResolvedValue({
      items: [],
      nextCursor: null,
      totalCount: null,
    })
    const second = await renderAppAt('/inventory')
    expect(await screen.findByText('No stock recorded yet')).toBeInTheDocument()
    second.unmount()

    vi.mocked(inventoryService.listBalances).mockRejectedValue(new Error('down'))
    await renderAppAt('/inventory')
    expect(await screen.findByRole('alert', {}, { timeout: 4000 })).toHaveTextContent(
      'The stock could not be loaded.',
    )
  })

  it('loads more with the cursor', async () => {
    const backend = getActiveTestBackend()
    backend.signInAs('owner')
    for (let index = 0; index < 14; index += 1) {
      const item = await backend.fastCatalog.createItem(M, {
        itemType: 'GOODS',
        name: `Extra good ${index}`,
        measurementDimension: 'COUNT',
        saleUnit: 'pc',
        pricePerSaleUnitRwf: 100,
      })
      await backend.fastInventory.receiveStock(M, {
        clientOperationId: `99999999-0000-4000-8000-${String(index).padStart(12, '0')}`,
        branchId: SAMPLE_BRANCH_IDS.remera,
        itemId: item.id,
        amount: '5',
        unit: 'pc',
      })
    }
    const user = userEvent.setup()
    await openInventory()
    expect(table().getAllByRole('row')).toHaveLength(21)
    await user.click(screen.getByRole('button', { name: 'Load more' }))
    await waitFor(() => expect(table().getAllByRole('row')).toHaveLength(23))
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument()
  })

  it('has a card layout for phones and a table for wider screens', async () => {
    await openInventory()
    expect(screen.getByRole('list', { name: 'Stock by branch' })).toHaveClass('md:hidden')
    expect(screen.getByRole('table')).toHaveClass('hidden', 'md:table')
  })
})

describe('inventory: movement history', () => {
  it('lists movements newest first with signed changes, reasons and who made them', async () => {
    const user = userEvent.setup()
    await openInventory()
    await user.click(screen.getByRole('tab', { name: /Movements/ }))
    await screen.findByRole('table', { name: 'Stock movements' })
    const spill = table().getByRole('row', { name: /Spillage in the store room/ })
    expect(within(spill).getByText('Adjusted out')).toBeInTheDocument()
    expect(within(spill).getByText('-3,500 g')).toBeInTheDocument()
    expect(within(spill).getByText('746,500 g')).toBeInTheDocument()
    expect(within(spill).getByText('Sample Owner')).toBeInTheDocument()
    const receipt = table().getByRole('row', { name: /DN-1042/ })
    expect(within(receipt).getByText('+250,000 g')).toBeInTheDocument()
    expect(within(receipt).getByText(/10 x Bag/)).toBeInTheDocument()
  })

  it('filters by type, item and branch', async () => {
    const user = userEvent.setup()
    await openInventory()
    await user.click(screen.getByRole('tab', { name: /Movements/ }))
    await screen.findByRole('table', { name: 'Stock movements' })
    await user.selectOptions(screen.getByRole('combobox', { name: 'Filter by type' }), 'Received')
    await waitFor(() => expect(table().getAllByRole('row')).toHaveLength(3))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Filter by type' }), 'All types')
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Filter by branch' }),
      'City Centre',
    )
    await waitFor(() => expect(table().getAllByRole('row')).toHaveLength(3))
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Filter by branch' }),
      'All branches',
    )
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Filter by item' }),
      'Cooking oil',
    )
    await waitFor(() => expect(table().getAllByRole('row')).toHaveLength(3))
  })

  it('explains an empty history', async () => {
    vi.mocked(inventoryService.listMovements).mockResolvedValue({
      items: [],
      nextCursor: null,
      totalCount: null,
    })
    const user = userEvent.setup()
    await openInventory()
    await user.click(screen.getByRole('tab', { name: /Movements/ }))
    expect(await screen.findByText('No stock movements yet')).toBeInTheDocument()
  })
})

describe('inventory: receiving stock', () => {
  it('offers only goods, validates the form and shows what is missing', async () => {
    const user = userEvent.setup()
    await openInventory()
    const dialog = await openDialog(user, 'Receive stock', 'Receive stock')
    await within(dialog).findByRole('option', { name: 'Rice (RICE)' })
    const items = optionNames(within(dialog).getByLabelText(/^Item/))
    expect(items).toContain('Rice (RICE)')
    expect(items).toContain('Smartphone (PHONE)')
    expect(items.join()).not.toMatch(/Haircut|Car wash|discontinued/)
    await user.click(within(dialog).getByRole('button', { name: 'Receive stock' }))
    expect(await within(dialog).findByText('Choose a branch.')).toBeInTheDocument()
    expect(within(dialog).getByText('Choose an item.')).toBeInTheDocument()
    expect(within(dialog).getByText('Enter the quantity.')).toBeInTheDocument()
  })

  it('records an exact quantity, closes, and updates the stock', async () => {
    const user = userEvent.setup()
    await openInventory()
    const dialog = await openDialog(user, 'Receive stock', 'Receive stock')
    await within(dialog).findByRole('option', { name: 'Rice (RICE)' })
    await fillReceive(user, dialog)
    // The unit follows the item's selling unit and only offers units of its dimension.
    const unit = within(dialog).getByLabelText(/^Unit/)
    expect(unit).toHaveValue('kg')
    expect(optionNames(unit)).toEqual(['Choose…', 'Gram (g)', 'Kilogram (kg)'])
    await user.type(within(dialog).getByLabelText(/^Reference/), 'DN-2001')
    await user.click(within(dialog).getByRole('button', { name: 'Receive stock' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(inventoryService.receiveStock).toHaveBeenCalledWith(
      M,
      expect.objectContaining({
        branchId: SAMPLE_BRANCH_IDS.remera,
        amount: '2.5',
        unit: 'kg',
        reference: 'DN-2001',
        clientOperationId: expect.stringMatching(UUID),
      }),
    )
    expect(await table().findByText('749,000 g')).toBeInTheDocument()
  })

  it('enters a count of packages', async () => {
    const user = userEvent.setup()
    await openInventory()
    const dialog = await openDialog(user, 'Receive stock', 'Receive stock')
    await within(dialog).findByRole('option', { name: 'Rice (RICE)' })
    await user.selectOptions(within(dialog).getByLabelText(/^Branch/), 'Remera Main (RM01)')
    await user.selectOptions(within(dialog).getByLabelText(/^Item/), 'Rice (RICE)')
    await user.selectOptions(
      within(dialog).getByLabelText(/Enter quantity as/),
      'A number of packages',
    )
    expect(within(dialog).queryByLabelText(/^Quantity/)).not.toBeInTheDocument()
    await user.selectOptions(within(dialog).getByLabelText(/^Package/), 'Bag (25 kg)')
    await user.type(within(dialog).getByLabelText(/Number of packages/), '1.5')
    await user.click(within(dialog).getByRole('button', { name: 'Receive stock' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(inventoryService.receiveStock).toHaveBeenCalledWith(
      M,
      expect.objectContaining({ packageId: 'cat-rice-pkg-1', packageCount: '1.5' }),
    )
    expect(await table().findByText('784,000 g')).toBeInTheDocument()
  })

  it('does not offer packages for an item that has none', async () => {
    const user = userEvent.setup()
    await openInventory()
    const dialog = await openDialog(user, 'Receive stock', 'Receive stock')
    await within(dialog).findByRole('option', { name: 'Kitenge fabric (FABRIC)' })
    await user.selectOptions(within(dialog).getByLabelText(/^Item/), 'Kitenge fabric (FABRIC)')
    expect(within(dialog).queryByLabelText(/Enter quantity as/)).not.toBeInTheDocument()
  })

  it('counts discrete goods in whole pieces', async () => {
    const user = userEvent.setup()
    await openInventory()
    const dialog = await openDialog(user, 'Receive stock', 'Receive stock')
    await within(dialog).findByRole('option', { name: 'Smartphone (PHONE)' })
    await fillReceive(user, dialog, { item: 'Smartphone (PHONE)', amount: '1.5' })
    await user.click(within(dialog).getByRole('button', { name: 'Receive stock' }))
    expect(await within(dialog).findByText('Use a whole number of pieces.')).toBeInTheDocument()
    expect(inventoryService.receiveStock).not.toHaveBeenCalled()
  })

  it('shows the server’s reason when it refuses, and keeps the form', async () => {
    const user = userEvent.setup()
    await openInventory()
    const dialog = await openDialog(user, 'Receive stock', 'Receive stock')
    await within(dialog).findByRole('option', { name: 'Rice (RICE)' })
    await fillReceive(user, dialog, { amount: '0.0000001' })
    await user.selectOptions(within(dialog).getByLabelText(/^Unit/), 'Gram (g)')
    await user.click(within(dialog).getByRole('button', { name: 'Receive stock' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/decimal places/)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('re-sends the SAME operation id when the same submission is retried, so stock is added once', async () => {
    vi.mocked(inventoryService.receiveStock).mockRejectedValueOnce(new Error('network down'))
    const user = userEvent.setup()
    await openInventory()
    const dialog = await openDialog(user, 'Receive stock', 'Receive stock')
    await within(dialog).findByRole('option', { name: 'Rice (RICE)' })
    await fillReceive(user, dialog)
    await user.click(within(dialog).getByRole('button', { name: 'Receive stock' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/will not be counted twice/)
    await user.click(within(dialog).getByRole('button', { name: 'Receive stock' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    const calls = vi.mocked(inventoryService.receiveStock).mock.calls
    expect(calls).toHaveLength(2)
    expect(calls[0]![1].clientOperationId).toMatch(UUID)
    expect(calls[1]![1].clientOperationId).toBe(calls[0]![1].clientOperationId)
    expect(await table().findByText('749,000 g')).toBeInTheDocument()
  })

  it('uses a NEW operation id once the person changes what they entered', async () => {
    vi.mocked(inventoryService.receiveStock).mockRejectedValueOnce(new Error('network down'))
    const user = userEvent.setup()
    await openInventory()
    const dialog = await openDialog(user, 'Receive stock', 'Receive stock')
    await within(dialog).findByRole('option', { name: 'Rice (RICE)' })
    await fillReceive(user, dialog)
    await user.click(within(dialog).getByRole('button', { name: 'Receive stock' }))
    await within(dialog).findByRole('alert')
    const quantity = within(dialog).getByLabelText(/^Quantity/)
    await user.clear(quantity)
    await user.type(quantity, '3')
    await user.click(within(dialog).getByRole('button', { name: 'Receive stock' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    const calls = vi.mocked(inventoryService.receiveStock).mock.calls
    expect(calls[1]![1].clientOperationId).not.toBe(calls[0]![1].clientOperationId)
    expect(calls[1]![1].amount).toBe('3')
  })

  it('disables the button while the request is pending', async () => {
    let finish: (value: never) => void = () => {}
    vi.mocked(inventoryService.receiveStock).mockImplementationOnce(
      () => new Promise((resolve) => (finish = resolve as never)),
    )
    const user = userEvent.setup()
    await openInventory()
    const dialog = await openDialog(user, 'Receive stock', 'Receive stock')
    await within(dialog).findByRole('option', { name: 'Rice (RICE)' })
    await fillReceive(user, dialog)
    await user.click(within(dialog).getByRole('button', { name: 'Receive stock' }))
    const busy = await within(dialog).findByRole('button', { name: 'Recording…' })
    expect(busy).toBeDisabled()
    finish(undefined as never)
  })
})

describe('inventory: adjusting stock', () => {
  async function fillAdjust(
    user: User,
    dialog: HTMLElement,
    direction: string,
    amount: string,
    reason?: string,
  ) {
    await user.selectOptions(within(dialog).getByLabelText(/^Branch/), 'Remera Main (RM01)')
    await user.selectOptions(within(dialog).getByLabelText(/^Item/), 'Smartphone (PHONE)')
    await user.selectOptions(within(dialog).getByLabelText(/^Direction/), direction)
    await user.type(within(dialog).getByLabelText(/^Quantity/), amount)
    if (reason) await user.type(within(dialog).getByLabelText(/^Reason/), reason)
  }

  it('requires a reason', async () => {
    const user = userEvent.setup()
    await openInventory()
    const dialog = await openDialog(user, 'Adjust stock', 'Adjust stock')
    await within(dialog).findByRole('option', { name: 'Smartphone (PHONE)' })
    await fillAdjust(user, dialog, 'Remove stock (out)', '2')
    await user.click(within(dialog).getByRole('button', { name: 'Record adjustment' }))
    expect(await within(dialog).findByText('Give a reason for the adjustment.')).toBeInTheDocument()
    expect(inventoryService.adjustStock).not.toHaveBeenCalled()
  })

  it('records a removal with its reason', async () => {
    const user = userEvent.setup()
    await openInventory()
    const dialog = await openDialog(user, 'Adjust stock', 'Adjust stock')
    await within(dialog).findByRole('option', { name: 'Smartphone (PHONE)' })
    await fillAdjust(user, dialog, 'Remove stock (out)', '2', 'Two phones stolen')
    await user.click(within(dialog).getByRole('button', { name: 'Record adjustment' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(inventoryService.adjustStock).toHaveBeenCalledWith(
      M,
      expect.objectContaining({
        direction: 'OUT',
        amount: '2',
        unit: 'pc',
        reason: 'Two phones stolen',
      }),
    )
    const rows = await table().findAllByRole('row', { name: /Smartphone/ })
    expect(rows.some((row) => within(row).queryByText('39 pc'))).toBe(true)
  })

  it('says clearly when there is not enough stock, and changes nothing', async () => {
    const user = userEvent.setup()
    await openInventory()
    const dialog = await openDialog(user, 'Adjust stock', 'Adjust stock')
    await within(dialog).findByRole('option', { name: 'Smartphone (PHONE)' })
    await fillAdjust(user, dialog, 'Remove stock (out)', '500', 'Big loss')
    await user.click(within(dialog).getByRole('button', { name: 'Record adjustment' }))
    const alert = await within(dialog).findByRole('alert')
    expect(alert).toHaveTextContent(/not enough stock/)
    expect(alert).toHaveTextContent(/Nothing was changed/)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    const stock = await getActiveTestBackend().fastInventory.listBalances(M, {
      itemId: 'cat-phone',
      branchId: SAMPLE_BRANCH_IDS.remera,
    })
    expect(stock.items[0]?.quantityOnHand).toBe('41')
  })
})

describe('inventory: opening stock', () => {
  it('records the first stock of an item once, and says so when it is repeated', async () => {
    const user = userEvent.setup()
    await openInventory()
    let dialog = await openDialog(user, 'Record opening stock', 'Record opening stock')
    await within(dialog).findByRole('option', { name: 'Kitenge fabric (FABRIC)' })
    await user.selectOptions(within(dialog).getByLabelText(/^Branch/), 'City Centre (KCC)')
    await user.selectOptions(within(dialog).getByLabelText(/^Item/), 'Kitenge fabric (FABRIC)')
    await user.type(within(dialog).getByLabelText(/^Quantity/), '40')
    await user.click(within(dialog).getByRole('button', { name: 'Record opening stock' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(await table().findByText('40,000 mm')).toBeInTheDocument()

    dialog = await openDialog(user, 'Record opening stock', 'Record opening stock')
    await within(dialog).findByRole('option', { name: 'Kitenge fabric (FABRIC)' })
    await user.selectOptions(within(dialog).getByLabelText(/^Branch/), 'City Centre (KCC)')
    await user.selectOptions(within(dialog).getByLabelText(/^Item/), 'Kitenge fabric (FABRIC)')
    await user.type(within(dialog).getByLabelText(/^Quantity/), '10')
    await user.click(within(dialog).getByRole('button', { name: 'Record opening stock' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/only be recorded once/)
  })
})

describe('inventory: who can do what', () => {
  it('shows an owner all three actions and every branch', async () => {
    const user = userEvent.setup()
    await openInventory()
    expect(screen.getByRole('button', { name: 'Receive stock' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Adjust stock' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Record opening stock' })).toBeInTheDocument()
    const dialog = await openDialog(user, 'Receive stock', 'Receive stock')
    // Only active branches are offered for writing.
    expect(optionNames(within(dialog).getByLabelText(/^Branch/))).toEqual([
      'Choose…',
      'City Centre (KCC)',
      'Remera Main (RM01)',
    ])
  })

  it('lets a manager record stock only at a branch they are assigned to', async () => {
    const user = userEvent.setup()
    await openInventory({ signedInAs: 'manager' })
    expect(screen.getByRole('button', { name: 'Receive stock' })).toBeInTheDocument()
    const dialog = await openDialog(user, 'Receive stock', 'Receive stock')
    // One writable branch, so it is chosen already.
    expect(within(dialog).getByLabelText(/^Branch/)).toHaveValue(SAMPLE_BRANCH_IDS.remera)
    expect(optionNames(within(dialog).getByLabelText(/^Branch/))).toEqual([
      'Choose…',
      'Remera Main (RM01)',
    ])
    // ...but the manager can still read every branch.
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(optionNames(screen.getByRole('combobox', { name: 'Filter by branch' }))).toEqual([
      'All branches',
      'City Centre',
      'Nyamirambo Kiosk',
      'Remera Main',
    ])
  })

  it('gives a cashier a read-only view of their own branches', async () => {
    await openInventory({ signedInAs: 'cashier' })
    expect(await heading('Inventory')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Receive stock' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Adjust stock' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Record opening stock' })).not.toBeInTheDocument()
    expect(screen.getByRole('note')).toHaveTextContent('You can view stock')
    expect(table().getAllByRole('row').length).toBeGreaterThan(1)
    expect(optionNames(screen.getByRole('combobox', { name: 'Filter by branch' }))).toEqual([
      'All branches',
      'City Centre',
      'Remera Main',
    ])
  })
})

describe('inventory: business and simplified mode', () => {
  it('is in the navigation of a business-mode business only', async () => {
    const backend = getActiveTestBackend()
    backend.signInAs('owner')
    await backend.fastMerchants.updateMerchantSettings(M, {
      operatingMode: 'SIMPLIFIED',
      expectedVersion: 0,
    })
    await renderAppAt('/')
    await heading('Dashboard')
    await primaryNav().findByRole('link', { name: 'Collect Payment' })
    expect(primaryNav().queryByRole('link', { name: 'Inventory' })).not.toBeInTheDocument()
    expect(primaryNav().queryByRole('link', { name: 'Catalog' })).not.toBeInTheDocument()
  })

  it('explains itself to a simplified business that opens the address directly', async () => {
    const backend = getActiveTestBackend()
    backend.signInAs('owner')
    await backend.fastMerchants.updateMerchantSettings(M, {
      operatingMode: 'SIMPLIFIED',
      expectedVersion: 0,
    })
    await renderAppAt('/inventory')
    expect(
      await screen.findByText('Inventory is for businesses in business mode'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Receive stock' })).not.toBeInTheDocument()
  })

  it('shows the explanation when the server says inventory is unavailable', async () => {
    const { InventoryServiceError } = await import('@/services/inventoryService')
    vi.mocked(inventoryService.getOptions).mockRejectedValue(
      new InventoryServiceError('inventory_unavailable', 'No inventory.'),
    )
    await renderAppAt('/inventory')
    expect(
      await screen.findByText('Inventory is for businesses in business mode'),
    ).toBeInTheDocument()
  })
})

describe('inventory: stock is never editable elsewhere', () => {
  it('has no stock field in the catalog form, and services have no stock', async () => {
    const user = userEvent.setup()
    await renderAppAt('/catalog')
    await screen.findByRole('table')
    await user.click(screen.getByRole('button', { name: 'Add item' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add a catalog item' })
    expect(
      within(dialog).queryByLabelText(/stock|opening|quantity on hand/i),
    ).not.toBeInTheDocument()
    await user.selectOptions(within(dialog).getByLabelText(/^Type/), 'SERVICE')
    expect(
      within(dialog).queryByLabelText(/stock|opening|quantity on hand/i),
    ).not.toBeInTheDocument()
  })
})
