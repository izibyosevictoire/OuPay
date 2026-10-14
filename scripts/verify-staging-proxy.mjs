#!/usr/bin/env node
/**
 * Proves the staging architecture end to end WITHOUT Vercel: it starts a small reverse proxy that behaves the way a
 * Vercel external rewrite does (the browser's Origin is kept, Host becomes the backend's, forwarded headers are
 * added, Set-Cookie is passed back), then drives the backend through it like a browser would, with a cookie jar
 * that applies the browser's rules for Secure and __Host- cookies.
 *
 *   BACKEND_URL=https://oupay-api.onrender.com FRONTEND_ORIGIN=https://oupay-staging.vercel.app \
 *     node scripts/verify-staging-proxy.mjs
 *
 * Against a real deployment, point BACKEND_URL at the Render service and set FRONTEND_ORIGIN to the exact Vercel
 * origin that is in OUPAY_ALLOWED_ORIGINS. It registers one throw-away user (a made-up address on example.test),
 * so only run it against staging. Exit code 0 means every check passed.
 *
 * What it cannot prove: that Vercel itself forwards Set-Cookie and Origin the way this proxy does. Run
 * docs/staging-deployment.md section "Test login and CSRF behind the proxy" against the real URLs for that.
 */
import http from 'node:http'

const BACKEND = new URL(process.env.BACKEND_URL ?? 'http://localhost:8080')
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN ?? 'https://oupay-staging.vercel.app'
const EMAIL = `proxy-check-${Date.now().toString(36)}@example.test`
const PASSWORD = 'Correct-horse-9'

let failures = 0
const check = (ok, message) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}`)
  if (!ok) failures += 1
}

// ---- the proxy: what a Vercel external rewrite does ------------------------------------------------------------
const proxy = http.createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const headers = { ...req.headers }
  headers.host = BACKEND.host // the backend sees ITS OWN host, not the frontend's
  headers['x-forwarded-proto'] = 'https'
  headers['x-forwarded-host'] = new URL(FRONTEND_ORIGIN).host
  headers['x-forwarded-for'] = '198.51.100.23'
  delete headers.connection
  const upstream = await fetch(new URL(req.url, BACKEND), {
    method: req.method,
    headers,
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
    redirect: 'manual',
  })
  const out = {}
  upstream.headers.forEach((value, key) => {
    if (key !== 'set-cookie' && key !== 'content-encoding' && key !== 'transfer-encoding')
      out[key] = value
  })
  const cookies = upstream.headers.getSetCookie()
  if (cookies.length) out['set-cookie'] = cookies
  res.writeHead(upstream.status, out)
  res.end(Buffer.from(await upstream.arrayBuffer()))
})
await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve))
const PROXY = `http://127.0.0.1:${proxy.address().port}`

