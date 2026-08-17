/**
 * Work out what a PostHog project is measuring, from the project alone.
 *
 * This is what makes `openhog explain` work with no repository, no config and
 * no code changes: the event names PostHog has already seen are enough to
 * resolve the same roles the dashboard packs are written against. Somebody who
 * has been sending events for two years can get a diagnosis in thirty seconds
 * without touching their codebase.
 *
 * Volume matters here in a way it does not when reading source. Two events may
 * both look like a signup; the one that fires ten thousand times a month is the
 * real one, and the one that fires eleven times is a leftover from an
 * experiment.
 */

import type { PostHogClient } from '../posthog/client.js'
import type { PlanEvent, ProductKind } from '../types.js'
import { resolveRoles, roleMap } from '../plan/roles.js'

export interface EventVolume {
  event: string
  events: number
  people: number
}

export interface Discovery {
  events: EventVolume[]
  roles: Record<string, string>
  /**
   * Roles that came from behaviour rather than from the event's name. These are
   * guesses and are labelled as such wherever they are shown, because a wrong
   * one silently changes what a finding claims.
   */
  inferredRoles: string[]
  activePeople: number
  totalEvents: number
  daysOfData: number
  productKind: ProductKind
  /** Why that product kind was chosen, for the report. */
  kindReasons: string[]
}

const VOLUME_QUERY = `
  SELECT
    event,
    count() AS events,
    count(DISTINCT distinct_id) AS people
  FROM events
  WHERE timestamp > now() - INTERVAL 30 DAY
  GROUP BY event
  ORDER BY events DESC
  LIMIT 300
`

const SHAPE_QUERY = `
  SELECT
    count(DISTINCT distinct_id) AS people,
    count() AS total_events,
    dateDiff('day', min(timestamp), now()) AS days_of_data
  FROM events
  WHERE timestamp > now() - INTERVAL 365 DAY
`

interface QueryResponse {
  results?: unknown[][]
}

const num = (value: unknown): number => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

export async function discoverProject(
  client: PostHogClient,
  projectId: number,
): Promise<Discovery> {
  const [volumeResponse, shapeResponse] = await Promise.all([
    client.query<QueryResponse>(projectId, { kind: 'HogQLQuery', query: VOLUME_QUERY }),
    client.query<QueryResponse>(projectId, { kind: 'HogQLQuery', query: SHAPE_QUERY }),
  ])

  const events: EventVolume[] = (volumeResponse.results ?? [])
    .map((row) => ({
      event: String(row[0] ?? ''),
      events: num(row[1]),
      people: num(row[2]),
    }))
    .filter((entry) => entry.event)

  const shape = shapeResponse.results?.[0] ?? []

  // Only events with real volume are eligible to back a role. A role resolved
  // to something that fired four times produces a chart that looks broken and a
  // finding that is simply wrong.
  const eligible = events.filter((entry) => entry.people >= 3 || entry.event.startsWith('$'))

  const planEvents: PlanEvent[] = eligible.map((entry) => ({
    name: entry.event,
    description: '',
    stage: 'engagement',
    properties: [],
    emitted: true,
    sources: [],
  }))

  const volumes = Object.fromEntries(eligible.map((entry) => [entry.event, entry.people]))
  const namedRoles = roleMap(resolveRoles(planEvents, { volumes }))

  // Vocabulary runs out. `kyc_passed`, `level_completed`, `nutzer_registriert`
  // and `usr_reg_ok` all mean something a pattern list will never cover, and a
  // tool other people install has to cope with taxonomies nobody has seen.
  // Behaviour is language-independent, so it fills what the names could not.
  const { roles, inferred } = inferRolesFromShape(namedRoles, eligible, num(shape[0]))

  const kind = guessKindFromEvents(events.map((entry) => entry.event))

  return {
    events,
    roles,
    inferredRoles: inferred,
    activePeople: num(shape[0]),
    totalEvents: num(shape[1]),
    daysOfData: num(shape[2]),
    productKind: kind.kind,
    kindReasons: kind.reasons,
  }
}

/**
 * Fill unresolved roles from the shape of the data rather than from names.
 *
 * Two signals, both free because discovery already counts events and people:
 *
 *   - **Events per person near 1.0** means a milestone: something that happens
 *     once in a person's life, like signing up or completing onboarding. If it
 *     also covers a minority of people, it is a conversion step rather than
 *     something everyone does.
 *   - **A high events-per-person ratio** on a non-pageview event means a
 *     habitual action: the thing the product is actually for.
 *
 * Neither depends on the language the event was named in, which is the point.
 * Both are guesses, so they only ever fill a role the names could not, and they
 * are reported separately so nobody mistakes them for a reading of intent.
 */
