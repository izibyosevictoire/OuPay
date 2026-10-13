import axe from 'axe-core'

/**
 * Runs axe-core against a rendered subtree and returns readable violation summaries.
 * Colour contrast is skipped because jsdom has no layout/paint engine; contrast is
 * verified separately in designTokens.test.ts.
 */
export async function findAccessibilityViolations(root: Element): Promise<string[]> {
  const results = await axe.run(root, {
    runOnly: {
      type: 'tag',
      values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'],
    },
    // `region` expects landmarks around the whole document, which a rendered subtree lacks.
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
  })
  return results.violations.map(
    (violation) =>
      `${violation.id} (${violation.impact}): ${violation.help} -> ${violation.nodes
        .map((node) => node.target.join(' '))
        .join(', ')}`,
  )
}
