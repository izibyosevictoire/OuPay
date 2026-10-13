import { z } from 'zod'
import { emailField, phoneField } from '@/features/merchants/merchantSchemas'

const MIN_PASSWORD_LENGTH = 8

const newPasswordField = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters.`)
  .max(128, 'Use 128 characters or fewer.')
  .refine((value) => /[A-Za-z]/.test(value) && /\d/.test(value), {
    message: 'Include at least one letter and one number.',
  })

export const loginSchema = z.object({
  email: emailField,
  // Only presence is checked on sign-in; strength rules apply when choosing a password.
  password: z.string().min(1, 'Enter your password.'),
  rememberMe: z.boolean(),
})
export type LoginFormValues = z.infer<typeof loginSchema>

export const registerSchema = z
  .object({
    fullName: z
      .string()
      .trim()
      .min(2, 'Enter your full name.')
      .max(120, 'Use 120 characters or fewer.'),
    email: emailField,
    phoneNumber: phoneField,
    password: newPasswordField,
    confirmPassword: z.string().min(1, 'Confirm your password.'),
    acceptedTerms: z.boolean().refine((accepted) => accepted, {
      message: 'You must accept the terms to create an account.',
    }),
  })
  .refine((values) => values.password === values.confirmPassword, {
    path: ['confirmPassword'],
    message: 'Passwords do not match.',
  })
export type RegisterFormValues = z.infer<typeof registerSchema>

export const forgotPasswordSchema = z.object({ email: emailField })
export type ForgotPasswordFormValues = z.infer<typeof forgotPasswordSchema>

export const resetPasswordSchema = z
  .object({
    newPassword: newPasswordField,
    confirmPassword: z.string().min(1, 'Confirm your new password.'),
  })
  .refine((values) => values.newPassword === values.confirmPassword, {
    path: ['confirmPassword'],
    message: 'Passwords do not match.',
  })
export type ResetPasswordFormValues = z.infer<typeof resetPasswordSchema>
