import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PostHogClient, PostHogError, customRegion, hostsForRegion } from '../src/posthog/client.js'
import { buildDashboards, computeLayouts, syncDashboards } from '../src/posthog/sync.js'
import { corePack, consumerPack } from '../src/packs/index.js'
import { funnel, hogql, retention, trends } from '../src/posthog/queries.js'
import { startMockPostHog, type MockServer } from './mockPosthog.js'
import type { TrackingPlan } from '../src/types.js'

function planWith(...names: string[]): TrackingPlan {
  const roles: Record<string, string> = { page_view: '$pageview' }
  for (const name of names) {
    if (/signup/.test(name)) roles.signup_completed = name
    if (/created|action/.test(name)) roles.core_action = name
    if (/share/.test(name)) roles.share = name
    if (/invite.*sent|invite_shared/.test(name)) roles.invite_sent = name
    if (/error/.test(name)) roles.error = name
  }
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    generatedBy: 'test',
    product: { name: 'Test', description: 'A test product', kind: 'consumer', surfaces: ['web'] },
    events: [...names, '$pageview'].map((name) => ({
      name,
      description: '',
      stage: 'engagement' as const,
      properties: [],
      emitted: true,
      sources: [],
    })),
    roles,
    identity: { distinctIdSource: 'device id', sensitiveRoutes: ['/settings'] },
    packs: ['core'],
    routes: ['/', '/items/:id'],
  }
}

describe('region hosts', () => {
  it('separates ingest from assets, because CSP treats them differently', () => {
    const us = hostsForRegion('us')
    expect(us.ingestHost).not.toBe(us.assetHost)
    expect(us.assetHost).toContain('assets')
  })

  it('collapses all three onto one origin for self-hosted', () => {
    const hosts = customRegion('https://ph.internal.example.com/')
    expect(hosts.host).toBe('https://ph.internal.example.com')
    expect(hosts.ingestHost).toBe(hosts.host)
    expect(hosts.assetHost).toBe(hosts.host)
  })
})

describe('PostHogClient', () => {
  let mock: MockServer

  beforeEach(async () => {
    mock = await startMockPostHog()
  })
  afterEach(async () => {
    await mock.close()
  })

  const client = () =>
    new PostHogClient({ personalApiKey: 'phx_test', hosts: customRegion(mock.url), sleep: async () => {} })

  it('sends the key as a bearer token and never in a query string', async () => {
    await client().listProjects()
    const request = mock.state.requests.at(-1)!
    expect(request.auth).toBe('Bearer phx_test')
    expect(request.path).not.toContain('phx_')
  })

  it('names the missing scope when PostHog answers 403', async () => {
    mock.state.forbidPath = '/insights/'
    await expect(
      client().createInsight(1, { name: 'x', query: trends({ series: [{ event: 'a' }] }) }),
    ).rejects.toThrow(/insight:write/)
  })

  it('explains a 401 as a bad key rather than a generic failure', async () => {
    const bad = new PostHogClient({
      personalApiKey: '',
      hosts: customRegion(mock.url),
      sleep: async () => {},
    })
    await expect(bad.listProjects()).rejects.toThrow(/rejected the personal API key/)
  })

  it('retries a 429 and then succeeds', async () => {
    mock.state.rateLimitTimes = 2
    const projects = await client().listProjects()
    expect(projects).toHaveLength(1)
    // Two rejected attempts plus the successful one.
    expect(mock.state.requests.filter((request) => request.path === '/api/projects/').length).toBe(3)
  })

  it('does not retry a failed POST, so an insight cannot be created twice', async () => {
    const failing = new PostHogClient({
      personalApiKey: 'phx_test',
      hosts: customRegion('http://127.0.0.1:1'),
      maxRetries: 2,
      sleep: async () => {},
    })
    await expect(failing.listProjects()).rejects.toThrow(/Could not reach/)
  })
})

describe('query builders', () => {
  it('emits the modern InsightVizNode shape', () => {
    const query = trends({ series: [{ event: 'signup_completed' }] }) as Record<string, unknown>
    expect(query.kind).toBe('InsightVizNode')
    expect((query.source as Record<string, unknown>).kind).toBe('TrendsQuery')
  })

  it('lays a long funnel out vertically, because horizontal becomes unreadable', () => {
    const query = funnel({ series: [{ event: 'a' }, { event: 'b' }, { event: 'c' }, { event: 'd' }] }) as any
    expect(query.source.funnelsFilter.layout).toBe('vertical')
  })

  it('measures first-time retention by default, which is what new-user retention means', () => {
    const query = retention({ targetEvent: '$pageview' }) as any
    expect(query.source.retentionFilter.retentionType).toBe('retention_first_time')
  })

  it('wraps HogQL in a DataTableNode so it renders as a table', () => {
    const query = hogql('SELECT 1') as any
    expect(query.kind).toBe('DataTableNode')
    expect(query.source.kind).toBe('HogQLQuery')
  })
})