// ---- a browser-like cookie jar (Secure and __Host- rules) -------------------------------------------------------
const jar = new Map()
const rejected = []
function store(setCookie) {
  const [pair, ...attrs] = setCookie.split(';').map((part) => part.trim())
  const eq = pair.indexOf('=')
  const name = pair.slice(0, eq)
  const value = pair.slice(eq + 1)
  const flags = attrs.map((a) => a.toLowerCase())
  const has = (prefix) => flags.some((flag) => flag === prefix || flag.startsWith(`${prefix}=`))
  if (
    name.startsWith('__Host-') &&
    (!has('secure') || !flags.includes('path=/') || has('domain'))
  ) {
    rejected.push(name)
    return
  }
  const expired =
    flags.includes('max-age=0') ||
    flags.some((f) => f.startsWith('expires=') && Date.parse(f.slice(8)) < Date.now())
  if (expired || value === '') jar.delete(name)
  else jar.set(name, { value, httpOnly: has('httponly'), secure: has('secure'), setCookie })
}
async function call(
  method,
  path,
  { body, origin = FRONTEND_ORIGIN, csrf = true, cookies = jar } = {},
) {
  const headers = { Accept: 'application/json' }
  if (cookies.size) headers.Cookie = [...cookies].map(([k, v]) => `${k}=${v.value}`).join('; ')
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (method !== 'GET') {
    if (origin) headers.Origin = origin // browsers always send Origin on POST/PUT/DELETE
    if (csrf && cookies.get('XSRF-TOKEN')) headers['X-XSRF-TOKEN'] = cookies.get('XSRF-TOKEN').value
  }
  const response = await fetch(`${PROXY}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (cookies === jar) response.headers.getSetCookie().forEach(store)
  const text = await response.text()
  return {
    status: response.status,
    headers: response.headers,
    json: text ? JSON.parse(text) : undefined,
  }
}
async function ensureCsrf() {
  for (let i = 0; i < 3 && !jar.get('XSRF-TOKEN'); i += 1) await call('GET', '/api/v1/auth/session')
}

try {
  // 1. First visit.
  const first = await call('GET', '/api/v1/auth/session')
  check(first.status === 204, 'anonymous session check answers 204 through the proxy')
  check(jar.get('XSRF-TOKEN')?.secure === true, 'the CSRF cookie is issued Secure')
  check(
    !first.headers.get('access-control-allow-origin'),
    'no CORS headers (the browser never needs them)',
  )

  // 2. A write from a foreign site is refused even with a valid CSRF token.
  await ensureCsrf()
  const evil = await call('POST', '/api/v1/auth/login', {
    body: { email: EMAIL, password: PASSWORD },
    origin: 'https://evil.example',
  })
  check(evil.status === 403, 'a login from another origin is refused (Origin check)')

  // 3. Register (sets the session cookie) from the frontend origin.
  await ensureCsrf()
  const noToken = await call('POST', '/api/v1/auth/register', { body: {}, csrf: false })
  check(noToken.status === 403, 'a write without the CSRF header is refused')
  await ensureCsrf()
  const registered = await call('POST', '/api/v1/auth/register', {
    body: { fullName: 'Proxy Check', email: EMAIL, phoneNumber: '', password: PASSWORD },
  })
  check(
    registered.status === 200,
    `registration through the proxy succeeds (got ${registered.status})`,
  )
  const sessionCookie = [...jar].find(([name]) => name.endsWith('oupay_session'))
  check(
    rejected.length === 0,
    `the browser would accept every cookie (rejected: ${rejected.join(', ') || 'none'})`,
  )
  check(Boolean(sessionCookie), 'a session cookie was stored')
  check(
    sessionCookie?.[1].httpOnly === true && sessionCookie?.[1].secure === true,
    'the session cookie is HttpOnly and Secure',
  )
  check(
    !/domain=/i.test(sessionCookie?.[1].setCookie ?? 'domain='),
    'the session cookie is host-only (no Domain attribute)',
  )
  check(
    !JSON.stringify(registered.json).includes(sessionCookie?.[1].value ?? '\u0000'),
    'the session value is never in a response body',
  )

  // 4. Authenticated reads and CSRF-protected writes.
  const me = await call('GET', '/api/v1/auth/session')
  check(me.status === 200 && me.json?.user?.email === EMAIL, 'the authenticated session read works')
  check(
    (await call('GET', '/api/v1/merchants')).status === 200,
    'an authenticated business call works',
  )
  await ensureCsrf()
  check(
    (await call('POST', '/api/v1/auth/email-verification/request')).status === 204,
    'a CSRF-protected write works',
  )
  await ensureCsrf()
  check(
    (await call('POST', '/api/v1/auth/email-verification/request')).status === 204,
    'and again, without re-login',
  )

  // 5. Logout, then the old cookie is worthless.
  const stolen = new Map(jar)
  await ensureCsrf()
  check((await call('POST', '/api/v1/auth/logout')).status === 204, 'logout answers 204')
  check(
    ![...jar.keys()].some((name) => name.endsWith('oupay_session')),
    'logout clears the session cookie',
  )
  check((await call('GET', '/api/v1/auth/session')).status === 204, 'the session is gone')
  const replay = await call('GET', '/api/v1/merchants', { cookies: stolen })
  check(replay.status === 401, 'a copy of the old cookie is refused after logout')

  // 6. Public payment pages: never cached, no cookies.
  const publicPage = await fetch(`${PROXY}/api/v1/public/payment-profiles/AAAAAAAAAAAA`)
  check(
    (publicPage.headers.get('cache-control') ?? '').includes('no-store'),
    'public payment responses carry Cache-Control: no-store',
  )
  check(publicPage.headers.getSetCookie().length === 0, 'public payment responses set no cookies')

  // 7. Management surface.
  const health = await fetch(`${PROXY}/actuator/health/readiness`)
  check(
    health.status === 200 && (await health.text()) === '{"status":"UP"}',
    'readiness is open and reveals only the status',
  )
  for (const path of ['/actuator/metrics', '/actuator/env', '/v3/api-docs']) {
    const r = await fetch(`${PROXY}${path}`)
    check([401, 403, 404].includes(r.status), `${path} is not served (${r.status})`)
  }
} finally {
  proxy.close()
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
