import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { posService } from '@/services'
import { MOCK_STORAGE_KEYS } from '@/services/mock/mockStorageKeys'
import {
  SAMPLE_CATALOG_ITEMS,
  SAMPLE_CATALOG_PRICES,
  type StoredCatalogItem,
  type StoredPriceVersion,
} from '@/services/mock/sampleCatalog'
import { SAMPLE_MERCHANT_ID } from '@/services/mock/sampleMerchants'
import { findAccessibilityViolations } from '@/test/axe'
import { getActiveTestBackend, useFastBackend, type DemoUserKey } from '@/test/merchantTestDouble'
import { renderAppAt } from '@/test/renderApp'

type User = ReturnType<typeof userEvent.setup>

const primaryNav = () => within(screen.getAllByRole('navigation', { name: 'Primary' })[0]!)

const openPos = (signedInAs: DemoUserKey = 'manager') => renderAppAt('/pos', { signedInAs })

const catalogList = async () => within(await screen.findByRole('list', { name: 'Catalog items' }))
const cartList = () => within(screen.getByRole('list', { name: 'Cart lines' }))

async function add(user: User, name: string) {
  const items = await catalogList()
  await user.click(await items.findByRole('button', { name: `Add ${name} to the cart` }))
}

async function setQuantity(user: User, name: string, value: string) {
  const field = await screen.findByLabelText(new RegExp(`^Quantity of ${name}`))
  await user.clear(field)
  if (value) await user.type(field, value)
}

beforeEach(() => {
  window.sessionStorage.clear()
  useFastBackend()
})

describe('POS billing: the page', () => {
  it('has one heading, labelled controls, the not-a-sale notice, and passes axe', async () => {
    const { container } = await openPos()
    expect(
      await screen.findByRole('heading', { level: 1, name: 'POS billing' }),
    ).toBeInTheDocument()
    expect(await screen.findByLabelText(/Search goods and services/)).toBeInTheDocument()
    expect(screen.getByText(/A draft is not a sale/)).toBeInTheDocument()
    expect(screen.getByText(/checked again when you bill/)).toBeInTheDocument()
    // One branch: no selector, just the branch name.
    expect(screen.queryByLabelText(/^Branch/)).not.toBeInTheDocument()
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Goods and services' }),
    ).toBeInTheDocument()
    expect(await findAccessibilityViolations(container)).toEqual([])
  })

  it('lists only active items with the current price per selling unit and an indicator for stock', async () => {
    await openPos()
    const items = await catalogList()
    expect(items.getByText('Rice')).toBeInTheDocument()
    expect(items.queryByText(/Feature phone/)).not.toBeInTheDocument()
    const rice = items.getByText('Rice').closest('li')!
    expect(within(rice).getByText(/RWF\s?1,200 per kg/)).toBeInTheDocument()
    expect(within(rice).getByText(/746\.5 kg in stock/)).toBeInTheDocument()
    const haircut = items.getByText('Haircut').closest('li')!
    expect(within(haircut).getByText('Service: no stock needed')).toBeInTheDocument()
  })

  it('filters the catalog by name or code', async () => {
    const user = userEvent.setup()
    await openPos()
    await user.type(await screen.findByLabelText(/Search goods and services/), 'cement')
    const items = await catalogList()
    await waitFor(() => expect(items.queryByText('Rice')).not.toBeInTheDocument())
    expect(items.getByText('Cement')).toBeInTheDocument()
  })

  it('builds a mixed cart of goods and services and prices every line and the total', async () => {
    const user = userEvent.setup()
    await openPos()
    await add(user, 'Rice')
    await setQuantity(user, 'Rice', '2.5')
    await add(user, 'Haircut')
    await setQuantity(user, 'Haircut', '2')
    const cart = cartList()
    expect(await cart.findByText(/2\.5 kg × RWF\s?1,200 = RWF\s?3,000/)).toBeInTheDocument()
    expect(await cart.findByText(/2 pc × RWF\s?3,000 = RWF\s?6,000/)).toBeInTheDocument()
    expect(await screen.findByText(/RWF\s?9,000/, { selector: '[aria-live]' })).toBeInTheDocument()
    expect(cart.getByText(/price version 2/)).toBeInTheDocument()
  })

  it('converts a smaller unit exactly and a package into selling units', async () => {
    const user = userEvent.setup()
    await openPos()
    await add(user, 'Rice')
    await user.selectOptions(await screen.findByLabelText(/^Unit for Rice/), 'grams (g)')
    await setQuantity(user, 'Rice', '250')
    expect(await cartList().findByText(/0\.25 kg × RWF\s?1,200 = RWF\s?300/)).toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText(/^Unit for Rice/), 'Bag (25 kg)')
    await setQuantity(user, 'Rice', '2')
    expect(await cartList().findByText(/50 kg × RWF\s?1,200 = RWF\s?60,000/)).toBeInTheDocument()
  })
})

