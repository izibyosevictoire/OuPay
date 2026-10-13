import {
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
} from './authSchemas'

const validRegistration = {
  fullName: 'Aline Uwase',
  email: 'aline@example.rw',
  phoneNumber: '0788 123 456',
  password: 'Sunrise2026',
  confirmPassword: 'Sunrise2026',
  acceptedTerms: true,
}

const messagesFor = (
  result: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } },
  field: string,
) => result.error?.issues.filter((issue) => issue.path[0] === field).map((i) => i.message) ?? []

describe('login validation', () => {
  it('requires a valid email and a password', () => {
    const result = loginSchema.safeParse({ email: 'nope', password: '', rememberMe: false })
    expect(messagesFor(result, 'email')[0]).toMatch(/valid email/)
    expect(messagesFor(result, 'password')[0]).toBe('Enter your password.')
  })

  it('does not apply password strength rules on sign-in', () => {
    expect(
      loginSchema.safeParse({ email: 'a@b.rw', password: 'x', rememberMe: true }).success,
    ).toBe(true)
  })
})

describe('registration validation', () => {
  it('accepts a complete, valid registration', () => {
    expect(registerSchema.safeParse(validRegistration).success).toBe(true)
  })

  it.each([
    ['fullName', { fullName: ' ' }, 'Enter your full name.'],
    ['email', { email: 'aline@' }, 'Enter a valid email address, like name@example.com.'],
    ['phoneNumber', { phoneNumber: '12345' }, 'Enter a Rwandan mobile number'],
    ['password', { password: 'short1', confirmPassword: 'short1' }, 'Use at least 8 characters.'],
    [
      'password',
      { password: 'onlyletters', confirmPassword: 'onlyletters' },
      'Include at least one letter and one number.',
    ],
    [
      'password',
      { password: '1234567890', confirmPassword: '1234567890' },
      'Include at least one letter and one number.',
    ],
    ['confirmPassword', { confirmPassword: 'Different2026' }, 'Passwords do not match.'],
    ['acceptedTerms', { acceptedTerms: false }, 'You must accept the terms to create an account.'],
  ])('rejects an invalid %s', (field, override, message) => {
    const result = registerSchema.safeParse({ ...validRegistration, ...override })
    expect(result.success).toBe(false)
    expect(messagesFor(result, field)[0]).toContain(message)
  })
})

describe('password reset validation', () => {
  it('validates the email for a reset request', () => {
    expect(forgotPasswordSchema.safeParse({ email: '' }).success).toBe(false)
    expect(forgotPasswordSchema.safeParse({ email: 'a@b.rw' }).success).toBe(true)
  })

  it('requires a strong new password that matches its confirmation', () => {
    expect(
      resetPasswordSchema.safeParse({ newPassword: 'Sunrise2026', confirmPassword: 'Sunrise2026' })
        .success,
    ).toBe(true)
    const mismatch = resetPasswordSchema.safeParse({
      newPassword: 'Sunrise2026',
      confirmPassword: 'Sunrise2027',
    })
    expect(messagesFor(mismatch, 'confirmPassword')[0]).toBe('Passwords do not match.')
    expect(
      resetPasswordSchema.safeParse({ newPassword: 'weak', confirmPassword: 'weak' }).success,
    ).toBe(false)
  })
})
