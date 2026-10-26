import {
  formatExactDecimal,
  integralDigits,
  parseExactDecimal,
  shiftDecimalPoint,
} from './exactDecimal'

const shifted = (text: string, places: number) =>
  formatExactDecimal(shiftDecimalPoint(parseExactDecimal(text)!, places))

describe('exact decimal arithmetic', () => {
  it('parses plain decimal text and normalises it', () => {
    expect(formatExactDecimal(parseExactDecimal('1.500000')!)).toBe('1.5')
    expect(formatExactDecimal(parseExactDecimal('0.000')!)).toBe('0')
    expect(formatExactDecimal(parseExactDecimal('-007.10')!)).toBe('-7.1')
    expect(parseExactDecimal('1')).toEqual(parseExactDecimal('1.000000'))
  })

  it.each([
    '',
    ' ',
    'NaN',
    'Infinity',
    '1e3',
    '+1',
    '1,5',
    '.5',
    '5.',
    '--1',
    '1.2.3',
    '0x10',
    'abc',
  ])('rejects %j', (text) => expect(parseExactDecimal(text)).toBeNull())

  it('moves the decimal point exactly, with no floating-point error', () => {
    expect(shifted('2.5', 3)).toBe('2500')
    expect(shifted('750', -3)).toBe('0.75')
    expect(shifted('0.1', 3)).toBe('100')
    expect(shifted('0.000001', -3)).toBe('0.000000001')
    expect(shifted('0.000000001', 3)).toBe('0.000001')
    expect(shifted('1.5', 6)).toBe('1500000')
  })

  it('counts digits before the decimal point', () => {
    expect(integralDigits(parseExactDecimal('99999999999999.999999')!)).toBe(14)
    expect(integralDigits(parseExactDecimal('100000000000000')!)).toBe(15)
    expect(integralDigits(parseExactDecimal('0.5')!)).toBe(0)
    expect(integralDigits(parseExactDecimal('0')!)).toBe(0)
  })
})
