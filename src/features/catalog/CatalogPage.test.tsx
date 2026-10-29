import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { catalogService } from '@/services'
import { CatalogServiceError } from '@/services/catalogService'
import { SAMPLE_MERCHANT_ID } from '@/services/mock/sampleMerchants'
import { getActiveTestBackend, useFastBackend } from '@/test/merchantTestDouble'
import { renderAppAt } from '@/test/renderApp'

type User = ReturnType<typeof userEvent.setup>

const heading = (name: string) => screen.findByRole('heading', { level: 1, name })
const table = () => within(screen.getByRole('table'))
const primaryNav = () => within(screen.getAllByRole('navigation', { name: 'Primary' })[0]!)

async function openCatalog(signedInAs: Parameters<typeof renderAppAt>[1] = {}) {
  const result = await renderAppAt('/catalog', signedInAs)
  await screen.findByRole('table')
  return result
}

async function openAddItem(user: User) {
  await user.click(screen.getByRole('button', { name: 'Add item' }))
  return screen.findByRole('dialog', { name: 'Add a catalog item' })
}

const optionNames = (select: HTMLElement) =>
  within(select)
    .getAllByRole('option')
    .map((option) => option.textContent)

beforeEach(() => {
  useFastBackend()
})

describe('catalog list', () => {
  it('shows goods and services together with their prices per selling unit', async () => {
    await openCatalog()
    expect(await heading('Catalog')).toBeInTheDocument()
    const rice = table().getByRole('row', { name: /Rice/ })
    expect(within(rice).getByText('RICE')).toBeInTheDocument()
    expect(within(rice).getByText('Goods')).toBeInTheDocument()
    expect(within(rice).getByText('RWF 1,200 / kg')).toBeInTheDocument()
    expect(within(rice).getByText('Active')).toBeInTheDocument()
    const haircut = table().getByRole('row', { name: /Haircut/ })
    expect(within(haircut).getByText('Service')).toBeInTheDocument()
    expect(within(haircut).getByText('RWF 3,000 / service')).toBeInTheDocument()
    const old = table().getByRole('row', { name: /discontinued/ })
    expect(within(old).getByText('Inactive')).toBeInTheDocument()
  })

  it('is reachable from the navigation for a business-mode owner', async () => {
    const user = userEvent.setup()
    await renderAppAt('/')
    await user.click(await primaryNav().findByRole('link', { name: 'Catalog' }))
    expect(await heading('Catalog')).toBeInTheDocument()
  })

  it('searches by name or code and filters by type and status', async () => {
    const user = userEvent.setup()
    await openCatalog()
    await user.type(screen.getByRole('searchbox', { name: 'Search catalog' }), 'oil')
    await waitFor(() => expect(table().getAllByRole('row')).toHaveLength(2))
    expect(table().getByText('Cooking oil')).toBeInTheDocument()

    await user.clear(screen.getByRole('searchbox', { name: 'Search catalog' }))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Filter by type' }), 'SERVICE')
    await waitFor(() => expect(table().getAllByRole('row')).toHaveLength(3))
    expect(table().getByText('Haircut')).toBeInTheDocument()
    expect(table().getByText('Car wash')).toBeInTheDocument()
    expect(table().queryByText('Rice')).not.toBeInTheDocument()

    await user.selectOptions(screen.getByRole('combobox', { name: 'Filter by type' }), 'ALL')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Filter by status' }), 'INACTIVE')
    await waitFor(() => expect(table().getAllByRole('row')).toHaveLength(2))
    expect(table().getByText(/Feature phone/)).toBeInTheDocument()
  })

  it('explains when nothing matches', async () => {
    const user = userEvent.setup()
    await openCatalog()
    await user.type(screen.getByRole('searchbox', { name: 'Search catalog' }), 'zzzz')
    expect(await screen.findByText('No items match')).toBeInTheDocument()
  })

  it('shows loading, empty and error states', async () => {
    vi.mocked(catalogService.listItems).mockImplementation(() => new Promise(() => {}))
    const first = await renderAppAt('/catalog')
    expect(await screen.findByRole('status')).toHaveTextContent('Loading')
    first.unmount()

    vi.mocked(catalogService.listItems).mockResolvedValue({
      items: [],
      nextCursor: null,
      totalCount: null,
    })
    const second = await renderAppAt('/catalog')
    expect(await screen.findByText('No items yet')).toBeInTheDocument()
    second.unmount()

    vi.mocked(catalogService.listItems).mockRejectedValue(new Error('down'))
    await renderAppAt('/catalog')
    expect(await screen.findByRole('alert', {}, { timeout: 4000 })).toHaveTextContent(
      'The catalog could not be loaded.',
    )
  })

  it('loads more items with the cursor', async () => {
    const backend = getActiveTestBackend()
    backend.signInAs('owner')
    for (let index = 0; index < 14; index += 1) {
      await backend.fastCatalog.createItem(SAMPLE_MERCHANT_ID, {
        itemType: 'SERVICE',
        name: `Extra service ${index}`,
        pricePerSaleUnitRwf: 100,
      })
    }
    const user = userEvent.setup()
    await openCatalog()
    expect(table().getAllByRole('row')).toHaveLength(21) // header + 20
    await user.click(screen.getByRole('button', { name: 'Load more' }))
    await waitFor(() => expect(table().getAllByRole('row')).toHaveLength(24)) // header + 23
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument()
  })

  it('has a card layout for phones and a table for wider screens, with no fixed widths', async () => {
    await openCatalog()
    const cards = screen.getByRole('list', { name: 'Catalog items' })
    expect(cards).toHaveClass('md:hidden')
    expect(screen.getByRole('table')).toHaveClass('hidden', 'md:table')
    expect(within(cards).getAllByRole('listitem')).toHaveLength(9)
  })
})