function inferRolesFromShape(
  named: Record<string, string>,
  events: EventVolume[],
  totalPeople: number,
): { roles: Record<string, string>; inferred: string[] } {
  const roles = { ...named }
  const inferred: string[] = []
  const taken = new Set(Object.values(roles))

  const candidates = events.filter(
    (entry) =>
      !entry.event.startsWith('$') &&
      !taken.has(entry.event) &&
      entry.people >= 20 &&
      entry.events > 0,
  )
  if (!candidates.length || totalPeople <= 0) return { roles, inferred }

  const perPerson = (entry: EventVolume) => entry.events / Math.max(1, entry.people)
  const reach = (entry: EventVolume) => entry.people / totalPeople

  // A once-per-person event that a minority reach is a conversion milestone.
  if (!roles.signup_completed) {
    const milestone = candidates
      .filter((entry) => perPerson(entry) <= 1.35 && reach(entry) > 0.02 && reach(entry) < 0.9)
      .sort((a, b) => b.people - a.people)[0]
    if (milestone) {
      roles.signup_completed = milestone.event
      taken.add(milestone.event)
      inferred.push('signup_completed')
    }
  }

  // The most-repeated non-pageview event is the habitual one.
  if (!roles.core_action && !roles.activation) {
    const habitual = candidates
      .filter((entry) => !taken.has(entry.event) && perPerson(entry) >= 2)
      .sort((a, b) => perPerson(b) * b.people - perPerson(a) * a.people)[0]
    if (habitual) {
      roles.core_action = habitual.event
      taken.add(habitual.event)
      inferred.push('core_action')
    }
  }

  return { roles, inferred }
}

/**
 * Infer the product kind from event vocabulary alone.
 *
 * Weaker evidence than reading a codebase, so it is only ever a default the
 * user can override with `--kind`. It exists because the benchmarks a finding
 * compares against differ sharply by product type: 20% week-1 retention is
 * respectable for a consumer app and alarming for a paid B2B tool.
 */
export function guessKindFromEvents(eventNames: string[]): {
  kind: ProductKind
  reasons: string[]
} {
  const all = eventNames.join(' ').toLowerCase()
  const has = (...words: string[]) => words.some((word) => all.includes(word))
  const scores: Record<ProductKind, number> = {
    saas: 0,
    consumer: 0,
    marketplace: 0,
    ecommerce: 0,
    'ai-app': 0,
    devtool: 0,
    content: 0,
  }
  const reasons: string[] = []

  if (has('subscription', 'trial', 'seat', 'workspace', 'team_', 'plan_', 'billing')) {
    scores.saas += 4
    reasons.push('subscription, trial or workspace events → saas')
  }
  if (has('cart', 'checkout', 'order', 'product_view', 'add_to_cart', 'shipping')) {
    scores.ecommerce += 4
    reasons.push('cart and checkout events → ecommerce')
  }
  if (has('listing', 'seller', 'buyer', 'booking', 'reservation', 'host_')) {
    scores.marketplace += 4
    reasons.push('listing or booking events → marketplace')
  }
  if (has('generation', 'prompt', 'completion', 'model_', 'regenerate', 'llm')) {
    scores['ai-app'] += 4
    reasons.push('generation or prompt events → ai-app')
  }
  if (has('api_key', 'first_success', 'install', 'sdk_', 'docs_', 'quickstart')) {
    scores.devtool += 4
    reasons.push('api key, install or docs events → devtool')
  }
  if (has('article', 'post_read', 'scroll_depth', 'read_', 'newsletter', 'subscribe')) {
    scores.content += 3
    reasons.push('reading and subscription events → content')
  }
  if (has('share', 'invite', 'follow', 'friend', 'feed', 'like', 'notification')) {
    scores.consumer += 3
    reasons.push('social, sharing or feed events → consumer')
  }

  let kind: ProductKind = 'consumer'
  let best = 0
  for (const [candidate, score] of Object.entries(scores) as [ProductKind, number][]) {
    if (score > best) {
      best = score
      kind = candidate
    }
  }
  if (best === 0) {
    reasons.push('no strong signal in the event names; assuming a consumer product')
  }

  return { kind, reasons }
}
