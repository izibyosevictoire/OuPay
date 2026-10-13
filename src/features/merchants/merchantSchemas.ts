import { z } from 'zod'
import { BUSINESS_TYPES, BUSINESS_TYPES_REQUIRING_REGISTRATION } from '@/constants/merchant'
import {
  getDistrictsForProvince,
  getSectorsForDistrict,
  RWANDA_PROVINCES,
} from '@/constants/rwandaGeography'
import type { CreateMerchantInput, UpdateMerchantInput } from '@/types/merchant'

const RWANDAN_PHONE_PATTERN = /^(?:\+?250|0)(7[2389]\d{7})$/
const TIN_PATTERN = /^\d{9}$/

const requiredText = (label: string, maxLength = 120) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required.`)
    .max(maxLength, `${label} must be ${maxLength} characters or fewer.`)

const optionalText = (maxLength = 120) =>
  z.string().trim().max(maxLength, `Must be ${maxLength} characters or fewer.`)

export const emailField = z
  .string()
  .trim()
  .min(1, 'Email address is required.')
  .pipe(z.email('Enter a valid email address, like name@example.com.'))

export const phoneField = z
  .string()
  .trim()
  .min(1, 'Phone number is required.')
  .refine((value) => RWANDAN_PHONE_PATTERN.test(value.replace(/[\s-]/g, '')), {
    message: 'Enter a Rwandan mobile number, like 0788 123 456 or +250 788 123 456.',
  })

export const isRwandanPhoneNumber = (value: string) =>
  RWANDAN_PHONE_PATTERN.test(value.replace(/[s-]/g, ''))

/** Converts any accepted Rwandan phone format to +250XXXXXXXXX. */
export function normalizeRwandanPhoneNumber(input: string): string {
  const match = RWANDAN_PHONE_PATTERN.exec(input.replace(/[\s-]/g, ''))
  return match ? `+250${match[1]}` : input
}

const businessDetailsShape = {
  legalName: requiredText('Legal business name'),
  tradingName: optionalText(),
  businessType: z.enum(BUSINESS_TYPES, {
    error: 'Choose the type that best describes the business.',
  }),
  registrationNumber: optionalText(40),
  tin: optionalText(9),
}

const locationShape = {
  country: z.literal('RW'),
  province: z
    .string()
    .min(1, 'Choose a province.')
    .refine(
      (value) => RWANDA_PROVINCES.some((province) => province.name === value),
      'Choose a province from the list.',
    ),
  district: z.string().min(1, 'Choose a district.'),
  sector: requiredText('Sector', 60),
  physicalAddress: requiredText('Physical address', 200),
}

const contactShape = {
  contactName: requiredText('Contact name'),
  email: emailField,
  phoneNumber: phoneField,
}

type BusinessDetailsFields = { businessType?: string; registrationNumber?: string; tin?: string }

/** Registration is required only for types that are formally registered; TIN is always optional. */
function validateRegistrationRules(values: BusinessDetailsFields, context: z.RefinementCtx) {
  const needsRegistration = BUSINESS_TYPES_REQUIRING_REGISTRATION.some(
    (type) => type === values.businessType,
  )
  if (needsRegistration && !values.registrationNumber) {
    context.addIssue({
      code: 'custom',
      path: ['registrationNumber'],
      message: 'Registration number is required for this business type.',
    })
  }
  if (values.tin && !TIN_PATTERN.test(values.tin)) {
    context.addIssue({
      code: 'custom',
      path: ['tin'],
      message: 'A TIN has exactly 9 digits.',
    })
  }
}

export function validateLocationRules(
  values: { province?: string; district?: string; sector?: string },
  context: z.RefinementCtx,
) {
  const districts = getDistrictsForProvince(values.province ?? '')
  if (values.district && !districts.includes(values.district)) {
    context.addIssue({
      code: 'custom',
      path: ['district'],
      message: 'Choose a district in the selected province.',
    })
  }
  const knownSectors = getSectorsForDistrict(values.district ?? '')
  if (knownSectors && values.sector && !knownSectors.includes(values.sector)) {
    context.addIssue({
      code: 'custom',
      path: ['sector'],
      message: 'Choose a sector in the selected district.',
    })
  }
}

export const businessDetailsSchema = z
  .object(businessDetailsShape)
  .superRefine(validateRegistrationRules)
export const locationSchema = z.object(locationShape).superRefine(validateLocationRules)
export const contactSchema = z.object(contactShape)

/** Whole form, validated by the resolver. Steps validate only their own fields via `trigger`. */
export const onboardingSchema = z
  .object({ ...businessDetailsShape, ...locationShape, ...contactShape })
  .superRefine((values, context) => {
    validateRegistrationRules(values, context)
    validateLocationRules(values, context)
  })

export type OnboardingFormValues = z.infer<typeof onboardingSchema>

export const ONBOARDING_STEP_FIELDS = [
  ['legalName', 'tradingName', 'businessType', 'registrationNumber', 'tin'],
  ['country', 'province', 'district', 'sector', 'physicalAddress'],
  ['contactName', 'email', 'phoneNumber'],
] as const satisfies readonly (readonly (keyof OnboardingFormValues)[])[]

export const ONBOARDING_DEFAULT_VALUES: OnboardingFormValues = {
  legalName: '',
  tradingName: '',
  businessType: undefined as unknown as OnboardingFormValues['businessType'],
  registrationNumber: '',
  tin: '',
  country: 'RW',
  province: '',
  district: '',
  sector: '',
  physicalAddress: '',
  contactName: '',
  email: '',
  phoneNumber: '',
}

const emptyToUndefined = (value: string) => (value === '' ? undefined : value)

export function toCreateMerchantInput(values: OnboardingFormValues): CreateMerchantInput {
  return {
    legalName: values.legalName,
    tradingName: emptyToUndefined(values.tradingName),
    businessType: values.businessType,
    registration: {
      registrationNumber: emptyToUndefined(values.registrationNumber),
      tin: emptyToUndefined(values.tin),
    },
    location: {
      country: values.country,
      province: values.province,
      district: values.district,
      sector: values.sector,
      physicalAddress: values.physicalAddress,
    },
    contact: {
      fullName: values.contactName,
      email: values.email,
      phoneNumber: normalizeRwandanPhoneNumber(values.phoneNumber),
    },
  }
}

/** Profile editing: only the fields a merchant may change after registering. */
export const profileEditSchema = z.object({
  tradingName: optionalText(),
  physicalAddress: requiredText('Physical address', 200),
  contactName: contactShape.contactName,
  email: emailField,
  phoneNumber: phoneField,
})

export type ProfileEditFormValues = z.infer<typeof profileEditSchema>

export function toUpdateMerchantInput(values: ProfileEditFormValues): UpdateMerchantInput {
  return {
    tradingName: emptyToUndefined(values.tradingName),
    physicalAddress: values.physicalAddress,
    contact: {
      fullName: values.contactName,
      email: values.email,
      phoneNumber: normalizeRwandanPhoneNumber(values.phoneNumber),
    },
  }
}