describe('creating an item', () => {
  it('requires the mandatory fields and validates the price as whole RWF', async () => {
    const user = userEvent.setup()
    await openCatalog()
    const dialog = await openAddItem(user)
    await user.click(within(dialog).getByRole('button', { name: 'Add item' }))
    expect(await within(dialog).findByText('Name is required.')).toBeInTheDocument()
    expect(within(dialog).getByText('Choose what the item is measured in.')).toBeInTheDocument()
    expect(within(dialog).getByText('Choose the unit you sell it by.')).toBeInTheDocument()
    expect(within(dialog).getByText('Price is required.')).toBeInTheDocument()
    expect(within(dialog).getByLabelText(/^Name/)).toHaveAttribute('aria-invalid', 'true')
    expect(within(dialog).getByLabelText(/^Name/)).toHaveAccessibleDescription(/Name is required/)

    await user.type(within(dialog).getByLabelText(/Price/), '12.5')
    await user.type(within(dialog).getByLabelText(/Item code/), 'bad code')
    await user.click(within(dialog).getByRole('button', { name: 'Add item' }))
    expect(
      await within(dialog).findByText(
        'Enter a whole number of RWF, with no decimals or separators.',
      ),
    ).toBeInTheDocument()
    expect(within(dialog).getByText(/Use letters, numbers, dots/)).toBeInTheDocument()
    expect(catalogService.createItem).not.toHaveBeenCalled()
  })

  it('offers only the selling units of the chosen measurement type', async () => {
    const user = userEvent.setup()
    await openCatalog()
    const dialog = await openAddItem(user)
    const unit = () => within(dialog).getByLabelText(/Selling unit/)
    expect(unit()).toBeDisabled()

    await user.selectOptions(await within(dialog).findByLabelText(/Measured in/), 'MASS')
    expect(unit()).toBeEnabled()
    expect(optionNames(unit())).toEqual(['Choose…', 'Gram (g)', 'Kilogram (kg)'])
    await user.selectOptions(unit(), 'kg')

    await user.selectOptions(within(dialog).getByLabelText(/Measured in/), 'VOLUME')
    expect(optionNames(unit())).toEqual(['Choose…', 'Millilitre (mL)', 'Litre (L)'])
    expect(unit()).toHaveValue('') // the previous choice does not survive a change of type
    await user.selectOptions(within(dialog).getByLabelText(/Measured in/), 'AREA')
    expect(optionNames(unit())).toEqual(['Choose…', 'Square millimetre (mm²)', 'Square metre (m²)'])
    await user.selectOptions(within(dialog).getByLabelText(/Measured in/), 'COUNT')
    expect(optionNames(unit())).toEqual(['Choose…', 'Piece (pc)'])
  })

  it('creates goods, sends exact values and shows the item', async () => {
    const user = userEvent.setup()
    await openCatalog()
    const dialog = await openAddItem(user)
    await user.type(within(dialog).getByLabelText(/^Name/), 'Sugar')
    await user.type(within(dialog).getByLabelText(/Item code/), 'sug1')
    await user.selectOptions(await within(dialog).findByLabelText(/Measured in/), 'MASS')
    await user.selectOptions(within(dialog).getByLabelText(/Selling unit/), 'kg')
    await user.type(within(dialog).getByLabelText(/Price/), '1500')
    expect(within(dialog).getByText('Price of one kilogram, in whole francs.')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Add item' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(catalogService.createItem).toHaveBeenCalledWith(SAMPLE_MERCHANT_ID, {
      itemType: 'GOODS',
      name: 'Sugar',
      code: 'sug1',
      description: undefined,
      measurementDimension: 'MASS',
      saleUnit: 'kg',
      pricePerSaleUnitRwf: 1500,
      active: true,
    })
    const row = await table().findByRole('row', { name: /Sugar/ })
    expect(within(row).getByText('SUG1')).toBeInTheDocument()
    expect(within(row).getByText('RWF 1,500 / kg')).toBeInTheDocument()
  })

  it('creates a service without units', async () => {
    const user = userEvent.setup()
    await openCatalog()
    const dialog = await openAddItem(user)
    await user.selectOptions(within(dialog).getByLabelText(/^Type/), 'SERVICE')
    expect(within(dialog).queryByLabelText(/Selling unit/)).not.toBeInTheDocument()
    expect(within(dialog).queryByLabelText(/Measured in/)).not.toBeInTheDocument()
    await user.type(within(dialog).getByLabelText(/^Name/), 'Consulting')
    await user.type(within(dialog).getByLabelText(/Price/), '25000')
    expect(within(dialog).getByText('Price of one service, in whole francs.')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Add item' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument(), {
      timeout: 4000,
    })
    expect(await table().findByRole('row', { name: /Consulting/ })).toBeInTheDocument()
    expect(catalogService.createItem).toHaveBeenCalledWith(
      SAMPLE_MERCHANT_ID,
      expect.objectContaining({
        itemType: 'SERVICE',
        measurementDimension: undefined,
        saleUnit: undefined,
      }),
    )
  })

  it('shows the server error next to the code field when it is already used', async () => {
    const user = userEvent.setup()
    await openCatalog()
    const dialog = await openAddItem(user)
    await user.selectOptions(within(dialog).getByLabelText(/^Type/), 'SERVICE')
    await user.type(within(dialog).getByLabelText(/^Name/), 'Another rice')
    await user.type(within(dialog).getByLabelText(/Item code/), 'rice')
    await user.type(within(dialog).getByLabelText(/Price/), '100')
    await user.click(within(dialog).getByRole('button', { name: 'Add item' }))
    expect(
      await within(dialog).findByText('Another item in this business already uses this code.'),
    ).toBeInTheDocument()
    expect(within(dialog).getByLabelText(/Item code/)).toHaveAttribute('aria-invalid', 'true')
  })
})

