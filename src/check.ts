/**
 * Drift detection — `openhog check`.
 *
 * Instrumentation rots the way documentation rots, except silently: a refactor
 * drops a call site and the chart keeps drawing a plausible line at a lower
 * level, and nobody notices until a quarterly review. This compares the plan
 * against what the code emits right now and exits non-zero when they disagree,
 * so the disagreement is caught in a pull request instead.
 *
 * It is deliberately usable as a pre-commit or pre-push hook: no network calls,
 * no API key, sub-second on a large repo.
 */

import type { ScanResult, TrackingPlan } from './types.js'
import { resolveRoles } from './plan/roles.js'

export interface DriftItem {
  kind: 'removed' | 'added' | 'unimplemented' | 'role-lost' | 'untracked-route'
  name: string
  detail: string
}

export interface CheckReport {
  drift: DriftItem[]
  /** Fails the build. `added` and `unimplemented` are informational. */
  errors: DriftItem[]
  warnings: DriftItem[]
  stats: {
    planned: number
    emitted: number
    unimplemented: number
    routesTracked: number
    routesTotal: number
  }
}

export interface CheckOptions {
  plan: TrackingPlan
  scan: ScanResult
  /** Treat newly discovered events as errors too. Off by default. */
  strict?: boolean
}

export function checkDrift(options: CheckOptions): CheckReport {
  const { plan, scan } = options
  const emittedNow = new Set(scan.existingEvents.map((event) => event.name))
  const drift: DriftItem[] = []

  // The failure that matters: the plan says this is emitted, the code no longer
  // emits it, and some dashboard tile is therefore drawing a flat line.
  for (const event of plan.events) {
    if (event.emitted && !emittedNow.has(event.name)) {
      drift.push({
        kind: 'removed',
        name: event.name,
        detail: `The plan says this is emitted, but no call site was found. Previously at ${event.sources[0] ?? 'unknown'}. Any dashboard tile using it is now drawing a flat line.`,
      })
    }
  }

  // New events nobody added to the plan. Not an error by default: adding
  // tracking and then updating the plan is a perfectly normal order to work in.
  const planned = new Set(plan.events.map((event) => event.name))
  for (const name of emittedNow) {
    if (!planned.has(name)) {
      const call = scan.existingEvents.find((event) => event.name === name)
      drift.push({
        kind: 'added',
        name,
        detail: `Emitted at ${call?.file}:${call?.line} but not in the tracking plan. Run \`openhog sync\` to add it and pick up any dashboards it unlocks.`,
      })
    }
  }

  for (const event of plan.events) {
    if (!event.emitted && !emittedNow.has(event.name)) {
      drift.push({
        kind: 'unimplemented',
        name: event.name,
        detail: event.suggestedLocations?.[0]
          ? `Still unimplemented. Suggested location: ${event.suggestedLocations[0]}`
          : 'Still unimplemented.',
      })
    }
  }

  // A role that used to resolve and no longer does is the highest-signal drift
  // there is: it means a whole dashboard just lost its subject.
  const planEventsNow = plan.events.map((event) => ({ ...event, emitted: emittedNow.has(event.name) }))
  const rolesNow = resolveRoles(planEventsNow)
  for (const [roleName, previousEvent] of Object.entries(plan.roles)) {
    const current = rolesNow[roleName as keyof typeof rolesNow]
    if (!current?.event) {
      drift.push({
        kind: 'role-lost',
        name: roleName,
        detail: `No event resolves to the "${roleName}" role any more (was ${previousEvent}). Every dashboard tile built on it will disappear on the next sync.`,
      })
    }
  }

  // Routes with no page_view coverage are not an error, but a route that exists
  // and never appears in analytics is a blind spot worth naming.
  const trackedRoutes = new Set(plan.routes ?? [])
  const untracked = scan.routes.filter((route) => !trackedRoutes.has(route.path))
  for (const route of untracked.slice(0, 20)) {
    drift.push({
      kind: 'untracked-route',
      name: route.path,
      detail: `New route at ${route.file}. It is not in the plan's route list, so it will not be normalised and its ids may leak into $pathname.`,
    })
  }

  const errors = drift.filter(
    (item) => item.kind === 'removed' || item.kind === 'role-lost' || (options.strict && item.kind === 'added'),
  )
  const warnings = drift.filter((item) => !errors.includes(item))

  return {
    drift,
    errors,
    warnings,
    stats: {
      planned: plan.events.length,
      emitted: emittedNow.size,
      unimplemented: plan.events.filter((event) => !event.emitted).length,
      routesTracked: trackedRoutes.size,
      routesTotal: scan.routes.length,
    },
  }
}
