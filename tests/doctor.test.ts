import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  checkAdBlockerExposure,
  checkClientConfiguration,
  checkContentSecurityPolicy,
  checkPublicKey,
  doctorExitCode,
  type DoctorContext,
} from '../src/doctor/index.js'
import { emitAnalyticsModule } from '../src/emit/analyticsTs.js'
import { scan } from '../src/scan/index.js'
import { makeFixture, VITE_CONSUMER_APP, type Fixture } from './fixtures.js'
import { writeText } from '../src/util/fs.js'
import { join } from 'node:path'
import type { OpenHogConfig, TrackingPlan } from '../src/types.js'

const config: OpenHogConfig = {
  version: 1,
  posthog: {
    region: 'us',
    host: 'https://us.posthog.com',
    ingestHost: 'https://us.i.posthog.com',
    assetHost: 'https://us-assets.i.posthog.com',
    publicKeyEnv: 'VITE_PUBLIC_POSTHOG_KEY',
    projectId: 1,
  },
  product: { kind: 'consumer', packs: ['core'] },
  paths: { analyticsModule: 'src/analytics.ts' },
}

const plan: TrackingPlan = {
  version: 1,
  generatedAt: '2026-08-15T00:00:00.000Z',
  generatedBy: 'test',
  product: { name: 'Lantern', description: '', kind: 'consumer', surfaces: ['web'] },
  events: [],
  roles: {},
  identity: { distinctIdSource: '', sensitiveRoutes: [] },
  packs: ['core'],
  routes: ['/', '/gigs/:id'],
}

describe('the CSP check', () => {
  let fixture: Fixture

  beforeAll(() => {
    fixture = makeFixture(VITE_CONSUMER_APP)
  })
  afterAll(() => fixture.cleanup())

  it('catches the asset host missing from script-src', () => {
    // The fixture allows us.i.posthog.com in connect-src only. Events flow, the
    // replay recorder can never load, and $recording_status sticks at
    // lazy_loading — the exact production-only failure this check exists for.
    const context: DoctorContext = {
      root: fixture.root,
      config,
      plan,
      scan: scan(fixture.root),
      client: null,
    }
    const result = checkContentSecurityPolicy(context)
    expect(result.status).toBe('fail')
    expect(result.message).toContain('script-src')
    expect(result.message).toContain('session replay')
  })

  it('passes when both hosts are allowed in the right directives', () => {
    const good = makeFixture({
      ...VITE_CONSUMER_APP,
      'vercel.json': JSON.stringify({
        headers: [
          {
            source: '/(.*)',
            headers: [
              {
                key: 'Content-Security-Policy',
                value:
                  "default-src 'self'; script-src 'self' https://us-assets.i.posthog.com; connect-src 'self' https://us.i.posthog.com https://us-assets.i.posthog.com",
              },
            ],
          },
        ],
      }),
    })
    const result = checkContentSecurityPolicy({
      root: good.root,
      config,
      plan,
      scan: scan(good.root),
      client: null,
    })
    expect(result.status).toBe('pass')
    good.cleanup()
  })
})

describe('the client configuration checks', () => {
  it('passes on the module OpenHog itself generates', () => {
    const fixture = makeFixture(VITE_CONSUMER_APP)
    writeText(
      join(fixture.root, 'src/analytics.ts'),
      emitAnalyticsModule({
        plan,
        publicKeyEnv: 'VITE_PUBLIC_POSTHOG_KEY',
        ingestHost: 'https://us.i.posthog.com',
        envStyle: 'vite',
      }),
    )
    const results = checkClientConfiguration({
      root: fixture.root,
      config,
      plan,
      scan: scan(fixture.root),
      client: null,
    })
    const failures = results.filter((result) => result.status === 'fail' || result.status === 'warn')
    expect(failures, JSON.stringify(failures, null, 2)).toHaveLength(0)
    fixture.cleanup()
  })

  it('catches the history_change pageview trap', () => {
    const fixture = makeFixture({
      ...VITE_CONSUMER_APP,
      'src/analytics.ts': `
        posthog.init(key, {
          capture_pageview: 'history_change',
          autocapture: false,
          sanitize_properties: (p) => p,
        })
      `,
    })
    const results = checkClientConfiguration({
      root: fixture.root,
      config,
      plan,
      scan: scan(fixture.root),
      client: null,
    })
    const pageview = results.find((result) => result.name === 'Pageview capture')
    expect(pageview?.status).toBe('fail')
    expect(pageview?.message).toContain('first page load')
    expect(pageview?.fix).toContain('$pageleave')
    fixture.cleanup()
  })

  it('warns when autocapture is left on', () => {
    const fixture = makeFixture({
      ...VITE_CONSUMER_APP,
      'src/analytics.ts': 'posthog.init(key, { capture_pageview: false, sanitize_properties: (p) => p })\nposthog.capture("$pageview")\n',
    })
    const results = checkClientConfiguration({
      root: fixture.root,
      config,
      plan,
      scan: scan(fixture.root),
      client: null,
    })
    expect(results.find((result) => result.name === 'Autocapture')?.status).toBe('warn')
    fixture.cleanup()
  })
})

describe('the project key check', () => {
  it('rejects a personal key pasted where the project key goes', () => {
    const fixture = makeFixture({ ...VITE_CONSUMER_APP, '.env': 'VITE_PUBLIC_POSTHOG_KEY=phx_personal_key_here\n' })
    const result = checkPublicKey({ root: fixture.root, config, plan, scan: null, client: null })
    expect(result.status).toBe('fail')
    expect(result.fix).toContain('Project API key')
    fixture.cleanup()
  })

  it('finds a key in .env.local', () => {
    const fixture = makeFixture({
      ...VITE_CONSUMER_APP,
      '.env.local': 'VITE_PUBLIC_POSTHOG_KEY=phc_abcdefghijklmnopqrstuvwxyz\n',
    })
    const result = checkPublicKey({ root: fixture.root, config, plan, scan: null, client: null })
    expect(result.status).toBe('pass')
    fixture.cleanup()
  })
})

describe('ad-blocker exposure', () => {
  it('warns about the default cloud ingest host', () => {
    const result = checkAdBlockerExposure({ root: '/tmp', config, plan, scan: null, client: null })
    expect(result.status).toBe('warn')
    expect(result.fix).toContain('reverse proxy')
  })

  it('passes when events go through a first-party proxy', () => {
    const proxied: OpenHogConfig = {
      ...config,
      posthog: { ...config.posthog, ingestHost: 'https://example.com/ingest' },
    }
    const result = checkAdBlockerExposure({ root: '/tmp', config: proxied, plan, scan: null, client: null })
    expect(result.status).toBe('pass')
  })
})

describe('exit code', () => {
  it('is 1 only when something actually failed', () => {
    expect(doctorExitCode([{ name: 'a', status: 'warn', message: '' }])).toBe(0)
    expect(doctorExitCode([{ name: 'a', status: 'fail', message: '' }])).toBe(1)
  })
})