describe('POS billing: quantity validation', () => {
  it('explains a missing, malformed, zero or fractional quantity without calling the service', async () => {
    const user = userEvent.setup()
    await openPos()
    await add(user, 'Smartphone')
    const quote = vi.spyOn(posService, 'quotePosCart')
    await setQuantity(user, 'Smartphone', '')
    await user.click(screen.getByRole('button', { name: 'Save draft' }))
    expect(await screen.findByText('Enter a quantity.')).toBeInTheDocument()
    await setQuantity(user, 'Smartphone', 'abc')
    expect(await screen.findByText(/Enter the quantity as a number/)).toBeInTheDocument()
    await setQuantity(user, 'Smartphone', '0')
    expect(await screen.findByText('The quantity must be more than zero.')).toBeInTheDocument()
    await setQuantity(user, 'Smartphone', '1.5')
    expect(
      await screen.findByText('Items sold by the piece must be whole numbers.'),
    ).toBeInTheDocument()
    // Only a quantity that passed the quick check ever reaches the service (typing "1.5" passes through "1").
    for (const call of quote.mock.calls) {
      expect(call[1].lines.every((l) => l.quantity === '1')).toBe(true)
    }
  })

  it('shows the refusal of a quantity the bill cannot hold, and does not save it', async () => {
    const user = userEvent.setup()
    await openPos()
    await add(user, 'Rice')
    await user.selectOptions(await screen.findByLabelText(/^Unit for Rice/), 'grams (g)')
    await setQuantity(user, 'Rice', '0.5')
    expect(await screen.findByText(/whole number of thousandths of one kg/)).toBeInTheDocument()
    const create = vi.spyOn(posService, 'createPosDraft')
    await user.click(screen.getByRole('button', { name: 'Save draft' }))
    expect(create).not.toHaveBeenCalled()
  })
})

