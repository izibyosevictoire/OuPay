import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/**
 * Static checks on the deployment files. Docker is not installed on the development machine and Vercel/Render run
 * remotely, so these tests are what stops a careless edit from shipping a root user, a leaked secret, an API call
 * swallowed by the SPA fallback, or a cached authenticated response.
 */
const root = path.resolve(import.meta.dirname, '../..')
const read = (file: string) => readFileSync(path.join(root, file), 'utf8')

interface Rewrite {
  source: string
  destination: string
}
interface HeaderRule {
  source: string
  headers: { key: string; value: string }[]
}
const vercel = JSON.parse(read('vercel.json')) as {
  rewrites: Rewrite[]
  headers: HeaderRule[]
  build: { env: Record<string, string> }
}

/** Which rewrite wins for a path, the way Vercel evaluates them: top to bottom, first match. */
function matchRewrite(rewrites: Rewrite[], pathname: string): Rewrite | undefined {
  return rewrites.find((rule) => {
    const source = rule.source.replace(/:path\*/, '.*')
    return new RegExp(`^${source}$`).test(pathname)
  })
}

describe('Dockerfile', () => {
  const dockerfile = read('backend/Dockerfile')
  const lines = dockerfile.split('\n').filter((line) => !line.trim().startsWith('#'))
  const text = lines.join('\n')

  it('uses pinned, supported Java 21 base images (never :latest)', () => {
    const images = [...text.matchAll(/^FROM\s+(\S+)/gm)].map((m) => m[1] ?? '')
    expect(images).toHaveLength(2)
    for (const image of images) {
      expect(image).not.toMatch(/:latest$|^[^:]+$/)
      expect(image).toMatch(/21/)
    }
    expect(images[1]).toMatch(/jre/)
  })

  it('runs as an unprivileged numeric user, with the production profile, and nothing secret baked in', () => {
    expect(text).toMatch(/^USER\s+10001/m)
    expect(text).toMatch(/SPRING_PROFILES_ACTIVE=prod/)
    expect(text).not.toMatch(/SPRING_PROFILES_ACTIVE=[^p\s"]/)
    expect(text).not.toMatch(/^\s*(ENV|ARG)\s+\S*(PASSWORD|SECRET|TOKEN|KEY)\S*\s*=/im)
    expect(text).not.toMatch(/postgres(ql)?:\/\/[^\s]*:[^\s@]*@/)
    expect(text).not.toMatch(/jdbc:postgresql:\/\/(?!\$)/)
  })

  it('keeps the dev profile and the tests out of the image and builds from the pom', () => {
    expect(text).toMatch(/rm -f src\/main\/resources\/application-dev\.yml/)
    expect(text).toMatch(/-DskipTests package/)
    expect(text).not.toMatch(/COPY[^\n]*(scripts|\.test-pgdata|\.env|compose)/)
  })

  it('starts the JVM as PID 1 (so SIGTERM reaches Spring graceful shutdown) and sizes memory from the container', () => {
    expect(text).toMatch(/ENTRYPOINT .*exec java/)
    expect(text).toMatch(/MaxRAMPercentage=\d+/)
    expect(text).toMatch(/ExitOnOutOfMemoryError/)
    expect(text).toMatch(/HEALTHCHECK/)
    expect(text).toMatch(/JarLauncher/)
  })

  it('.dockerignore excludes build output, test databases, scripts and secrets', () => {
    const ignore = read('backend/.dockerignore').split('\n')
    for (const entry of [
      'target/',
      '.test-pgdata/',
      'scripts/',
      '.env',
      '.env.*',
      '*.dump',
      '*.pem',
      'src/test/',
    ]) {
      expect(ignore).toContain(entry)
    }
  })
})

describe('backend runtime configuration', () => {
  const main = read('backend/src/main/resources/application.yml')
  const prod = read('backend/src/main/resources/application-prod.yml')

  it('binds to the platform port on all interfaces and shuts down gracefully', () => {
    expect(main).toMatch(/port: \$\{PORT:8080\}/)
    expect(main).toMatch(/address: \$\{OUPAY_BIND_ADDRESS:0\.0\.0\.0\}/)
    expect(main).toMatch(/shutdown: graceful/)
    expect(main).toMatch(/timeout-per-shutdown-phase: 30s/)
  })

  it('takes every credential from the environment and hardcodes none', () => {
    expect(main).toMatch(/password: \$\{OUPAY_DB_PASSWORD:\}/)
    expect(main).toMatch(/url: \$\{OUPAY_FLYWAY_DB_URL:\$\{spring\.datasource\.url\}\}/)
    const secretLines = [
      ...main.matchAll(/^\s*(password|secret|shared-secret|api-key|token):\s*(.*)$/gim),
    ]
    for (const [, key, value] of secretLines) {
      expect(`${key}: ${value}`).toMatch(/\$\{[A-Z_]+[^}]*\}|""/)
    }
    expect(main + prod).not.toMatch(/jdbc:postgresql:\/\/(?!localhost|\$)/)
  })

  it('never resets the schema on startup and exposes only the health probes', () => {
    expect(main).toMatch(/ddl-auto: validate/)
    expect(main).not.toMatch(/ddl-auto: (create|update|create-drop)/)
    expect(main).not.toMatch(/clean-disabled: false|clean-on-validation-error: true/)
    expect(main).toMatch(/include: health\n/)
    expect(main).toMatch(/show-details: never/)
  })

  it('has a production profile that closes the documentation and simulator doors', () => {
    expect(prod).toMatch(/api-docs:\n\s+enabled: false/)
    expect(prod).toMatch(/simulated:\n\s+enabled: false/)
    expect(prod).toMatch(/cookie-name: __Host-oupay_session/)
    expect(prod).toMatch(/secure-cookie: true/)
  })
})

describe('vercel.json', () => {
  it('proxies /api to the backend BEFORE the SPA fallback, and the fallback never swallows /api', () => {
    const rewrites = vercel.rewrites
    expect(matchRewrite(rewrites, '/api/v1/auth/session')?.destination).toMatch(/\/api\/:path\*$/)
    for (const spa of [
      '/login',
      '/invoices',
      '/cashiers',
      '/p/Rk4mQ8vTz2Xn',
      '/p/abc/r/OP-ABC',
      '/accept-invitation/tok',
      '/reset-password/tok',
      '/verify-email/tok',
      '/',
    ]) {
      expect(matchRewrite(rewrites, spa)?.destination, spa).toBe('/index.html')
    }
    for (const api of [
      '/api/v1/public/payment-profiles/abc/requests/OP-1',
      '/api/v1/auth/login',
      '/api/v1/merchants/m1/invoices',
    ]) {
      expect(matchRewrite(rewrites, api)?.destination, api).not.toBe('/index.html')
    }
    const fallbackIndex = rewrites.findIndex((r) => r.destination === '/index.html')
    expect(rewrites.findIndex((r) => r.source.startsWith('/api/'))).toBeLessThan(fallbackIndex)
  })

  it('never caches API responses (authenticated data, sessions, public payment status)', () => {
    const api = vercel.headers.find((h) => h.source.startsWith('/api/'))
    expect(api?.headers).toContainEqual({ key: 'Cache-Control', value: 'no-store' })
    expect(api?.headers.map((h) => h.key)).toContain('Vercel-CDN-Cache-Control')
  })

  it('sends the security headers and a CSP that allows no foreign scripts, frames or connections', () => {
    const all = vercel.headers.find((h) => h.source === '/(.*)')?.headers ?? []
    const byKey = Object.fromEntries(all.map((h) => [h.key, h.value]))
    expect(byKey['X-Content-Type-Options']).toBe('nosniff')
    expect(byKey['X-Frame-Options']).toBe('DENY')
    expect(byKey['Referrer-Policy']).toBe('no-referrer')
    expect(byKey['Strict-Transport-Security']).toMatch(/max-age=\d{7,}/)
    const csp = byKey['Content-Security-Policy'] ?? ''
    expect(csp).toMatch(/default-src 'self'/)
    expect(csp).toMatch(/script-src 'self'(;|$)/)
    expect(csp).toMatch(/connect-src 'self'(;|$)/)
    expect(csp).toMatch(/frame-ancestors 'none'/)
    expect(csp).toMatch(/object-src 'none'/)
    expect(csp).not.toMatch(/unsafe-eval|script-src[^;]*unsafe-inline|\*/)
  })

  it('builds in server mode with a same-origin API and carries no secrets', () => {
    expect(vercel.build.env).toEqual({ VITE_API_MODE: 'http', VITE_API_BASE_URL: '/api/v1' })
    expect(JSON.stringify(vercel)).not.toMatch(/secret|password|apikey|api_key/i)
  })

  describe('deployment gate (scripts/check-vercel-config.mjs)', () => {
    const run = (config: unknown) => {
      const dir = mkdtempSync(path.join(tmpdir(), 'oupay-vercel-'))
      const file = path.join(dir, 'vercel.json')
      writeFileSync(file, JSON.stringify(config))
      return spawnSync(process.execPath, [path.join(root, 'scripts/check-vercel-config.mjs')], {
        env: { ...process.env, VERCEL_CONFIG_PATH: file },
        encoding: 'utf8',
      })
    }
    const ready = () => ({
      ...vercel,
      rewrites: [
        { source: '/api/:path*', destination: 'https://oupay-api.onrender.com/api/:path*' },
        { source: '/((?!api/).*)', destination: '/index.html' },
      ],
    })

    it('refuses the unconfigured placeholder host, so an unconfigured project cannot deploy', () => {
      // The committed file now names the real service; the gate must still refuse the original template value.
      const result = run({
        ...vercel,
        rewrites: [
          {
            source: '/api/:path*',
            destination: 'https://REPLACE-WITH-RENDER-SERVICE.onrender.com/api/:path*',
          },
          { source: '/((?!api/).*)', destination: '/index.html' },
        ],
      })
      expect(result.status).toBe(1)
      expect(result.stderr).toMatch(/placeholder/)
    })

    it('accepts a configured project', () => {
      expect(run(ready()).status).toBe(0)
    })

    it('refuses unsafe variations', () => {
      const cases: Record<string, (c: ReturnType<typeof ready>) => void> = {
        'http backend': (c) =>
          (c.rewrites[0]!.destination = 'http://oupay-api.onrender.com/api/:path*'),
        localhost: (c) => (c.rewrites[0]!.destination = 'https://localhost/api/:path*'),
        credentials: (c) =>
          (c.rewrites[0]!.destination = 'https://user:pw@oupay-api.onrender.com/api/:path*'),
        'lost /api prefix': (c) =>
          (c.rewrites[0]!.destination = 'https://oupay-api.onrender.com/:path*'),
        'fallback first': (c) => c.rewrites.reverse(),
        'fallback swallows api': (c) => (c.rewrites[1]!.source = '/(.*)'),
        'mock mode': (c) => (c.build.env.VITE_API_MODE = 'mock'),
        'secret in client env': (c) => (c.build.env.VITE_API_SECRET = 'x'),
      }
      for (const [name, mutate] of Object.entries(cases)) {
        const config = structuredClone(ready())
        mutate(config)
        expect(run(config).status, name).toBe(1)
      }
    })
  })
})

describe('nothing sensitive is committed in deployment files', () => {
  it('contains no credentials, keys or connection strings with passwords', () => {
    const files = [
      'backend/Dockerfile',
      'backend/.dockerignore',
      'vercel.json',
      '.env.example',
      'backend/src/main/resources/application.yml',
      'backend/src/main/resources/application-prod.yml',
      'docs/staging-deployment.md',
    ]
    for (const file of files) {
      const text = read(file)
      expect(text, file).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/)
      // (Placeholders such as <user>:<password> are documentation, not credentials.)
      expect(text, file).not.toMatch(/postgres(ql)?:\/\/[^\s:@/<]+:[^\s@/<]+@/)
      expect(text, file).not.toMatch(/jdbc:postgresql:\/\/[^\s]*[?&](password|user)=[^\s&<$]+/i)
      expect(text, file).not.toMatch(
        /\b(AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|sk_live_[A-Za-z0-9]+|xox[bap]-[A-Za-z0-9-]+)\b/,
      )
    }
  })
})
