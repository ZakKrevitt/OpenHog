import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generatePlan, planStats, stageForEvent } from '../src/plan/generate.js'
import { checkDrift } from '../src/check.js'
import { scan } from '../src/scan/index.js'
import { parseArgs } from '../src/cli.js'
import { generateDemoEvents, makeRandom } from '../src/demo/seed.js'
import { publicKeyEnvFor, envStyleFor } from '../src/config.js'
import { makeFixture, VITE_CONSUMER_APP, type Fixture } from './fixtures.js'

describe('plan generation', () => {
  let fixture: Fixture
  let result: ReturnType<typeof scan>

  beforeAll(() => {
    fixture = makeFixture(VITE_CONSUMER_APP)
    result = scan(fixture.root)
  })
  afterAll(() => fixture.cleanup())

  it('marks events found in code as emitted and suggestions as not', () => {
    const plan = generatePlan({ scan: result, kind: 'consumer', packs: ['core'] })
    const signup = plan.events.find((event) => event.name === 'signup_completed')
    expect(signup?.emitted).toBe(true)
    expect(plan.events.some((event) => !event.emitted)).toBe(true)
  })

  it('only suggests events for features the repo actually has', () => {
    const plan = generatePlan({ scan: result, kind: 'consumer', packs: ['core'] })
    const suggested = plan.events.filter((event) => !event.emitted).map((event) => event.name)
    // No payment code in the fixture, so proposing a checkout event would be
    // aspiration rather than a plan.
    expect(suggested).not.toContain('checkout_started')
  })

  it('resolves roles only from emitted events', () => {
    const plan = generatePlan({ scan: result, kind: 'consumer', packs: ['core'] })
    const emitted = new Set(plan.events.filter((event) => event.emitted).map((event) => event.name))
    for (const eventName of Object.values(plan.roles)) {
      if (eventName === '$pageview') continue
      expect(emitted.has(eventName), `${eventName} backs a role but is not emitted`).toBe(true)
    }
  })

  it('preserves hand-written descriptions when regenerated', () => {
    const first = generatePlan({ scan: result, kind: 'consumer', packs: ['core'] })
    const edited = {
      ...first,
      events: first.events.map((event) =>
        event.name === 'signup_completed' ? { ...event, description: 'MY OWN WORDS' } : event,
      ),
    }
    const second = generatePlan({ scan: result, kind: 'consumer', packs: ['core'], existing: edited })
    expect(second.events.find((event) => event.name === 'signup_completed')?.description).toBe('MY OWN WORDS')
  })

  it('keeps hand-added events the scanner cannot see', () => {
    const first = generatePlan({ scan: result, kind: 'consumer', packs: ['core'] })
    const edited = {
      ...first,
      events: [
        ...first.events,
        {
          name: 'server_side_job_finished',
          description: 'Emitted from Go, which the scanner does not parse',
          stage: 'health' as const,
          properties: [],
          emitted: false,
          sources: [],
        },
      ],
    }
    const second = generatePlan({ scan: result, kind: 'consumer', packs: ['core'], existing: edited })
    expect(second.events.some((event) => event.name === 'server_side_job_finished')).toBe(true)
  })

  it('counts what is there', () => {
    const stats = planStats(generatePlan({ scan: result, kind: 'consumer', packs: ['core'] }))
    expect(stats.emitted).toBeGreaterThan(5)
    expect(stats.total).toBe(stats.emitted + stats.suggested)
  })
})

describe('stage inference', () => {
  it.each([
    ['signup_completed', 'acquisition'],
    ['onboarding_completed', 'activation'],
    ['checkout_started', 'conversion'],
    ['invite_shared', 'referral'],
    ['request_error', 'health'],
    ['gig_detail_opened', 'engagement'],
  ])('%s → %s', (name, stage) => {
    expect(stageForEvent(name)).toBe(stage)
  })
})

describe('drift detection', () => {
  let fixture: Fixture

  beforeAll(() => {
    fixture = makeFixture(VITE_CONSUMER_APP)
  })
  afterAll(() => fixture.cleanup())

  it('reports nothing when the plan matches the code', () => {
    const result = scan(fixture.root)
    const plan = generatePlan({ scan: result, kind: 'consumer', packs: ['core'] })
    const report = checkDrift({ plan, scan: result })
    expect(report.errors).toHaveLength(0)
  })

  it('fails when an event the plan expects has vanished from the code', () => {
    const result = scan(fixture.root)
    const plan = generatePlan({ scan: result, kind: 'consumer', packs: ['core'] })
    const withoutSignup = {
      ...result,
      existingEvents: result.existingEvents.filter((event) => event.name !== 'signup_completed'),
    }
    const report = checkDrift({ plan, scan: withoutSignup })
    expect(report.errors.some((item) => item.kind === 'removed' && item.name === 'signup_completed')).toBe(true)
  })

  it('fails when a dashboard role loses its event entirely', () => {
    const result = scan(fixture.root)
    const plan = generatePlan({ scan: result, kind: 'consumer', packs: ['core'] })
    const withoutShare = {
      ...result,
      existingEvents: result.existingEvents.filter((event) => !event.name.includes('share')),
    }
    const report = checkDrift({ plan, scan: withoutShare })
    expect(report.errors.some((item) => item.kind === 'role-lost')).toBe(true)
  })

  it('treats a newly added event as information, not a failure', () => {
    const result = scan(fixture.root)
    const plan = generatePlan({ scan: result, kind: 'consumer', packs: ['core'] })
    const withExtra = {
      ...result,
      existingEvents: [
        ...result.existingEvents,
        { name: 'brand_new_event', file: 'src/New.tsx', line: 3, via: 'trackEvent' },
      ],
    }
    expect(checkDrift({ plan, scan: withExtra }).errors).toHaveLength(0)
    expect(checkDrift({ plan, scan: withExtra, strict: true }).errors.length).toBeGreaterThan(0)
  })
})