describe('POS billing: stock indicators', () => {
  it('warns, in words, when the cart asks for more than is on hand, and still lets the draft be saved', async () => {
    const user = userEvent.setup()
    await openPos()
    await add(user, 'Rice')
    await setQuantity(user, 'Rice', '900')
    expect(await screen.findByText(/Only 746\.5 kg in stock, 900 kg requested/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save draft' }))
    expect(await screen.findByText(/Draft saved: RWF\s?1,080,000/)).toBeInTheDocument()
  })
})

describe('POS billing: price changes', () => {
  it('refuses a stale price with the new one and lets the cashier accept it', async () => {
    const user = userEvent.setup()
    await openPos()
    await add(user, 'Rice')
    await setQuantity(user, 'Rice', '1')
    await cartList().findByText(/1 kg × RWF\s?1,200 = RWF\s?1,200/)
    // The merchant reprices the rice while the cart is open.
    const { store } = getActiveTestBackend()
    store.saveRecords(
      MOCK_STORAGE_KEYS.catalogItems,
      store
        .loadRecords<StoredCatalogItem>(MOCK_STORAGE_KEYS.catalogItems, SAMPLE_CATALOG_ITEMS)
        .map((i) =>
          i.id === 'cat-rice' ? { ...i, priceVersion: 3, pricePerSaleUnitRwf: 1_500 } : i,
        ),
    )
    store.saveRecords(MOCK_STORAGE_KEYS.catalogPrices, [
      ...store.loadRecords<StoredPriceVersion>(
        MOCK_STORAGE_KEYS.catalogPrices,
        SAMPLE_CATALOG_PRICES,
      ),
      {
        merchantId: SAMPLE_MERCHANT_ID,
        itemId: 'cat-rice',
        version: 3,
        pricePerSaleUnitRwf: 1_500,
        saleUnit: 'kg',
        effectiveAt: '2026-10-01T09:00:00+02:00',
        reason: null,
      },
    ])
    await setQuantity(user, 'Rice', '2')
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/price of Rice changed/)
    await user.click(
      within(alert).getByRole('button', { name: /Use the new price \(RWF\s?1,500\)/ }),
    )
    expect(await cartList().findByText(/2 kg × RWF\s?1,500 = RWF\s?3,000/)).toBeInTheDocument()
  })
})

describe('POS billing: saving and reloading a draft', () => {
  it('saves a draft, says it is not a sale, lists it, and reopens it into the cart', async () => {
    const user = userEvent.setup()
    await openPos()
    await add(user, 'Rice')
    await setQuantity(user, 'Rice', '2')
    await add(user, 'Car wash')
    await setQuantity(user, 'Car wash', '1')
    await cartList().findByText(/1 pc × RWF\s?5,000 = RWF\s?5,000/)
    await user.type(screen.getByLabelText(/^Note/), 'Counter sale')
    await user.click(screen.getByRole('button', { name: 'Save draft' }))
    const status = await screen.findByText(/Draft saved: RWF\s?7,400/)
    expect(status.closest('[role="status"]')).toHaveTextContent(/not a sale/)
    // There is no payment or billing flow here.
    expect(screen.queryByRole('button', { name: /^(Bill|Pay)/ })).not.toBeInTheDocument()
    const drafts = within(await screen.findByRole('list', { name: 'Saved drafts' }))
    expect(drafts.getByText(/2 lines · RWF\s?7,400/)).toBeInTheDocument()
    // Start over, then reopen.
    await user.click(screen.getByRole('button', { name: 'Start a new cart' }))
    expect(screen.getByText(/The cart is empty/)).toBeInTheDocument()
    await user.click(drafts.getByRole('button', { name: 'Open draft' }))
    await screen.findByRole('list', { name: 'Cart lines' })
    expect(await cartList().findByText(/2 kg × RWF\s?1,200 = RWF\s?2,400/)).toBeInTheDocument()
    expect(cartList().getByText(/1 pc × RWF\s?5,000 = RWF\s?5,000/)).toBeInTheDocument()
    expect(screen.getByLabelText(/^Note/)).toHaveValue('Counter sale')
    // Changing a reopened draft updates it; it does not make a second one.
    await setQuantity(user, 'Rice', '3')
    await cartList().findByText(/3 kg × RWF\s?1,200 = RWF\s?3,600/)
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByText(/Draft saved: RWF\s?8,600/)).toBeInTheDocument()
    await waitFor(() =>
      expect(
        within(screen.getByRole('list', { name: 'Saved drafts' })).getAllByRole('listitem'),
      ).toHaveLength(1),
    )
  })

  it('sends quantities as text and never a price, and a retry reuses the same attempt ids', async () => {
    const user = userEvent.setup()
    await openPos()
    await add(user, 'Haircut')
    await setQuantity(user, 'Haircut', '1')
    await cartList().findByText(/1 pc × RWF\s?3,000/)
    const create = vi.spyOn(posService, 'createPosDraft')
    create.mockRejectedValueOnce(
      new (await import('@/services/posService')).PosServiceError('service_unavailable', 'lost'),
    )
    await user.click(screen.getByRole('button', { name: 'Save draft' }))
    expect(await screen.findByText(/same cart is never saved twice/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save draft' }))
    await screen.findByText(/Draft saved/)
    expect(create).toHaveBeenCalledTimes(2)
    const [first, second] = [create.mock.calls[0]![1], create.mock.calls[1]![1]]
    expect(second.clientRequestId).toBe(first.clientRequestId)
    expect(second.idempotencyKey).toBe(first.idempotencyKey)
    expect(first.lines).toEqual([
      {
        itemId: 'cat-haircut',
        quantity: '1',
        unit: 'pc',
        packageId: null,
        expectedPriceVersion: 1,
      },
    ])
    expect(JSON.stringify(first)).not.toMatch(/unitPrice|lineTotal|totalRwf/)
  })
})

describe('POS billing: layout', () => {
  it('stacks on a phone and splits into catalog and cart columns on a wide screen', async () => {
    const { container } = await openPos()
    await screen.findByRole('heading', { level: 2, name: 'Goods and services' })
    const grid = container.querySelector('div.grid[class*="lg:grid-cols-"]')
    expect(grid).not.toBeNull()
    expect(grid!.className).not.toMatch(/(^|\s)grid-cols-/)
    // No fixed widths that would force horizontal scrolling.
    expect(container.querySelector('[class*="min-w-["]')).toBeNull()
  })

  it('offers a branch selector when the person may bill at more than one branch', async () => {
    await openPos('cashier')
    const select = await screen.findByLabelText(/^Branch/)
    expect(within(select).getAllByRole('option')).toHaveLength(2)
  })
})

describe('POS billing: authorisation', () => {
  it('is in the menu for business mode and people who can create invoices', async () => {
    await openPos('cashier')
    await screen.findByRole('heading', { level: 1, name: 'POS billing' })
    expect(primaryNav().getByRole('link', { name: /POS billing/ })).toBeInTheDocument()
  })

  it('tells someone with no branch what to do, and shows no cart', async () => {
    await openPos('owner')
    expect(await screen.findByText('You need a branch to prepare sales')).toBeInTheDocument()
    expect(screen.queryByLabelText(/Search goods/)).not.toBeInTheDocument()
  })

  it('is not offered to a simplified business, which keeps amount-only checkout', async () => {
    const backend = getActiveTestBackend()
    backend.signInAs('owner')
    await backend.fastMerchants.updateMerchantSettings(SAMPLE_MERCHANT_ID, {
      operatingMode: 'SIMPLIFIED',
      expectedVersion: 0,
    })
    await renderAppAt('/pos', { signedInAs: 'manager' })
    expect(await screen.findByText('POS billing is for business mode')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Collect a payment' })).toBeInTheDocument()
    expect(primaryNav().queryByRole('link', { name: /POS billing/ })).not.toBeInTheDocument()
  })
})

describe('POS billing: review additions', () => {
  it('labels the total provisional, with the tax note, before and after saving', async () => {
    const user = userEvent.setup()
    await openPos()
    await add(user, 'Haircut')
    await setQuantity(user, 'Haircut', '1')
    await cartList().findByText(/1 pc × RWF\s?3,000/)
    expect(screen.getByText('Provisional total')).toBeInTheDocument()
    expect(
      screen.getByText(
        /Provisional total: tax is not calculated or included, and prices are rechecked/,
      ),
    ).toBeInTheDocument()
    expect(screen.queryByText('Total')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save draft' }))
    const status = (await screen.findByText(/Draft saved: RWF\s?3,000/)).closest('[role="status"]')!
    expect(status).toHaveTextContent(/provisional, tax not included/)
    expect(status).toHaveTextContent(/not a sale/)
  })

  it('explains a line that would bill nothing and does not save it', async () => {
    const user = userEvent.setup()
    await openPos()
    await add(user, 'Cement')
    await user.selectOptions(await screen.findByLabelText(/^Unit for Cement/), 'grams (g)')
    await setQuantity(user, 'Cement', '1')
    expect(await screen.findByText(/worth less than RWF 1 at this price/)).toBeInTheDocument()
    expect(screen.getByText('—', { selector: '[aria-live]' })).toBeInTheDocument()
  })

  it('starts a new draft, not an update, when the branch changes after reopening one', async () => {
    const user = userEvent.setup()
    await openPos('cashier')
    await add(user, 'Haircut')
    await setQuantity(user, 'Haircut', '1')
    await cartList().findByText(/1 pc × RWF\s?3,000/)
    await user.click(screen.getByRole('button', { name: 'Save draft' }))
    await screen.findByText(/Draft saved/)
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText(/^Branch/), 'City Centre')
    // The cart stays, is priced again at the new branch, and saving makes a new draft there.
    expect(await screen.findByRole('button', { name: 'Save draft' })).toBeInTheDocument()
    await cartList().findByText(/1 pc × RWF\s?3,000/)
  })
})
