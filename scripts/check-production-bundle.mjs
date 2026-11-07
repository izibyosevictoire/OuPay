#!/usr/bin/env node
/**
 * Verifies the REAL production bundle (`VITE_API_MODE=http`, what Vercel builds): it must contain no bank simulator and no mock payment or
 * financial service code, while the built-in examples (plain static data) are present. Run with `npm run verify:bundle`.
 *
 * How it decides, without relying on minified names:
 *  1. It builds the server-backed bundle into a temporary folder.
 *  2. It collects every long string literal from the MOCK LOGIC files (the in-browser services, the bank-event processor, the simulator and its
 *     adapter, the simulator screen and scenarios), and keeps only those that appear in NO other source file. Those strings can only be in the
 *     bundle if that mock code is in it.
 *  3. It fails if any of them is in the bundle (or if too few were found for the check to mean anything).
 * Data files (the sample and Kigali fixtures) are deliberately NOT in the list: static example data is allowed in the bundle.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const src = join(root, 'src')
const outDir = join(root, 'dist-bundle-check')
// `VERIFY_BUNDLE_MODE=mock` is a NEGATIVE CONTROL used by the tests: a mock-mode build must FAIL this check, which proves the check can fail.
const mode = process.env.VERIFY_BUNDLE_MODE === 'mock' ? 'mock' : 'http'

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    return statSync(full).isDirectory() ? walk(full) : [full]
  })
const norm = (file) => relative(src, file).replaceAll('\\', '/')
const isCode = (rel) => /\.(ts|tsx)$/.test(rel) && !/\.test\.|\/test\//.test(rel) && !rel.startsWith('test/')

// Mock LOGIC (not data): the in-browser services and everything that can create or confirm a fake payment.
const isMockLogic = (rel) =>
  isCode(rel) &&
  (/^services\/mock\/(mock[A-Z]|ledger\/)/.test(rel) ||
    rel === 'services/banking/equityMockAdapter.ts' ||
    rel === 'constants/simulatorScenarios.ts' ||
    rel === 'features/demo/BankSimulatorPage.tsx')

const literalsOf = (text) => {
  const found = new Set()
  for (const match of text.matchAll(/'((?:[^'\\\n]|\\.){32,160})'|"((?:[^"\\\n]|\\.){32,160})"/g)) {
    const value = (match[1] ?? match[2]).replace(/\\'/g, "'")
    if (!/[a-z]{3}/i.test(value) || /^[@./\w-]+$/.test(value)) continue // identifiers, paths and imports are not messages
    found.add(value)
  }
  return found
}

const files = walk(src).map((file) => ({ rel: norm(file), text: readFileSync(file, 'utf8') }))
const logic = files.filter((f) => isMockLogic(f.rel))
const others = files.filter((f) => isCode(f.rel) && !isMockLogic(f.rel))
const elsewhere = others.map((f) => f.text).join('\n')

const markers = new Map()
for (const file of logic) {
  for (const literal of literalsOf(file.text)) {
    if (!elsewhere.includes(literal)) markers.set(literal, file.rel)
  }
}

rmSync(outDir, { recursive: true, force: true })
console.log(`Building the ${mode === 'http' ? 'server-backed' : 'MOCK (negative control)'} bundle...`)
const build = spawnSync(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', outDir], {
  cwd: root,
  env: { ...process.env, VITE_API_MODE: mode, ...(mode === 'mock' ? { VITE_ENABLE_DEMO_TOOLS: 'true' } : {}) },
  encoding: 'utf8',
})
if (build.status !== 0) {
  console.error(build.stdout, build.stderr)
  process.exit(1)
}

const assets = join(outDir, 'assets')
if (!existsSync(assets)) {
  console.error('No bundle was produced.')
  process.exit(1)
}
const bundle = readdirSync(assets)
  .filter((name) => name.endsWith('.js'))
  .map((name) => readFileSync(join(assets, name), 'utf8'))
  .join('\n')
rmSync(outDir, { recursive: true, force: true })

const problems = []
const MINIMUM = 150
if (markers.size < MINIMUM) problems.push(`only ${markers.size} mock-only strings were found (need ${MINIMUM}): the check would prove nothing`)
const leaked = [...markers].filter(([literal]) => bundle.includes(literal.replace(/\\n/g, '\n')) || bundle.includes(JSON.stringify(literal).slice(1, -1)))
for (const [literal, file] of leaked.slice(0, 20)) problems.push(`mock code is in the bundle: "${literal.slice(0, 70)}" (from ${file})`)
// The simulator, the "demo" tools and the demo build's banner must not be there either.
for (const forbidden of ['SIMULATOR_SCENARIOS', 'simulateRequestPayment', 'DEMO MODE']) {
  if (bundle.includes(forbidden)) problems.push(`the bundle contains "${forbidden}"`)
}
// The built-in examples (static data) ARE shipped: that is the point of the feature.
for (const expected of ['EXAMPLE DATA', 'Kigali Demo Supermarket']) {
  if (!bundle.includes(expected)) problems.push(`the bundle lacks "${expected}": the examples are not in this build`)
}

console.log(`Checked ${markers.size} strings that exist only in mock payment/financial code and the bank simulator.`)
if (problems.length) {
  console.error(`\nProduction bundle check FAILED:\n- ${problems.join('\n- ')}`)
  process.exit(1)
}
console.log('OK: the server-backed bundle contains no bank simulator and no mock payment service code; the static examples are present.')