describe('demo data', () => {
  const plan = {
    version: 1 as const,
    generatedAt: '2026-08-15T00:00:00.000Z',
    generatedBy: 'test',
    product: { name: 'T', description: '', kind: 'consumer' as const, surfaces: ['web'] },
    events: [],
    roles: {
      page_view: '$pageview',
      signup_started: 'signup_started',
      signup_completed: 'signup_completed',
      core_action: 'item_created',
      error: 'error_shown',
    },
    identity: { distinctIdSource: '', sensitiveRoutes: [] },
    packs: ['core'],
    routes: ['/', '/items/:id'],
  }

  it('is deterministic for a given seed', () => {
    const now = Date.parse('2026-08-15T12:00:00.000Z')
    const a = generateDemoEvents({ plan, people: 40, days: 20, seed: 7, now })
    const b = generateDemoEvents({ plan, people: 40, days: 20, seed: 7, now })
    expect(a.length).toBe(b.length)
    expect(a[0]).toEqual(b[0])
  })

  it('produces a funnel that actually loses people at each step', () => {
    const generated = generateDemoEvents({ plan, people: 400, days: 30, seed: 1 })
    const count = (name: string) => new Set(generated.filter((e) => e.event === name).map((e) => e.distinctId)).size
    expect(count('$pageview')).toBeGreaterThan(count('signup_started'))
    expect(count('signup_started')).toBeGreaterThan(count('signup_completed'))
  })

  it('never puts an event in the future', () => {
    const now = Date.now()
    for (const event of generateDemoEvents({ plan, people: 60, days: 30, seed: 3 })) {
      expect(new Date(event.timestamp).getTime()).toBeLessThanOrEqual(now + 1000)
    }
  })

  it('tags everything so it can be told apart from real data', () => {
    for (const event of generateDemoEvents({ plan, people: 20, days: 10, seed: 5 })) {
      expect(event.properties.is_demo_data).toBe(true)
      expect(event.distinctId.startsWith('openhog_demo_')).toBe(true)
    }
  })

  it('spreads people across sources and devices', () => {
    const generated = generateDemoEvents({ plan, people: 200, days: 30, seed: 9 })
    const devices = new Set(generated.map((event) => event.properties.$device_type))
    expect(devices.size).toBeGreaterThan(1)
  })
})

describe('the random generator', () => {
  it('stays in range and does not immediately repeat', () => {
    const random = makeRandom(42)
    const values = Array.from({ length: 200 }, () => random())
    expect(Math.min(...values)).toBeGreaterThanOrEqual(0)
    expect(Math.max(...values)).toBeLessThan(1)
    expect(new Set(values).size).toBeGreaterThan(150)
  })
})

describe('argument parsing', () => {
  it('reads a command with flags', () => {
    const argv = parseArgs(['init', '--region', 'eu', '--yes'])
    expect(argv.command).toBe('init')
    expect(argv.flags.region).toBe('eu')
    expect(argv.flags.yes).toBe(true)
  })

  it('does not treat a leading flag as the command', () => {
    expect(parseArgs(['--help']).command).toBe('help')
    expect(parseArgs(['--version']).flags.version).toBe(true)
  })

  it('supports --flag=value and short flags', () => {
    const argv = parseArgs(['demo', '--people=800', '-y'])
    expect(argv.flags.people).toBe('800')
    expect(argv.flags.y).toBe(true)
  })

  it('defaults to help with no arguments', () => {
    expect(parseArgs([]).command).toBe('help')
  })
})

describe('framework-specific env handling', () => {
  it('uses the prefix each framework actually exposes to the browser', () => {
    expect(publicKeyEnvFor(['nextjs'])).toBe('NEXT_PUBLIC_POSTHOG_KEY')
    expect(publicKeyEnvFor(['sveltekit'])).toBe('PUBLIC_POSTHOG_KEY')
    expect(publicKeyEnvFor(['expo'])).toBe('EXPO_PUBLIC_POSTHOG_KEY')
    expect(publicKeyEnvFor(['react'])).toBe('VITE_PUBLIC_POSTHOG_KEY')
  })

  it('picks the right env accessor', () => {
    expect(envStyleFor(['nextjs'])).toBe('next')
    expect(envStyleFor(['react'])).toBe('vite')
    expect(envStyleFor(['express'])).toBe('process')
  })
})
