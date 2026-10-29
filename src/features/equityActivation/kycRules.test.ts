import { DEMO_KYC_REQUIREMENT_SET } from '@/constants/kycRequirements'
import type { KycAnswer, KycApplication } from '@/types/kyc'
import {
  applies,
  describeKycStatus,
  fieldProblem,
  maskedHint,
  missingRequired,
  valuesOf,
} from './kycRules'

const definition = DEMO_KYC_REQUIREMENT_SET.definition
const field = (key: string) => definition.fields.find((f) => f.key === key)!

const answer = (key: string, value: string | null, extra: Partial<KycAnswer> = {}): KycAnswer => ({
  key,
  sensitive: false,
  value,
  hasValue: true,
  hint: null,
  source: 'OWNER',
  ...extra,
})

const application = (answers: KycAnswer[]) => ({ answers }) as unknown as KycApplication

describe('fieldProblem', () => {
  it.each([
    ['business.contactEmail', 'nope'],
    ['business.contactPhone', 'abc'],
    ['business.tin', '12345'],
    ['bank.hasEquityAccount', 'MAYBE'],
    ['business.legalName', 'x'.repeat(201)],
    ['business.legalName', 'two\nlines'],
    ['representative.idNumber', '<>'],
  ])('refuses %s = %j without repeating the value', (key, value) => {
    const problem = fieldProblem(field(key), value)
    expect(problem).toBeTruthy()
    expect(problem).not.toContain(value.trim())
  })

  it.each([
    ['business.contactEmail', 'a@b.rw'],
    ['business.contactPhone', '+250 788 123 456'],
    ['business.tin', '123456789'],
    ['bank.hasEquityAccount', 'NOT_SURE'],
    ['representative.idNumber', '1199 8800-1234'],
    ['business.legalName', '   '],
  ])('accepts %s = %j', (key, value) => {
    expect(fieldProblem(field(key), value)).toBeNull()
  })
})

describe('conditions and completeness', () => {
  it('shows the registration number only for registered businesses, and the account number only when there is an account', () => {
    const reg = field('business.registrationNumber').appliesWhen
    expect(applies(reg, { 'business.type': 'registered_company' })).toBe(true)
    expect(applies(reg, { 'business.type': 'sole_proprietor' })).toBe(false)
    expect(applies(reg, {})).toBe(false)
    expect(applies(null, {})).toBe(true)
    expect(
      applies(field('bank.accountReference').appliesWhen, { 'bank.hasEquityAccount': 'YES' }),
    ).toBe(true)
  })

  it('lists what is still required, counts a saved protected value as given, and layers unsaved edits on top', () => {
    const saved = application([
      answer('business.legalName', 'Shop'),
      answer('business.type', 'sole_proprietor'),
      answer('representative.idNumber', null, { sensitive: true, hint: '••••5678' }),
    ])
    const missing = missingRequired(definition, saved)
    expect(missing).toContain('business.physicalAddress')
    expect(missing).not.toContain('business.registrationNumber')
    expect(missing).not.toContain('representative.idNumber')
    expect(
      missingRequired(definition, saved, { 'business.physicalAddress': 'KG 1 Ave' }),
    ).not.toContain('business.physicalAddress')
    expect(valuesOf(saved.answers, { 'business.legalName': ' ' })).not.toHaveProperty(
      'business.legalName',
    )
  })
})

describe('honest status wording', () => {
  it('never says Equity has received or approved anything for a draft or a submission to OuPay', () => {
    const draft = describeKycStatus('DRAFT')
    const collected = describeKycStatus('COLLECTED')
    expect(draft.explanation).toMatch(/Nothing has been submitted/)
    expect(collected.label).toBe('Submitted to OuPay')
    expect(collected.explanation).toMatch(/has not been sent to Equity/)
    expect(collected.explanation).toMatch(/has not received, reviewed or approved/)
    for (const wording of [draft, collected]) {
      expect(`${wording.label} ${wording.explanation}`).not.toMatch(
        /approved by Equity|handed to Equity/i,
      )
    }
  })

  it('words the bank states as RECORDED evidence, with a rejection reason kept', () => {
    expect(describeKycStatus('HANDED_OFF').explanation).toMatch(/recorded evidence/)
    expect(describeKycStatus('APPROVED').explanation).toMatch(/recorded evidence/)
    expect(describeKycStatus('REJECTED', 'Incomplete documents').explanation).toContain(
      'Incomplete documents',
    )
    expect(describeKycStatus('MORE_INFO_REQUESTED').tone).toBe('warning')
    expect(describeKycStatus('REJECTED').tone).toBe('danger')
  })

  it('masks a protected value to its last four characters', () => {
    expect(maskedHint('1199880012345678')).toBe('••••5678')
  })
})
