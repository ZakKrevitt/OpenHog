/**
 * Helpers for writing a dashboard pack.
 *
 * A pack author's whole job is: ask for a role, get an event name or null, and
 * build a tile that declares what it needs. Everything about skipping,
 * ordering, layout and documentation is handled for them, because a pack that
 * is tedious to write is a pack nobody contributes.
 */

import type { PackDashboard, PackTile, PostHogQuery, TileWidth, TrackingPlan } from '../types.js'
import type { EventRole } from '../plan/roles.js'

/** The event this repo uses for a role, or null when it emits nothing for it. */
export function role(plan: TrackingPlan, name: EventRole): string | null {
  return plan.roles[name] ?? null
}

/** First role that resolves. Lets a tile say "purchase, or failing that, checkout". */
export function firstRole(plan: TrackingPlan, ...names: EventRole[]): string | null {
  for (const name of names) {
    const resolved = plan.roles[name]
    if (resolved) return resolved
  }
  return null
}

export function hasRoles(plan: TrackingPlan, ...names: EventRole[]): boolean {
  return names.every((name) => Boolean(plan.roles[name]))
}

export interface TileInput {
  key: string
  name: string
  description: string
  interpretation: string
  query: PostHogQuery
  requires?: (string | null)[]
  width?: TileWidth
}

/**
 * Every event name a query references, wherever it appears in the tree.
 *
 * Derived rather than declared because a pack author will forget. A funnel built
 * from `[a, b, c].filter(Boolean)` charts three events while declaring two, and
 * an undeclared event is exactly the thing that must never reach a dashboard
 * without being checked.
 */
export function chartedEvents(query: unknown): string[] {
  const found = new Set<string>()

  // Fields that hold an event name: `event` on an EventsNode, `id` on a
  // retention entity, and the path endpoints on a PathsQuery.
  const EVENT_FIELDS = new Set(['event', 'id', 'startPoint', 'endPoint'])

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    if (!node || typeof node !== 'object') return
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (EVENT_FIELDS.has(key) && typeof value === 'string' && value) {
        found.add(value)
      } else if (key === 'query' && typeof value === 'string') {
        for (const name of eventsNamedInHogql(value)) found.add(name)
      } else {
        walk(value)
      }
    }
  }

  walk(query)
  return [...found]
}

/**
 * Event names a HogQL query filters on.
 *
 * Only literals in an `event = …` or `event IN (…)` position count. Harvesting
 * every quoted string instead would pull in `dateDiff('day', …)` and every other
 * incidental literal, and then report `day` as an event the dashboard charts.
 */
function eventsNamedInHogql(sqlText: string): string[] {
  const found: string[] = []
  for (const match of sqlText.matchAll(/\bevent\s*(?:=|!=)\s*'([^']+)'/gi)) {
    if (match[1]) found.push(match[1])
  }
  for (const match of sqlText.matchAll(/\bevent\s+(?:NOT\s+)?IN\s*\(([^)]*)\)/gi)) {
    for (const literal of (match[1] ?? '').matchAll(/'([^']+)'/g)) {
      if (literal[1]) found.push(literal[1])
    }
  }
  return found
}

/**
 * Build a tile. A `null` in `requires` means a role did not resolve, which
 * makes the tile un-buildable; returning null here is what removes it from the
 * dashboard rather than shipping a chart of a nonexistent event.
 */
export function tile(input: TileInput): PackTile | null {
  const requires = input.requires ?? []
  if (requires.some((value) => !value)) return null
  return {
    key: input.key,
    name: input.name,
    description: input.description,
    interpretation: input.interpretation,
    requires: requires.filter((value): value is string => Boolean(value)),
    charts: chartedEvents(input.query),
    width: input.width ?? 'half',
    query: input.query,
  }
}

export interface DashboardInput {
  key: string
  name: string
  description: string
  question: string
  tiles: (PackTile | null)[]
  /** Drop the dashboard entirely below this many surviving tiles. */
  minTiles?: number
}

/**
 * Assemble a dashboard from tiles that may have been skipped. A dashboard with
 * one tile left is noise on a sidebar, so `minTiles` defaults to 2.
 */
export function dashboard(input: DashboardInput): PackDashboard | null {
  const tiles = input.tiles.filter((value): value is PackTile => Boolean(value))
  if (tiles.length < (input.minTiles ?? 2)) return null
  return {
    key: input.key,
    name: input.name,
    description: input.description,
    question: input.question,
    tiles,
  }
}

export function compact(dashboards: (PackDashboard | null)[]): PackDashboard[] {
  return dashboards.filter((value): value is PackDashboard => Boolean(value))
}

/** A single-line HogQL string from a template, with the indentation stripped. */
export function sql(strings: TemplateStringsArray, ...values: unknown[]): string {
  const raw = strings.reduce((out, part, index) => out + part + (values[index] ?? ''), '')
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
}

/** Quote a list of event names for a HogQL `IN` clause. */
export function sqlList(values: string[]): string {
  return values.map((value) => `'${value.replace(/'/g, "\\'")}'`).join(', ')
}
