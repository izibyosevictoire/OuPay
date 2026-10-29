import type { PosCatalogItem, PosProblem } from '@/types/pos'
import {
  acceptCurrentPrice,
  describeStockCheck,
  describeStockInfo,
  friendlyQuantity,
  packageChoice,
  payloadKeyOf,
  pricedLineFor,
  quantityProblem,
  toLineInput,
  type CartLine,
} from './posRules'
import { attemptFor } from './posSession'

const item = (over: Partial<PosCatalogItem> = {}): PosCatalogItem => ({
  itemId: 'item-1',
  itemType: 'GOODS',
  name: 'Rice',
  code: 'RICE',
  measurementDimension: 'MASS',
  saleUnit: 'kg',
  units: ['g', 'kg'],
  pricePerSaleUnitRwf: 1200,
  priceVersion: 4,
  packages: [],
  stock: { state: 'RECORDED', onHand: '12500', canonicalUnit: 'g', onHandInSaleUnit: '12.5' },
  ...over,
})
const cartLine = (over: Partial<CartLine> = {}): CartLine => ({
  key: 'k',
  item: item(),
  quantity: '2',
  choice: 'kg',
  ...over,
})

describe('POS rules', () => {
  it('sends the quantity as text with a unit or a package, the price VERSION seen, and never a price', () => {
    expect(toLineInput(cartLine({ quantity: ' 2.50 ' }))).toEqual({
      itemId: 'item-1',
      quantity: '2.50',
      unit: 'kg',
      packageId: null,
      expectedPriceVersion: 4,
    })
    expect(toLineInput(cartLine({ choice: packageChoice('pkg-9') }))).toEqual({
      itemId: 'item-1',
      quantity: '2',
      unit: null,
      packageId: 'pkg-9',
      expectedPriceVersion: 4,
    })
  })

  it('gives quick feedback on a quantity and leaves the real decision to the server', () => {
    expect(quantityProblem(cartLine({ quantity: '2.5' }))).toBeNull()
    expect(quantityProblem(cartLine({ quantity: '' }))).toBe('Enter a quantity.')
    for (const bad of ['abc', '-1', '1e3', '1,5', '1.', '.5', '+2', 'NaN']) {
      expect(quantityProblem(cartLine({ quantity: bad }))).toMatch(/Enter the quantity as a number/)
    }
    expect(quantityProblem(cartLine({ quantity: '0' }))).toMatch(/more than zero/)
    expect(quantityProblem(cartLine({ quantity: '0.000' }))).toMatch(/more than zero/)
    expect(quantityProblem(cartLine({ quantity: '1.5', choice: packageChoice('p') }))).toMatch(
      /whole number of packages/,
    )
    expect(
      quantityProblem(
        cartLine({
          quantity: '1.5',
          item: item({ measurementDimension: 'COUNT', saleUnit: 'pc' }),
          choice: 'pc',
        }),
      ),
    ).toMatch(/whole numbers/)
    // Many decimals are the server's call (it explains, it never rounds).
    expect(quantityProblem(cartLine({ quantity: '0.0005' }))).toBeNull()
  })

  it('shows exact quantities in the larger unit once they reach one of it', () => {
    expect(friendlyQuantity('12500', 'g')).toBe('12.5 kg')
    expect(friendlyQuantity('999', 'g')).toBe('999 g')
    expect(friendlyQuantity('1000', 'ml')).toBe('1 l')
    expect(friendlyQuantity('1500000', 'mm2')).toBe('1.5 m²')
    expect(friendlyQuantity('7', 'pc')).toBe('7 pc')
    expect(friendlyQuantity(null, 'g')).toBe('—')
  })

  it('describes stock in words, and warns for missing or short stock', () => {
    expect(describeStockInfo(item().stock)).toEqual({ tone: 'ok', text: '12.5 kg in stock' })
    expect(
      describeStockInfo({
        state: 'NO_RECORD',
        onHand: '0',
        canonicalUnit: 'g',
        onHandInSaleUnit: '0',
      }).tone,
    ).toBe('warning')
    expect(
      describeStockInfo({
        state: 'NOT_TRACKED',
        onHand: null,
        canonicalUnit: 'pc',
        onHandInSaleUnit: null,
      }).text,
    ).toBe('Service: no stock needed')
    expect(
      describeStockCheck({
        state: 'INSUFFICIENT',
        onHand: '10000',
        requested: '20000',
        canonicalUnit: 'g',
      }),
    ).toEqual({
      tone: 'warning',
      text: 'Only 10 kg in stock, 20 kg requested',
    })
    expect(
      describeStockCheck({
        state: 'NO_STOCK_RECORD',
        onHand: '0',
        requested: '500',
        canonicalUnit: 'g',
      }).tone,
    ).toBe('warning')
    expect(
      describeStockCheck({
        state: 'SUFFICIENT',
        onHand: '900',
        requested: '500',
        canonicalUnit: 'g',
      }).tone,
    ).toBe('ok')
  })

  it('matches priced lines to cart lines when some lines have problems', () => {
    const priced = [{ lineNo: 1 }, { lineNo: 2 }] as never[]
    const problems = [{ lineIndex: 1 }] as PosProblem[]
    expect(pricedLineFor(priced, problems, 0)).toBe(priced[0])
    expect(pricedLineFor(priced, problems, 1)).toBeUndefined()
    expect(pricedLineFor(priced, problems, 2)).toBe(priced[1])
  })

  it('accepts the current price only when the server reported one', () => {
    const problem = {
      lineIndex: 0,
      code: 'price_changed',
      message: '',
      currentPriceVersion: 5,
      currentPriceRwf: 1500,
    }
    const accepted = acceptCurrentPrice(cartLine(), problem)
    expect(accepted.item).toMatchObject({ priceVersion: 5, pricePerSaleUnitRwf: 1500 })
    expect(acceptCurrentPrice(cartLine(), { ...problem, currentPriceVersion: null })).toEqual(
      cartLine(),
    )
  })

  it('keeps the same attempt ids for the same cart and new ones for a different cart', () => {
    const memory = new Map<string, string>()
    const storage = {
      getItem: (k: string) => memory.get(k) ?? null,
      setItem: (k: string, v: string) => void memory.set(k, v),
      removeItem: (k: string) => void memory.delete(k),
    } as unknown as Storage
    const lines = [toLineInput(cartLine())]
    const a = attemptFor('m.u', payloadKeyOf('brn', 'note', lines), storage)
    const b = attemptFor('m.u', payloadKeyOf('brn', ' note ', lines), storage)
    expect(b).toEqual(a)
    const edited = attemptFor(
      'm.u',
      payloadKeyOf('brn', 'note', [toLineInput(cartLine({ quantity: '3' }))]),
      storage,
    )
    expect(edited.clientRequestId).not.toBe(a.clientRequestId)
    expect(edited.idempotencyKey).not.toBe(a.idempotencyKey)
    // Another person on the same tab never continues this attempt.
    expect(
      attemptFor('m.other', payloadKeyOf('brn', 'note', lines), storage).clientRequestId,
    ).not.toBe(edited.clientRequestId)
    // Unavailable storage still works.
    const broken = {
      getItem: () => {
        throw new Error('x')
      },
      setItem: () => {
        throw new Error('x')
      },
    } as unknown as Storage
    expect(attemptFor('m.u', 'k', broken).clientRequestId).toMatch(/^[0-9a-f-]{36}$/)
  })
})