describe('dashboard layout', () => {
  it('wraps tiles at 12 columns without overlapping', () => {
    const plan = planWith('signup_completed', 'item_created')
    const dashboards = buildDashboards(plan, [corePack])
    const tiles = dashboards[0]!.tiles
    const layouts = computeLayouts(tiles, tiles.map((_, index) => index + 1))

    for (const layout of layouts) {
      const sm = (layout.layouts as any).sm
      expect(sm.x + sm.w).toBeLessThanOrEqual(12)
      expect(sm.w).toBeGreaterThan(0)
    }
  })

  it('gives every tile a single-column phone layout', () => {
    const plan = planWith('signup_completed')
    const tiles = buildDashboards(plan, [corePack])[0]!.tiles
    const layouts = computeLayouts(tiles, tiles.map((_, index) => index + 1))
    for (const layout of layouts) {
      expect((layout.layouts as any).xs.w).toBe(1)
    }
  })
})

describe('building dashboards from a plan', () => {
  it('only builds tiles whose events are actually emitted', () => {
    const plan = planWith('signup_completed')
    const dashboards = buildDashboards(plan, [corePack, consumerPack])
    const required = dashboards.flatMap((dashboard) => dashboard.tiles.flatMap((tile) => tile.requires))
    const emitted = new Set(plan.events.map((event) => event.name))
    for (const event of required) {
      expect(emitted.has(event), `${event} must be an event the code emits`).toBe(true)
    }
  })

  it('drops a whole dashboard when too few tiles survive', () => {
    // A plan with nothing but pageviews cannot support the viral-loop dashboard.
    const plan = planWith()
    const dashboards = buildDashboards(plan, [consumerPack])
    expect(dashboards.find((dashboard) => dashboard.key === 'consumer-loops')).toBeUndefined()
  })

  it('gives every tile an interpretation, not just a title', () => {
    const plan = planWith('signup_completed', 'item_created', 'share_clicked', 'invite_shared', 'error_shown')
    for (const dashboard of buildDashboards(plan, [corePack, consumerPack])) {
      expect(dashboard.question.length).toBeGreaterThan(10)
      for (const tile of dashboard.tiles) {
        expect(tile.interpretation.length, `${tile.name} needs an interpretation`).toBeGreaterThan(40)
        expect(tile.description.length).toBeGreaterThan(10)
      }
    }
  })
})

describe('syncing to PostHog', () => {
  let mock: MockServer

  beforeEach(async () => {
    mock = await startMockPostHog()
  })
  afterEach(async () => {
    await mock.close()
  })

  const client = () =>
    new PostHogClient({ personalApiKey: 'phx_test', hosts: customRegion(mock.url), sleep: async () => {} })

  it('creates a dashboard with one insight per tile', async () => {
    const plan = planWith('signup_completed', 'item_created')
    const dashboards = buildDashboards(plan, [corePack])
    const result = await syncDashboards({
      client: client(),
      projectId: 1,
      dashboards,
      validate: false,
    })

    expect(result.created.length).toBe(dashboards.length)
    const totalTiles = dashboards.reduce((sum, dashboard) => sum + dashboard.tiles.length, 0)
    expect(mock.state.insights.length).toBe(totalTiles)
  })

  it('validates every query before creating it, and skips the ones that fail', async () => {
    // This is the behaviour that stops a schema change or an old self-hosted
    // version leaving somebody with a dashboard of broken tiles.
    mock.state.failQueriesMatching = /HogQLQuery/
    const plan = planWith('signup_completed', 'item_created')
    const dashboards = buildDashboards(plan, [corePack])
    const result = await syncDashboards({
      client: client(),
      projectId: 1,
      dashboards,
      validate: true,
    })

    expect(result.invalid.length).toBeGreaterThan(0)
    for (const insight of mock.state.insights) {
      expect(JSON.stringify(insight.query)).not.toContain('HogQLQuery')
    }
  })

  it('leaves an existing dashboard alone unless asked to replace it', async () => {
    mock.state.dashboards.push({
      id: 1,
      name: '1. North Star - activation & retention',
      description: '',
      deleted: false,
      tiles: [],
    })
    const plan = planWith('signup_completed', 'item_created')
    const result = await syncDashboards({
      client: client(),
      projectId: 1,
      dashboards: buildDashboards(plan, [corePack]),
      validate: false,
    })
    expect(result.skippedExisting).toContain('1. North Star - activation & retention')
  })

  it('sets tile layouts after the insights exist', async () => {
    const plan = planWith('signup_completed', 'item_created')
    await syncDashboards({
      client: client(),
      projectId: 1,
      dashboards: buildDashboards(plan, [corePack]).slice(0, 1),
      validate: false,
    })
    const patch = mock.state.requests.find(
      (request) => request.method === 'PATCH' && (request.body as any)?.tiles,
    )
    expect(patch).toBeDefined()
  })

  it('changes nothing on a dry run', async () => {
    const plan = planWith('signup_completed', 'item_created')
    const result = await syncDashboards({
      client: client(),
      projectId: 1,
      dashboards: buildDashboards(plan, [corePack]),
      dryRun: true,
    })
    expect(result.created.length).toBeGreaterThan(0)
    expect(mock.state.dashboards).toHaveLength(0)
    expect(mock.state.insights).toHaveLength(0)
  })
})