describe('editing, pricing and status', () => {
  async function openRowMenu(user: User, name: string) {
    await user.click(table().getByRole('button', { name: `Actions for ${name}` }))
    return screen.findByRole('menu')
  }

  it('locks the type and measurement, and records a price change in the history', async () => {
    const user = userEvent.setup()
    await openCatalog()
    await openRowMenu(user, 'Rice')
    await user.click(screen.getByRole('menuitem', { name: /Edit/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit catalog item' })
    expect(within(dialog).getByLabelText(/^Type/)).toBeDisabled()
    await waitFor(() => expect(within(dialog).getByLabelText(/Measured in/)).toHaveValue('MASS'))
    expect(within(dialog).getByLabelText(/Measured in/)).toBeDisabled()
    expect(
      within(dialog).getByText(/Stock is kept in g\. This cannot change\./),
    ).toBeInTheDocument()
    expect(within(dialog).getByLabelText(/Selling unit/)).toHaveValue('kg')
    expect(within(dialog).queryByLabelText(/Reason for the change/)).not.toBeInTheDocument()

    await user.clear(within(dialog).getByLabelText(/Price/))
    await user.type(within(dialog).getByLabelText(/Price/), '1300')
    await user.type(await within(dialog).findByLabelText(/Reason for the change/), 'New harvest')
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(await table().findByText('RWF 1,300 / kg')).toBeInTheDocument()
    expect(catalogService.updateItem).toHaveBeenCalledWith(
      SAMPLE_MERCHANT_ID,
      'cat-rice',
      expect.objectContaining({
        expectedVersion: 0,
        pricePerSaleUnitRwf: 1300,
        priceChangeReason: 'New harvest',
        saleUnit: 'kg',
      }),
    )

    await user.click(table().getByRole('button', { name: 'Rice' }))
    const details = await screen.findByRole('dialog', { name: 'Rice' })
    await user.click(await within(details).findByRole('button', { name: 'Show price history' }))
    const versions = await within(details).findByRole('list', { name: 'Price versions' })
    const entries = within(versions).getAllByRole('listitem')
    expect(entries).toHaveLength(3)
    expect(entries[0]).toHaveTextContent('Version 3: RWF 1,300 per kg')
    expect(entries[0]).toHaveTextContent('New harvest')
    expect(entries[1]).toHaveTextContent('Version 2: RWF 1,200 per kg')
    expect(entries[2]).toHaveTextContent('Version 1: RWF 1,100 per kg')
  })

  it('offers a reload when someone else changed the item, then saves on the latest version', async () => {
    const user = userEvent.setup()
    const backend = getActiveTestBackend()
    await openCatalog()
    await openRowMenu(user, 'Cement')
    await user.click(screen.getByRole('menuitem', { name: /Edit/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit catalog item' })
    await waitFor(() => expect(within(dialog).getByLabelText(/Measured in/)).toHaveValue('MASS'))

    // Someone else changes the same item first.
    const latest = await backend.fastCatalog.getItem(SAMPLE_MERCHANT_ID, 'cat-cement')
    await backend.fastCatalog.updateItem(SAMPLE_MERCHANT_ID, 'cat-cement', {
      expectedVersion: latest.version,
      name: 'Cement (50 kg bags)',
      saleUnit: 'kg',
      pricePerSaleUnitRwf: 310,
    })

    await user.clear(within(dialog).getByLabelText(/Price/))
    await user.type(within(dialog).getByLabelText(/Price/), '300')
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/changed by someone else/)

    await user.click(within(dialog).getByRole('button', { name: 'Reload the latest version' }))
    await waitFor(() =>
      expect(within(dialog).getByLabelText(/^Name/)).toHaveValue('Cement (50 kg bags)'),
    )
    expect(within(dialog).getByLabelText(/Price/)).toHaveValue('310')
    await user.clear(within(dialog).getByLabelText(/Price/))
    await user.type(within(dialog).getByLabelText(/Price/), '300')
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(await table().findByText('RWF 300 / kg')).toBeInTheDocument()
  })

  it('deactivates after a confirmation, keeps the item, and can activate it again', async () => {
    const user = userEvent.setup()
    await openCatalog()
    await openRowMenu(user, 'Haircut')
    await user.click(screen.getByRole('menuitem', { name: 'Deactivate' }))
    const dialog = await screen.findByRole('dialog', { name: 'Deactivate Haircut?' })
    expect(within(dialog).getByText(/Nothing is deleted/)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Deactivate item' }))
    await waitFor(() =>
      expect(
        within(table().getByRole('row', { name: /Haircut/ })).getByText('Inactive'),
      ).toBeInTheDocument(),
    )
    await openRowMenu(user, 'Haircut')
    await user.click(screen.getByRole('menuitem', { name: 'Activate' }))
    await user.click(await screen.findByRole('button', { name: 'Activate item' }))
    await waitFor(() =>
      expect(
        within(table().getByRole('row', { name: /Haircut/ })).getByText('Active'),
      ).toBeInTheDocument(),
    )
  })
})

describe('packages', () => {
  async function openDetails(user: User, name: string) {
    await user.click(table().getByRole('button', { name }))
    return screen.findByRole('dialog', { name })
  }

  it('shows each package in the selling unit and as stock, with no price of its own', async () => {
    const user = userEvent.setup()
    await openCatalog()
    const dialog = await openDetails(user, 'Cooking oil')
    const packages = within(await within(dialog).findByRole('region', { name: 'Packages' }))
    expect(packages.getByText('Bottle')).toBeInTheDocument()
    expect(packages.getByText('0.75 L · 750 mL in stock')).toBeInTheDocument()
    expect(packages.getByText('20 L · 20000 mL in stock')).toBeInTheDocument()
    expect(within(dialog).getByText(/has no price of its own/)).toBeInTheDocument()
    expect(within(dialog).getByText('RWF 3,200 per L')).toBeInTheDocument()
  })

  it('adds a package and rejects a fractional number of pieces with the server message', async () => {
    const user = userEvent.setup()
    await openCatalog()
    const dialog = await openDetails(user, 'Smartphone')
    await user.click(await within(dialog).findByRole('button', { name: 'Add package' }))
    const form = within(await within(dialog).findByRole('form', { name: 'Add package' }))
    await user.type(form.getByLabelText(/Package label/), 'Box')
    await user.type(form.getByLabelText(/One package holds/), '24.5')
    await user.click(form.getByRole('button', { name: 'Add package' }))
    expect(await form.findByRole('alert')).toHaveTextContent(
      'That package definition is not valid.',
    )

    await user.clear(form.getByLabelText(/One package holds/))
    await user.type(form.getByLabelText(/One package holds/), '24')
    await user.click(form.getByRole('button', { name: 'Add package' }))
    expect(await within(dialog).findByText('24 pc · 24 pc in stock')).toBeInTheDocument()
    expect(catalogService.createPackage).toHaveBeenLastCalledWith(SAMPLE_MERCHANT_ID, 'cat-phone', {
      label: 'Box',
      contentsAmount: '24',
      contentsUnit: 'pc',
    })
  })

  it('validates the amount locally and offers only units of the item’s dimension', async () => {
    const user = userEvent.setup()
    await openCatalog()
    const dialog = await openDetails(user, 'Rice')
    await user.click(await within(dialog).findByRole('button', { name: 'Add package' }))
    const form = within(await within(dialog).findByRole('form', { name: 'Add package' }))
    await waitFor(() =>
      expect(optionNames(form.getByLabelText(/^Unit/))).toEqual(['Gram (g)', 'Kilogram (kg)']),
    )
    await user.type(form.getByLabelText(/One package holds/), '1e3')
    await user.click(form.getByRole('button', { name: 'Add package' }))
    expect(await form.findByText('Enter a plain number such as 24 or 0.75.')).toBeInTheDocument()
    expect(catalogService.createPackage).not.toHaveBeenCalled()
  })

  it('deactivates a package', async () => {
    const user = userEvent.setup()
    await openCatalog()
    const dialog = await openDetails(user, 'Rice')
    await user.click(await within(dialog).findByRole('button', { name: 'Deactivate package Bag' }))
    expect(await within(dialog).findByText('(inactive)')).toBeInTheDocument()
  })

  it('says services have no packages', async () => {
    const user = userEvent.setup()
    await openCatalog()
    const dialog = await openDetails(user, 'Haircut')
    expect(await within(dialog).findByText('Services do not have packages.')).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Add package' })).not.toBeInTheDocument()
  })
})

describe('roles and operating mode', () => {
  it('gives a manager the management controls', async () => {
    await openCatalog({ signedInAs: 'manager' })
    expect(screen.getByRole('button', { name: 'Add item' })).toBeInTheDocument()
    expect(table().getByRole('button', { name: 'Actions for Rice' })).toBeInTheDocument()
    expect(await primaryNav().findByRole('link', { name: 'Catalog' })).toBeInTheDocument()
  })

  it('gives a cashier a read-only catalog', async () => {
    const user = userEvent.setup()
    await openCatalog({ signedInAs: 'cashier' })
    expect(await primaryNav().findByRole('link', { name: 'Catalog' })).toBeInTheDocument()
    expect(screen.getByText(/You can view the catalog/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add item' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Actions for/ })).not.toBeInTheDocument()
    await user.click(table().getByRole('button', { name: 'Rice' }))
    const dialog = await screen.findByRole('dialog', { name: 'Rice' })
    expect(await within(dialog).findByText('Packages')).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Add package' })).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: /Edit package/ })).not.toBeInTheDocument()
    expect(
      within(dialog).queryByRole('button', { name: /Deactivate package/ }),
    ).not.toBeInTheDocument()
  })

  it('has no Catalog entry and an explanation for a SIMPLIFIED business', async () => {
    const backend = getActiveTestBackend()
    backend.signInAs('owner')
    await backend.fastMerchants.updateMerchantSettings(SAMPLE_MERCHANT_ID, {
      operatingMode: 'SIMPLIFIED',
      expectedVersion: 0,
    })
    await renderAppAt('/catalog')
    expect(
      await screen.findByText('The catalog is for businesses in business mode'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(catalogService.listItems).not.toHaveBeenCalled()
    expect(primaryNav().queryByRole('link', { name: 'Catalog' })).not.toBeInTheDocument()
    // Existing entries stay.
    for (const name of ['Dashboard', 'Invoices', 'Collect Payment', 'Payments', 'Payment links']) {
      expect(primaryNav().getByRole('link', { name })).toBeInTheDocument()
    }
  })

  it('shows the same explanation if the server says the catalog is unavailable', async () => {
    vi.mocked(catalogService.listItems).mockRejectedValue(
      new CatalogServiceError('catalog_unavailable', 'Not available.'),
    )
    await renderAppAt('/catalog')
    expect(
      await screen.findByText('The catalog is for businesses in business mode'),
    ).toBeInTheDocument()
  })
})
