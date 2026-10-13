import { z } from 'zod'
import { emailField } from '@/features/merchants/merchantSchemas'
import type { InviteStaffInput } from '@/types/staff'

export const inviteStaffSchema = z.object({
  email: emailField,
  role: z.enum(['MANAGER', 'CASHIER'], { error: 'Choose a role.' }),
  branchIds: z.array(z.string()),
  note: z.string().trim().max(200, 'Use 200 characters or fewer.'),
})

export type InviteStaffFormValues = z.infer<typeof inviteStaffSchema>

export const toInviteStaffInput = (values: InviteStaffFormValues): InviteStaffInput => ({
  email: values.email,
  role: values.role,
  branchIds: values.branchIds,
  note: values.note || undefined,
})
