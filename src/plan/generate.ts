/**
 * Turn a scan into a tracking plan.
 *
 * The plan is the contract everything else reads: dashboards are built from it,
 * the analytics module is generated from it, the walkthrough is written from it,
 * and `openhog check` diffs the code against it. It is a plain JSON file the
 * user is expected to edit, so it carries descriptions and sources rather than
 * just names.
 */

import type { PlanEvent, PlanProperty, ProductKind, ScanResult, Stage, TrackingPlan } from '../types.js'
import { sensitiveRoutes } from '../scan/routes.js'
import { resolveRoles, roleMap } from './roles.js'
import { suggestEvents } from './suggestions.js'

const VERSION = '0.1.0'

/** Guess the lifecycle stage of an event name found in code. */
export function stageForEvent(name: string): Stage {
  if (/(sign_?up|register|account_created|waitlist|landing|utm|campaign|install)/.test(name)) return 'acquisition'
  if (/(onboard|activat|first_|setup|welcome|import|upload)/.test(name)) return 'activation'
  if (/(purchase|checkout|payment|order|subscri|upgrade|plan|pricing|trial|paywall)/.test(name)) return 'conversion'
  if (/(share|invite|refer|follow|friend|social|viral)/.test(name)) return 'referral'
  if (/(error|fail|empty|not_found|offline|timeout|crash)/.test(name)) return 'health'
  if (/(retention|return|notification|push|digest|reminder)/.test(name)) return 'retention'
  return 'engagement'
}

/** A readable sentence for an event we only know the name of. */
export function describeEvent(name: string): string {
  const words = name.replace(/[_.]/g, ' ').trim()
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}. Found in the codebase; edit this description to say what it means and when it fires.`
}

/**
 * Properties every event should carry. These are what make a breakdown useful:
 * without `surface` you can count clicks but not say where they happened.
 */
export const BASE_PROPERTIES: PlanProperty[] = [
  {
    name: 'surface',
    type: 'string',
    description: 'Which part of the product this happened in. A small, fixed set of names.',
  },
  {
    name: 'route',
    type: 'string',
    description: 'The normalised route, with ids replaced by :params.',
  },
]

export interface GenerateOptions {
  scan: ScanResult
  kind: ProductKind
  packs: string[]
  /** Merged over the generated events, so a hand-edited plan survives a re-run. */
  existing?: TrackingPlan | null
  distinctIdSource?: string
}

export function generatePlan(options: GenerateOptions): TrackingPlan {
  const { scan, kind } = options

  const emittedNames = new Set(scan.existingEvents.map((event) => event.name))

  // Events the code actually sends, one entry per name with every call site.
  const bySource = new Map<string, string[]>()
  for (const call of scan.existingEvents) {
    const list = bySource.get(call.name) ?? []
    list.push(`${call.file}:${call.line}`)
    bySource.set(call.name, list)
  }

  const codeEvents: PlanEvent[] = [...bySource.entries()].map(([name, sources]) => ({
    name,
    description: describeEvent(name),
    stage: stageForEvent(name),
    properties: [...BASE_PROPERTIES],
    emitted: true,
    sources: sources.slice(0, 10),
    origin: 'code' as const,
  }))

  const suggested = suggestEvents(scan, kind, emittedNames).filter(
    (event) => !emittedNames.has(event.name),
  )

  let events = [...codeEvents, ...suggested]

  // A hand-edited plan wins on everything a human could have written. Only
  // `emitted` and `sources` are re-derived, because those are facts about the
  // current code rather than opinions about the product.
  if (options.existing) {
    const previous = new Map(options.existing.events.map((event) => [event.name, event]))
    events = events.map((event) => {
      const prior = previous.get(event.name)
      if (!prior) return event
      return {
        ...prior,
        emitted: event.emitted,
        sources: event.sources,
        origin: prior.origin ?? event.origin,
      }
    })
    // Keep events the user added by hand that the scanner cannot see, e.g.
    // server-side events emitted from a language we do not parse.
    for (const [name, prior] of previous) {
      if (!events.some((event) => event.name === name)) {
        events.push({ ...prior, emitted: emittedNames.has(name) })
      }
    }
  }

  events.sort((a, b) => {
    if (a.emitted !== b.emitted) return a.emitted ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  const roles = roleMap(resolveRoles(events))

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    generatedBy: `openhog@${VERSION}`,
    product: {
      name: scan.product.name,
      description: scan.product.description,
      kind,
      surfaces: scan.surfaces,
      url: scan.product.url,
    },
    events,
    roles,
    identity: {
      distinctIdSource:
        options.distinctIdSource ??
        options.existing?.identity.distinctIdSource ??
        'A stable per-device id, replaced by the account id once someone signs in.',
      sensitiveRoutes:
        options.existing?.identity.sensitiveRoutes ?? sensitiveRoutes(scan.routes),
    },
    packs: options.packs,
    routes: scan.routes.map((route) => route.path),
  }
}

export interface PlanStats {
  total: number
  emitted: number
  suggested: number
  rolesResolved: number
  rolesTotal: number
  byStage: Record<string, number>
}

export function planStats(plan: TrackingPlan): PlanStats {
  const byStage: Record<string, number> = {}
  for (const event of plan.events) {
    byStage[event.stage] = (byStage[event.stage] ?? 0) + 1
  }
  const resolutions = resolveRoles(plan.events)
  return {
    total: plan.events.length,
    emitted: plan.events.filter((event) => event.emitted).length,
    suggested: plan.events.filter((event) => !event.emitted).length,
    rolesResolved: Object.keys(plan.roles).length,
    rolesTotal: Object.keys(resolutions).length,
    byStage,
  }
}
