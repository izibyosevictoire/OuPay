/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const css = readFileSync(resolve(import.meta.dirname, 'globals.css'), 'utf8')

// jsdom cannot compute colour contrast, so the design tokens are checked directly here.
const rootBlock = /:root\s*\{([\s\S]*?)\n[ ]{2}\}/.exec(css)?.[1] ?? ''

function token(name: string): [number, number, number] {
  const match = new RegExp(`--${name}:\\s*([\\d.]+)\\s+([\\d.]+)%\\s+([\\d.]+)%`).exec(rootBlock)
  if (!match) throw new Error(`Token --${name} not found`)
  return [Number(match[1]), Number(match[2]) / 100, Number(match[3]) / 100]
}

function relativeLuminance([hue, saturation, lightness]: [number, number, number]) {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1))
  const m = lightness - chroma / 2
  const [r, g, b] =
    hue < 60
      ? [chroma, x, 0]
      : hue < 120
        ? [x, chroma, 0]
        : hue < 180
          ? [0, chroma, x]
          : hue < 240
            ? [0, x, chroma]
            : hue < 300
              ? [x, 0, chroma]
              : [chroma, 0, x]
  const linear = (channel: number) => {
    const value = channel + m
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
}

function contrastRatio(foreground: string, background: string) {
  const [lighter, darker] = [
    relativeLuminance(token(foreground)),
    relativeLuminance(token(background)),
  ].sort((a, b) => b - a)
  return (lighter! + 0.05) / (darker! + 0.05)
}

const TEXT_PAIRS: [string, string][] = [
  ['foreground', 'background'],
  ['card-foreground', 'card'],
  ['muted-foreground', 'background'],
  ['muted-foreground', 'card'],
  ['muted-foreground', 'muted'],
  ['primary-foreground', 'primary'],
  ['primary', 'card'],
  ['accent-foreground', 'accent'],
  ['secondary-foreground', 'secondary'],
  ['destructive-foreground', 'destructive'],
  ['success', 'success-soft'],
  ['warning', 'warning-soft'],
  ['danger', 'danger-soft'],
  ['danger', 'card'],
  ['info', 'info-soft'],
  ['neutral', 'neutral-soft'],
]

describe('design token contrast', () => {
  it.each(TEXT_PAIRS)('text %s on %s meets 4.5:1 (WCAG 1.4.3)', (foreground, background) => {
    expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(4.5)
  })

  it.each([
    ['input', 'card'],
    ['ring', 'background'],
  ])('UI component boundary %s on %s meets 3:1 (WCAG 1.4.11)', (boundary, background) => {
    expect(contrastRatio(boundary, background)).toBeGreaterThanOrEqual(3)
  })
})
