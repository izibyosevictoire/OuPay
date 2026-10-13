import { z } from 'zod'
import {
  isRwandanPhoneNumber,
  normalizeRwandanPhoneNumber,
  validateLocationRules,
} from '@/features/merchants/merchantSchemas'
import type { Branch, CreateBranchInput, UpdateBranchInput } from '@/types/branch'

export const BRANCH_CODE_HINT =
  'Short and unique in your business, e.g. RM01. Letters, numbers and hyphens.'

export const branchFormSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, 'Branch name is required.')
      .max(80, 'Use 80 characters or fewer.'),
    code: z
      .string()
      .trim()
      .min(1, 'Branch code is required.')
      .regex(/^[A-Za-z0-9-]{2,12}$/, 'Use 2 to 12 letters, numbers or hyphens.'),
    province: z.string().min(1, 'Choose a province.'),
    district: z.string().min(1, 'Choose a district.'),
    sector: z.string().trim().min(1, 'Sector is required.').max(60, 'Use 60 characters or fewer.'),
    physicalAddress: z
      .string()
      .trim()
      .min(1, 'Physical address is required.')
      .max(200, 'Use 200 characters or fewer.'),
    contactPhone: z
      .string()
      .trim()
      .refine((value) => value === '' || isRwandanPhoneNumber(value), {
        message: 'Enter a Rwandan mobile number, like 0788 123 456, or leave this blank.',
      }),
    status: z.enum(['ACTIVE', 'INACTIVE']),
  })
  .superRefine(validateLocationRules)

export type BranchFormValues = z.infer<typeof branchFormSchema>

export const BRANCH_FORM_DEFAULTS: BranchFormValues = {
  name: '',
  code: '',
  province: '',
  district: '',
  sector: '',
  physicalAddress: '',
  contactPhone: '',
  status: 'ACTIVE',
}

export const branchToFormValues = (branch: Branch): BranchFormValues => ({
  name: branch.name,
  code: branch.code,
  province: branch.location.province,
  district: branch.location.district,
  sector: branch.location.sector,
  physicalAddress: branch.location.physicalAddress,
  contactPhone: branch.contactPhone ?? '',
  status: branch.status,
})

const toUpdateInput = (values: BranchFormValues): UpdateBranchInput => ({
  name: values.name,
  code: values.code.toUpperCase(),
  location: {
    province: values.province,
    district: values.district,
    sector: values.sector,
    physicalAddress: values.physicalAddress,
  },
  contactPhone: values.contactPhone ? normalizeRwandanPhoneNumber(values.contactPhone) : undefined,
})

export const toCreateBranchInput = (values: BranchFormValues): CreateBranchInput => ({
  ...toUpdateInput(values),
  status: values.status,
})
export const toUpdateBranchInput = toUpdateInput
