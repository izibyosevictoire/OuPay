#!/usr/bin/env node
/**
 * Writes the hosting file of the separate DEMO site into dist-demo/ (R9c), after `npm run build:demo`.
 *
 * The demo is a static site: it runs entirely in the browser on the mock services and has no backend. So its hosting file has a single-page-app
 * fallback and some safe headers, and deliberately NO /api rewrite: nothing on the demo site can be routed to the real OuPay API, even by a
 * hand-typed URL. (The repository's vercel.json is the REAL application's: it rewrites /api to the production backend and is never used for the demo.)
 *
 * It also refuses to finish if the build is not a demo build, so the real site can never be deployed from this folder by mistake.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const outDir = new URL('../dist-demo/', import.meta.url)
if (!existsSync(outDir)) {
  console.error('dist-demo/ does not exist: run `npm run build:demo` first.')
  process.exit(1)
}

// The demo build must contain the demo banner text, and no reference to the production API host in its configuration.
const assetsDir = new URL('assets/', outDir)
const assetsPath = fileURLToPath(assetsDir)
const bundle = readdirSync(assetsPath)
  .filter((name) => name.endsWith('.js'))
  .map((name) => readFileSync(join(assetsPath, name), 'utf8'))
  .join('\n')
if (!bundle.includes('DEMO MODE')) {
  console.error('This build does not look like a demo build (the demo banner text is missing). Refusing to write the demo hosting file.')
  process.exit(1)
}

const hosting = {
  $schema: 'https://openapi.vercel.sh/vercel.json',
  cleanUrls: false,
  rewrites: [{ source: '/(.*)', destination: '/index.html' }],
  headers: [
    {
      source: '/(.*)',
      headers: [
        { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'Referrer-Policy', value: 'no-referrer' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
      ],
    },
  ],
}

writeFileSync(new URL('vercel.json', outDir), `${JSON.stringify(hosting, null, 2)}\n`)
console.log('Wrote dist-demo/vercel.json (single-page-app fallback, no /api rewrite).')
