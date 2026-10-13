import {
  businessDetailsSchema,
  contactSchema,
  locationSchema,
  normalizeRwandanPhoneNumber,
  ONBOARDING_DEFAULT_VALUES,
  profileEditSchema,
  toCreateMerchantInput,
} from './merchantSchemas'

const firstMessage = (result: { success: boolean; error?: { issues: { message: string }[] } }) =>
  result.error?.issues[0]?.message

describe('business details validation', () => {
  const company = { legalName: 'Kivu Ltd', tradingName: '', businessType: 'registered_company' }

  it('requires a registration number for registered companies', () => {
    const result = businessDetailsSchema.safeParse({ ...company, registrationNumber: '', tin: '' })
    expect(firstMessage(result)).toBe('Registration number is required for this business type.')
  })

  it('does not require registration or TIN for informal vendors', () => {
    const result = businessDetailsSchema.safeParse({
      legalName: 'Mama Jane Fruits',
      tradingName: '',
      businessType: 'informal_vendor',
      registrationNumber: '',
      tin: '',
    })
    expect(result.success).toBe(true)
  })

  it('rejects a TIN that is not 9 digits', () => {
    const result = businessDetailsSchema.safeParse({
      ...company,
      registrationNumber: 'RDB-1',
      tin: '12345',
    })
    expect(firstMessage(result)).toBe('A TIN has exactly 9 digits.')
  })

  it('requires a legal name and a business type', () => {
    const result = businessDetailsSchema.safeParse({
      legalName: '  ',
      tradingName: '',
      businessType: undefined,
      registrationNumber: '',
      tin: '',
    })
    expect(result.success).toBe(false)
  })
})

describe('location validation', () => {
  const valid = {
    country: 'RW',
    province: 'Kigali City',
    district: 'Gasabo',
    sector: 'Remera',
    physicalAddress: 'KG 11 Ave',
  }

  it('accepts a consistent province, district and sector', () => {
    expect(locationSchema.safeParse(valid).success).toBe(true)
  })

  it('rejects a district outside the chosen province', () => {
    const result = locationSchema.safeParse({ ...valid, district: 'Huye' })
    expect(firstMessage(result)).toBe('Choose a district in the selected province.')
  })

  it('rejects a sector outside a district with a known sector list', () => {
    const result = locationSchema.safeParse({ ...valid, sector: 'Nyamirambo' })
    expect(firstMessage(result)).toBe('Choose a sector in the selected district.')
  })

  it('accepts free-text sectors for districts without a bundled list', () => {
    const result = locationSchema.safeParse({
      ...valid,
      province: 'Southern Province',
      district: 'Huye',
      sector: 'Ngoma',
    })
    expect(result.success).toBe(true)
  })
})

describe('contact validation and phone normalisation', () => {
  it.each(['0788123456', '+250788123456', '250 788 123 456', '0722-123-456'])(
    'accepts Rwandan number %s',
    (phoneNumber) => {
      expect(
        contactSchema.safeParse({ contactName: 'A B', email: 'a@b.rw', phoneNumber }).success,
      ).toBe(true)
    },
  )

  it.each(['0688123456', '12345', '+254712345678', 'abc'])('rejects %s', (phoneNumber) => {
    expect(
      contactSchema.safeParse({ contactName: 'A B', email: 'a@b.rw', phoneNumber }).success,
    ).toBe(false)
  })

  it('rejects malformed email addresses', () => {
    const result = contactSchema.safeParse({
      contactName: 'A B',
      email: 'not-an-email',
      phoneNumber: '0788123456',
    })
    expect(firstMessage(result)).toMatch(/valid email/)
  })

  it('normalises every accepted format to +250', () => {
    expect(normalizeRwandanPhoneNumber('0788 123 456')).toBe('+250788123456')
    expect(normalizeRwandanPhoneNumber('250788123456')).toBe('+250788123456')
  })
})

describe('mapping to domain input', () => {
  it('turns blank optional fields into undefined and normalises the phone number', () => {
    const input = toCreateMerchantInput({
      ...ONBOARDING_DEFAULT_VALUES,
      legalName: 'Mama Jane Fruits',
      businessType: 'informal_vendor',
      province: 'Kigali City',
      district: 'Gasabo',
      sector: 'Remera',
      physicalAddress: 'Remera market',
      contactName: 'Jane',
      email: 'jane@example.rw',
      phoneNumber: '0788 123 456',
    })
    expect(input.tradingName).toBeUndefined()
    expect(input.registration).toEqual({ registrationNumber: undefined, tin: undefined })
    expect(input.contact.phoneNumber).toBe('+250788123456')
  })
})

describe('profile edit validation', () => {
  it('requires address and contact details', () => {
    const result = profileEditSchema.safeParse({
      tradingName: '',
      physicalAddress: '',
      contactName: '',
      email: '',
      phoneNumber: '',
    })
    expect(result.success).toBe(false)
  })
})
