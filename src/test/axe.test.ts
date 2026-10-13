import { findAccessibilityViolations } from './axe'

describe('accessibility test harness', () => {
  it('actually reports violations, so passing results are meaningful', async () => {
    const container = document.createElement('div')
    container.innerHTML = '<img src="logo.png"><button></button><input type="text">'
    document.body.append(container)

    const violations = await findAccessibilityViolations(container)
    expect(violations.some((violation) => violation.startsWith('image-alt'))).toBe(true)
    expect(violations.some((violation) => violation.startsWith('button-name'))).toBe(true)
    expect(violations.some((violation) => violation.startsWith('label'))).toBe(true)
    container.remove()
  })
})
