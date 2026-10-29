import { formatStockChange, formatStockQuantity, groupDecimalText } from './formatStockQuantity'

describe('stock quantity formatting', () => {
  it('groups digits of exact decimal text without rounding', () => {
    expect(groupDecimalText('0')).toBe('0')
    expect(groupDecimalText('497000')).toBe('497,000')
    expect(groupDecimalText('1234.567')).toBe('1,234.567')
    expect(groupDecimalText('99999999999999.999999')).toBe('99,999,999,999,999.999999')
    expect(groupDecimalText('-3500')).toBe('-3,500')
    expect(groupDecimalText('0.000001')).toBe('0.000001')
  })

  it('leaves text that is not plain decimal alone', () => {
    expect(groupDecimalText('1e3')).toBe('1e3')
    expect(groupDecimalText('')).toBe('')
  })

  it('adds the unit symbol and shows the sign of a change', () => {
    expect(formatStockQuantity('497000', 'g')).toBe('497,000 g')
    expect(formatStockQuantity('25000000', 'mm2')).toBe('25,000,000 mm²')
    expect(formatStockChange('250', 'ml')).toBe('+250 mL')
    expect(formatStockChange('-3500', 'g')).toBe('-3,500 g')
  })
})
