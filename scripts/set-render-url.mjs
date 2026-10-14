#!/usr/bin/env node
/**
 * Points the /api rewrite in vercel.json at your Render service.
 *
 *   node scripts/set-render-url.mjs https://oupay-api.onrender.com
 *
 * Only the origin is accepted (https, no path, no credentials): the rewrite appends /api/... itself. The value is a
 * public hostname, not a secret, so it is committed. Commit the change on the staging branch before deploying.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const input = process.argv[2]
let url
try {
  url = new URL(input)
} catch {
  console.error('Usage: node scripts/set-render-url.mjs https://<your-render-service>.onrender.com')
  process.exit(2)
}
if (
  url.protocol !== 'https:' ||
  url.pathname !== '/' ||
  url.search ||
  url.hash ||
  url.username ||
  url.password
) {
  console.error('Give the service ORIGIN only: https://host (no path, query or credentials).')
  process.exit(2)
}
const file = new URL('../vercel.json', import.meta.url)
const config = JSON.parse(readFileSync(file, 'utf8'))
const rule = config.rewrites.find((r) => r.source.startsWith('/api/'))
rule.destination = `${url.origin}/api/:path*`
writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`)
console.log(`vercel.json: /api/* now proxies to ${url.origin}`)
