import { readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Static checks on how the DEMO is built and hosted (R9c). The demo is a separate build of the same code: it must stay a static, browser-only
 * site that cannot be routed to the real API, and the real application's deployment files must stay exactly what they were.
 */
const root = path.resolve(import.meta.dirname, '../..')
const read = (file: string) => readFileSync(path.join(root, file), 'utf8')
const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> }

describe('the demo build', () => {
  const env = read('.env.demo')
  const flags = Object.fromEntries(
    env
      .split('\n')
      .filter((line) => line.trim() && !line.trim().startsWith('#'))
      .map((line) => line.split('=') as [string, string]),
  )

  it('selects the mock services and the demo experience, with public flags only', () => {
    expect(flags).toEqual({ VITE_API_MODE: 'mock', VITE_DEMO_EXPERIENCE: 'true', VITE_ENABLE_DEMO_TOOLS: 'true' })
    // No address, key or credential of any kind in a file that is committed.
    const assignments = Object.entries(flags).map(([name, value]) => `${name}=${value}`).join(' ')
    expect(assignments).not.toMatch(/https?:\/\/|KEY|SECRET|TOKEN|PASSWORD|VITE_API_BASE_URL|VITE_DEMO_URL/i)
  })

  it('has its own scripts, and leaves the real build and dev scripts exactly as they were', () => {
    expect(pkg.scripts['dev:demo']).toBe('vite --mode demo')
    expect(pkg.scripts['build:demo']).toBe('tsc -b && vite build --mode demo --outDir dist-demo && node scripts/write-demo-hosting.mjs')
    expect(pkg.scripts['preview:demo']).toBe('vite preview --mode demo --outDir dist-demo')
    expect(pkg.scripts.build).toBe('tsc -b && vite build')
    expect(pkg.scripts.dev).toBe('vite')
    // The demo's output is a different folder from the real build's.
    expect(pkg.scripts['build:demo']).not.toMatch(/--outDir dist(?!-demo)/)
  })

  it('keeps the committed demo flags and ignores the demo output', () => {
    const ignore = read('.gitignore')
    expect(ignore).toMatch(/^!\.env\.demo$/m)
    expect(ignore).toMatch(/^dist-demo$/m)
  })
})

describe('the demo hosting file', () => {
  const script = read('scripts/write-demo-hosting.mjs')

  it('is a single-page-app fallback with safe headers and NO /api rewrite, so nothing can be routed to the real API', () => {
    expect(script).toContain("rewrites: [{ source: '/(.*)', destination: '/index.html' }]")
    // No rewrite, header or destination that points at the API or at the real backend host.
    expect(script).not.toMatch(/source:\s*'\/api|\/api\/:path|onrender\.com|destination:\s*'https?:/)
    expect(script).toContain('noindex')
  })

  it('refuses to finish unless the build really is a demo build', () => {
    expect(script).toContain("bundle.includes('DEMO MODE')")
    expect(script).toContain('process.exit(1)')
  })
})

describe('the real application deployment is unchanged', () => {
  const vercel = JSON.parse(read('vercel.json')) as {
    rewrites: { source: string; destination: string }[]
    build: { env: Record<string, string> }
  }

  it('still builds server-backed, still routes /api to the real backend before the SPA fallback, and knows nothing of the demo', () => {
    expect(vercel.build.env).toEqual({ VITE_API_MODE: 'http', VITE_API_BASE_URL: '/api/v1' })
    expect(vercel.rewrites[0]!.source).toBe('/api/:path*')
    expect(vercel.rewrites[0]!.destination).toMatch(/^https:\/\/.+\/api\/:path\*$/)
    expect(JSON.stringify(vercel)).not.toMatch(/demo/i)
  })
})
