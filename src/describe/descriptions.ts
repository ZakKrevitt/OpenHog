/**
 * What to write onto a PostHog event definition.
 *
 * PostHog surfaces an event's description everywhere in its own product: the
 * event list, the insight builder, every picker anybody opens to build a chart.
 * A project where all of them are empty - which is every project by default -
 * makes each new person rediscover what `auth_prompt_action` means by reading
 * the codebase. Filling them in is the highest-leverage thing OpenHog can do
 * inside PostHog's own website, because it is permanent, organisation-wide, and
 * helps people who will never run this tool.
 *
 * Descriptions come from the best source available, in order:
 *
 *   1. The tracking plan, if there is one. Written or edited by a human.
 *   2. The role the event resolved to, which says what it means in the funnel.
 *   3. Its behaviour, which is all we know for an event nobody has named.
 *
 * Nothing here ever invents a claim about intent. An event whose meaning cannot
 * be established from any of the three is left alone rather than given a
 * description that restates its own name back at the reader.
 */

import type { TrackingPlan } from '../types.js'
import type { EventVolume } from '../metrics/discover.js'
import { ROLE_DESCRIPTIONS, type EventRole } from '../plan/roles.js'

/** Where a description came from, so the preview can show it. */
export type DescriptionSource = 'plan' | 'role' | 'behaviour'

export interface ProposedDescription {
  event: string
  description: string
  source: DescriptionSource
  tags: string[]
  /** The description already on the definition, if any. */
  existing?: string | null
  /** True when this event is in the tracking plan, so it is a named, intended event. */
  planned: boolean
}

/** Kept short: PostHog shows these inline, and a paragraph gets truncated. */
const MAX_DESCRIPTION = 400

function trim(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > MAX_DESCRIPTION ? `${clean.slice(0, MAX_DESCRIPTION - 1)}…` : clean
}

/**
 * A description that only restates the event's own name teaches nobody
 * anything, and writing hundreds of them into somebody's project is noise
 * dressed up as documentation.
 */
export function isVacuous(event: string, description: string): boolean {
  const normalise = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '')
  return normalise(description).startsWith(normalise(event)) && description.length < event.length + 24
}

export interface BuildOptions {
  plan?: TrackingPlan | null
  roles: Record<string, string>
  events: EventVolume[]
  existing: Map<string, string | null | undefined>
  /** Marks which roles were guessed from behaviour rather than read from a name. */
  inferredRoles?: string[]
}

export function buildDescriptions(options: BuildOptions): ProposedDescription[] {
  const { plan, roles, events, existing } = options
  const inferred = new Set(options.inferredRoles ?? [])
  const planByName = new Map((plan?.events ?? []).map((event) => [event.name, event]))

  // Invert the role map so an event can say which role it plays.
  const roleOf = new Map<string, EventRole>()
  for (const [role, event] of Object.entries(roles)) {
    if (!roleOf.has(event)) roleOf.set(event, role as EventRole)
  }

  const proposals: ProposedDescription[] = []

  for (const entry of events) {
    // PostHog's own events are documented by PostHog. Writing over them would
    // be presumptuous and would break the meaning other tools rely on.
    if (entry.event.startsWith('$')) continue

    const planned = planByName.get(entry.event)
    const role = roleOf.get(entry.event)
    const tags = ['openhog']
    let description: string | null = null
    let source: DescriptionSource = 'behaviour'

    if (planned?.description && !isVacuous(entry.event, planned.description)) {
      description = planned.description
      source = 'plan'
      tags.push(planned.stage)
    } else if (role) {
      const meaning = ROLE_DESCRIPTIONS[role]
      const guessed = inferred.has(role)
        ? ' OpenHog matched this from how the event behaves rather than from its name, so it is worth confirming.'
        : ''
      description = `${meaning} OpenHog reads this as the "${role}" step for this product.${guessed}`
      source = 'role'
      tags.push(`role:${role}`)
    } else if (entry.people >= 20) {
      // No plan, no role. All that is honestly known is the shape.
      const perPerson = entry.events / Math.max(1, entry.people)
      const shape =
        perPerson <= 1.2
          ? 'Happens about once per person, so it reads as a one-off milestone rather than a repeated action.'
          : perPerson >= 4
            ? 'Fires many times per person, so it reads as a habitual action.'
            : 'Fires a few times per person.'
      description = `${shape} Seen from ${entry.people.toLocaleString()} people in the last 30 days. No description was set, and OpenHog could not tell what it means from its name.`
      source = 'behaviour'
    }

    if (!description) continue
    const text = trim(description)
    if (isVacuous(entry.event, text)) continue

    proposals.push({
      event: entry.event,
      description: text,
      source,
      tags,
      existing: existing.get(entry.event),
      planned: Boolean(planned),
    })
  }

  // Named, intended events first: those are the ones people look up.
  const rank: Record<DescriptionSource, number> = { plan: 0, role: 1, behaviour: 2 }
  return proposals.sort(
    (a, b) => rank[a.source] - rank[b.source] || a.event.localeCompare(b.event),
  )
}

/**
 * Which proposals would actually change anything.
 *
 * A description somebody wrote by hand is never replaced without being asked
 * for explicitly: it is almost certainly better than anything generated, and
 * silently overwriting other people's documentation is the kind of thing that
 * gets a tool banned from an organisation.
 */
export function toApply(
  proposals: ProposedDescription[],
  options: { overwrite?: boolean } = {},
): { apply: ProposedDescription[]; keptExisting: ProposedDescription[] } {
  const apply: ProposedDescription[] = []
  const keptExisting: ProposedDescription[] = []

  for (const proposal of proposals) {
    const current = proposal.existing?.trim()
    if (!current) {
      apply.push(proposal)
      continue
    }
    if (current === proposal.description) continue // already ours, nothing to do
    if (options.overwrite) apply.push(proposal)
    else keptExisting.push(proposal)
  }

  return { apply, keptExisting }
}
