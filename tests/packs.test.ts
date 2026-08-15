/**
 * Rules every pack must follow, enforced across the whole registry.
 *
 * A pack is the easiest thing to contribute and the easiest to contribute badly:
 * a tile with a title and no explanation is a chart nobody can act on, and a
 * tile that charts an event nothing emits is the exact failure this project
 * exists to prevent. Both fail here rather than in review.
 */

import { describe, expect, it } from 'vitest'
import { PACKS, packsForKind } from '../src/packs/index.js'
import { buildDashboards } from '../src/posthog/sync.js'
import { PRODUCT_KINDS, type TrackingPlan } from '../src/types.js'
import { ALL_ROLES } from '../src/plan/roles.js'

/** A plan where every role resolves, so each pack builds its full catalogue. */
function maximalPlan(): TrackingPlan {
  const roles: Record<string, string> = {}
  for (const role of ALL_ROLES) roles[role] = role === 'page_view' ? '$pageview' : `${role}_event`

  return {
    version: 1,
    generatedAt: '2026-08-15T00:00:00.000Z',
    generatedBy: 'test',
    product: { name: 'Everything', description: 'A product with every role', kind: 'saas', surfaces: ['web'] },
    events: Object.values(roles).map((name) => ({
      name,
      description: '',
      stage: 'engagement' as const,
      properties: [],
      emitted: true,
      sources: [],
    })),
    roles,
    identity: { distinctIdSource: 'device id', sensitiveRoutes: [] },
    packs: PACKS.map((pack) => pack.id),
    routes: ['/', '/items/:id'],
  }
}

/** A plan with nothing but pageviews. */
function minimalPlan(): TrackingPlan {
  return {
    ...maximalPlan(),
    events: [{ name: '$pageview', description: '', stage: 'engagement', properties: [], emitted: true, sources: [] }],
    roles: { page_view: '$pageview' },
  }
}

describe.each(PACKS.map((pack) => [pack.id, pack] as const))('the %s pack', (id, pack) => {
  const dashboards = buildDashboards(maximalPlan(), [pack])

  it('declares which product kinds it applies to', () => {
    expect(pack.appliesTo.length).toBeGreaterThan(0)
    for (const kind of pack.appliesTo) expect(PRODUCT_KINDS).toContain(kind)
  })

  it('builds at least one dashboard when every role resolves', () => {
    expect(dashboards.length).toBeGreaterThan(0)
  })

  it('gives every dashboard a real question, not a restated title', () => {
    for (const dashboard of dashboards) {
      expect(dashboard.question.length, `${dashboard.name}`).toBeGreaterThan(15)
      expect(dashboard.question).toMatch(/\?$/)
      expect(dashboard.description.length).toBeGreaterThan(30)
    }
  })

  it('gives every tile an interpretation that says what to DO', () => {
    for (const dashboard of dashboards) {
      for (const tile of dashboard.tiles) {
        expect(tile.description.length, `${id} › ${tile.name} description`).toBeGreaterThan(15)
        expect(tile.interpretation.length, `${id} › ${tile.name} interpretation`).toBeGreaterThan(60)
        // A description that just restates the title teaches nobody anything.
        expect(tile.interpretation).not.toBe(tile.description)
      }
    }
  })

  it('uses tile keys that are unique within a dashboard', () => {
    for (const dashboard of dashboards) {
      const keys = dashboard.tiles.map((tile) => tile.key)
      expect(new Set(keys).size, `${dashboard.name} has duplicate tile keys`).toBe(keys.length)
    }
  })

  it('only ever charts events the plan says are emitted', () => {
    // The core guarantee. `requires` gates the tile; `charts` is derived from
    // the query, so an optional funnel step cannot slip past unchecked.
    const plan = maximalPlan()
    const emitted = new Set(plan.events.filter((event) => event.emitted).map((event) => event.name))
    for (const dashboard of dashboards) {
      for (const tile of dashboard.tiles) {
        for (const event of tile.charts) {
          if (event.startsWith('$')) continue
          expect(
            emitted.has(event),
            `${id} › ${tile.name} charts "${event}", which nothing emits`,
          ).toBe(true)
        }
      }
      for (const tile of dashboard.tiles) {
        for (const required of tile.requires) {
          if (required.startsWith('$')) continue
          expect(tile.charts, `${id} › ${tile.name} requires an event it never charts`).toContain(required)
        }
      }
    }
  })

  it('emits a query PostHog would recognise', () => {
    for (const dashboard of dashboards) {
      for (const tile of dashboard.tiles) {
        const query = tile.query as { kind?: string; source?: { kind?: string } }
        expect(['InsightVizNode', 'DataTableNode']).toContain(query.kind)
        expect(query.source?.kind, `${id} › ${tile.name}`).toBeTruthy()
      }
    }
  })

  it('builds nothing rather than something empty when no events exist', () => {
    // The whole guarantee: a codebase with no instrumentation gets no charts,
    // not charts of events it does not send.
    const built = buildDashboards(minimalPlan(), [pack])
    for (const dashboard of built) {
      for (const tile of dashboard.tiles) {
        for (const event of tile.charts) {
          expect(event, `${id} › ${tile.name} charts an unemitted event`).toMatch(/^\$/)
        }
      }
    }
  })
})

describe('the registry', () => {
  it('has no duplicate pack ids', () => {
    const ids = PACKS.map((pack) => pack.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('gives every product kind the core pack plus at least one specific pack', () => {
    for (const kind of PRODUCT_KINDS) {
      const packs = packsForKind(kind)
      expect(packs.map((pack) => pack.id), `${kind}`).toContain('core')
      expect(packs.length, `${kind} has no specific pack`).toBeGreaterThan(1)
    }
  })

  it('produces dashboard names that are unique across every pack combination', () => {
    for (const kind of PRODUCT_KINDS) {
      const dashboards = buildDashboards(maximalPlan(), packsForKind(kind))
      const names = dashboards.map((dashboard) => dashboard.name)
      expect(new Set(names).size, `${kind} has duplicate dashboard names`).toBe(names.length)
    }
  })
})
