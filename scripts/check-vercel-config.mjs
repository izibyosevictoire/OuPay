#!/usr/bin/env node
/**
 * Fails the Vercel build (before it spends time building) when vercel.json is not ready to deploy:
 * the API rewrite must point at a real https backend host, must come BEFORE the SPA fallback, and the SPA fallback
 * must not swallow /api. A deployment with the placeholder still in place would serve index.html for every API call
 * and the app would look broken in confusing ways, so it is refused instead.
 *
 * Set the host with:  node scripts/set-render-url.mjs https://your-service.onrender.com
 */
import { readFileSync } from 'node:fs'

const configPath = process.env.VERCEL_CONFIG_PATH ?? new URL('../vercel.json', import.meta.url)
const config = JSON.parse(readFileSync(configPath, 'utf8'))
const rewrites = config.rewrites ?? []
const problems = []

const apiIndex = rewrites.findIndex((r) => r.source.startsWith('/api/'))
const spaIndex = rewrites.findIndex((r) => r.destination === '/index.html')
if (apiIndex === -1) problems.push('there is no /api rewrite')
if (spaIndex === -1) problems.push('there is no SPA fallback rewrite')
if (apiIndex !== -1 && spaIndex !== -1 && apiIndex > spaIndex)
  problems.push('the /api rewrite must come before the SPA fallback')
if (spaIndex !== -1 && !rewrites[spaIndex].source.includes('(?!api/)'))
  problems.push('the SPA fallback must exclude /api')

if (apiIndex !== -1) {
  const destination = rewrites[apiIndex].destination
  let url
  try {
    url = new URL(destination.replace(':path*', 'x'))
  } catch {
    problems.push(`the /api destination is not a URL: ${destination}`)
  }
  if (url) {
    if (url.protocol !== 'https:') problems.push('the /api destination must be https')
    if (/REPLACE/i.test(url.hostname))
      problems.push(
        'the /api destination still has the placeholder host: run scripts/set-render-url.mjs',
      )
    if (['localhost', '127.0.0.1'].includes(url.hostname))
      problems.push('the /api destination must not be localhost')
    if (url.username || url.password)
      problems.push('the /api destination must not contain credentials')
    if (!url.pathname.startsWith('/api/'))
      problems.push('the /api destination must keep the /api/ path prefix')
  }
}
if (config.build?.env?.VITE_API_MODE !== 'http')
  problems.push('build.env.VITE_API_MODE must be http')
for (const [name, value] of Object.entries(config.build?.env ?? {})) {
  if (/secret|password|token|key/i.test(name) || /^(sk|pk)_/i.test(String(value)))
    problems.push(`build.env.${name} looks like a secret: client variables are public`)
}

if (problems.length) {
  console.error('vercel.json is not ready to deploy:')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log(
  'vercel.json is ready: /api is proxied to',
  new URL(rewrites[apiIndex].destination.replace(':path*', 'x')).origin,
)
