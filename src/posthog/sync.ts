/**
 * Build the dashboards and push them to PostHog.
 *
 * The important behaviour here is validation. Before a tile is attached to a
 * dashboard its query is executed against the project. A query that errors is
 * reported and skipped rather than created, so a PostHog schema change, an
 * unsupported HogQL function on an older self-hosted version, or a bad pack
 * contribution can never leave someone with a dashboard of broken tiles.
 *
 * That inverts the usual failure mode. Every hosted wizard optimistically
 * creates whatever it planned; OpenHog only ships tiles it has watched work.
 */

import type { CreatedDashboard, Pack, PackDashboard, PackTile, TrackingPlan } from '../types.js'
import type { PostHogClient } from './client.js'
import { PostHogError } from './client.js'

/** Grid widths in PostHog's 12-column `sm` breakpoint. */
const WIDTHS = { third: 4, half: 6, full: 12 } as const

/** Tables and matrices need more vertical room than a line chart. */
function tileHeight(tile: PackTile): number {
  const query = tile.query as { kind?: string; source?: { kind?: string; trendsFilter?: { display?: string } } }
  const sourceKind = query.source?.kind
  if (query.kind === 'DataTableNode') return 8
  if (sourceKind === 'RetentionQuery' || sourceKind === 'PathsQuery') return 8
  if (sourceKind === 'FunnelsQuery') return 6
  if (query.source?.trendsFilter?.display === 'BoldNumber') return 3
  return 5
}

/**
 * Pack a list of tiles into the grid, left to right, wrapping at 12 columns.
 * PostHog will happily accept overlapping layouts and render a mess, so the
 * cursor is tracked rather than computed per tile.
 */
export function computeLayouts(tiles: PackTile[], tileIds: number[]): { id: number; layouts: Record<string, unknown> }[] {
  let x = 0
  let y = 0
  let rowHeight = 0

  return tiles.map((tile, index) => {
    const w = WIDTHS[tile.width ?? 'half']
    const h = tileHeight(tile)
    if (x + w > 12) {
      x = 0
      y += rowHeight
      rowHeight = 0
    }
    const layout = {
      sm: { i: String(tileIds[index]), x, y, w, h, minW: 3, minH: 3 },
      // One column on phones. PostHog does not compute this and a dashboard
      // without it is unreadable on a phone, which is where people check
      // numbers most often.
      xs: { i: String(tileIds[index]), x: 0, y: index * h, w: 1, h, minW: 1, minH: 3 },
    }
    x += w
    rowHeight = Math.max(rowHeight, h)
    return { id: tileIds[index]!, layouts: layout }
  })
}

export function buildDashboards(plan: TrackingPlan, packs: Pack[]): PackDashboard[] {
  const dashboards: PackDashboard[] = []
  const seen = new Set<string>()
  for (const pack of packs) {
    for (const dashboard of pack.build(plan)) {
      if (seen.has(dashboard.key)) continue
      seen.add(dashboard.key)
      dashboards.push(dashboard)
    }
  }
  return dashboards
}

/** Tiles a pack wanted but could not build, and why. Drives the walkthrough. */
export interface SkippedTile {
  dashboard: string
  tile: string
  reason: string
  missingRoles?: string[]
}

export function reportSkipped(plan: TrackingPlan, packs: Pack[]): SkippedTile[] {
  // A pack's build() already drops un-buildable tiles, so the useful report is
  // the inverse: which roles never resolved, and therefore which questions this
  // project currently cannot answer.
  const unresolved: SkippedTile[] = []
  const built = buildDashboards(plan, packs)
  const builtKeys = new Set(built.flatMap((dashboard) => dashboard.tiles.map((tile) => tile.key)))

  // Re-run each pack against a plan where every role resolves, to see the full
  // catalogue, then diff. This is the only honest way to say "you are missing
  // these six charts because you do not emit a share event".
  const fullPlan: TrackingPlan = {
    ...plan,
    events: [...plan.events, { name: '__openhog_probe', description: '', stage: 'engagement', properties: [], emitted: true, sources: [] }],
    roles: Object.fromEntries(
      [
        'page_view', 'signup_started', 'signup_completed', 'signin', 'onboarding_started',
        'onboarding_completed', 'activation', 'core_action', 'search', 'content_opened', 'save',
        'share', 'invite_sent', 'invite_accepted', 'follow', 'message_sent', 'upload',
        'checkout_started', 'purchase', 'subscription_started', 'subscription_cancelled',
        'pricing_viewed', 'trial_started', 'ai_generation', 'ai_feedback', 'feature_used',
        'notification_opened', 'error', 'empty_state', 'install', 'api_key_created', 'first_success',
      ].map((role) => [role, plan.roles[role] ?? '__openhog_probe']),
    ),
  }

  for (const dashboard of buildDashboards(fullPlan, packs)) {
    for (const tile of dashboard.tiles) {
      if (builtKeys.has(tile.key)) continue
      const missing = tile.requires.filter((event) => event === '__openhog_probe')
      unresolved.push({
        dashboard: dashboard.name,
        tile: tile.name,
        reason: 'Needs an event this codebase does not emit yet.',
        missingRoles: missing.length ? missing : undefined,
      })
    }
  }
  return unresolved
}

export interface SyncOptions {
  client: PostHogClient
  projectId: number
  dashboards: PackDashboard[]
  /** Run every query before creating it. Strongly recommended. */
  validate?: boolean
  /** Soft-delete an existing dashboard of the same name first. */
  replace?: boolean
  pinned?: boolean
  tags?: string[]
  onProgress?: (message: string) => void
  /** Do everything except write. */
  dryRun?: boolean
}

export interface SyncResult {
  created: CreatedDashboard[]
  /** Tiles whose query failed validation, with the error PostHog gave. */
  invalid: { dashboard: string; tile: string; error: string }[]
  /** Dashboards left alone because they already existed. */
  skippedExisting: string[]
}

export async function syncDashboards(options: SyncOptions): Promise<SyncResult> {
  const { client, projectId, dashboards } = options
  const validate = options.validate ?? true
  const progress = options.onProgress ?? (() => {})

  const result: SyncResult = { created: [], invalid: [], skippedExisting: [] }

  const existing = options.dryRun ? [] : await client.listDashboards(projectId)
  const existingByName = new Map(
    existing.filter((dashboard) => !dashboard.deleted).map((dashboard) => [dashboard.name, dashboard.id]),
  )

  for (const dashboard of dashboards) {
    const priorId = existingByName.get(dashboard.name)
    if (priorId !== undefined) {
      if (!options.replace) {
        progress(`${dashboard.name} already exists, leaving it alone`)
        result.skippedExisting.push(dashboard.name)
        continue
      }
      progress(`replacing ${dashboard.name}`)
      if (!options.dryRun) await client.deleteDashboard(projectId, priorId)
    }

    // Validate first. Creating the dashboard and then discovering every tile is
    // broken leaves rubbish behind that the user has to clean up by hand.
    const usable: PackTile[] = []
    for (const tile of dashboard.tiles) {
      if (!validate || options.dryRun) {
        usable.push(tile)
        continue
      }
      progress(`checking ${dashboard.name} › ${tile.name}`)
      try {
        await client.query(projectId, tile.query)
        usable.push(tile)
      } catch (error) {
        const message = error instanceof PostHogError ? error.message : String(error)
        result.invalid.push({ dashboard: dashboard.name, tile: tile.name, error: message })
      }
    }

    if (usable.length === 0) {
      progress(`${dashboard.name} had no usable tiles, skipping`)
      continue
    }

    if (options.dryRun) {
      result.created.push({
        id: 0,
        name: dashboard.name,
        url: '(dry run)',
        tiles: usable.map((tile) => ({ name: tile.name, insightId: 0 })),
        skipped: [],
      })
      continue
    }

    progress(`creating ${dashboard.name}`)
    const created = await client.createDashboard(projectId, {
      name: dashboard.name,
      // The question goes in the description so the dashboard explains itself
      // to whoever opens it in six months without reading the walkthrough.
      description: `${dashboard.question}\n\n${dashboard.description}\n\nBuilt by OpenHog from your tracking plan.`,
      pinned: options.pinned ?? true,
      tags: options.tags ?? ['openhog'],
    })

    const tiles: { name: string; insightId: number }[] = []
    for (const tile of usable) {
      progress(`  ${tile.name}`)
      const insight = await client.createInsight(projectId, {
        name: tile.name,
        description: `${tile.description}\n\nHow to read it: ${tile.interpretation}`,
        query: tile.query,
        dashboards: [created.id],
        tags: ['openhog'],
      })
      tiles.push({ name: tile.name, insightId: insight.id })
    }

    // Layouts need the dashboard's own tile ids, which only exist after the
    // insights are attached.
    try {
      const hydrated = await client.getDashboard(projectId, created.id)
      const ordered = usable
        .map((tile) => hydrated.tiles.find((candidate) => candidate.insight?.name === tile.name))
        .filter((tile): tile is { id: number; insight?: { id: number; name: string } } => Boolean(tile))
      if (ordered.length === usable.length) {
        await client.setDashboardLayouts(
          projectId,
          created.id,
          computeLayouts(usable, ordered.map((tile) => tile.id)),
        )
      }
    } catch {
      // A dashboard with default stacking is still a working dashboard. Losing
      // the whole sync over cosmetics would be the wrong trade.
      progress(`  (could not set layout for ${dashboard.name}; tiles will stack)`)
    }

    result.created.push({
      id: created.id,
      name: dashboard.name,
      url: `${client.hosts.host}/project/${projectId}/dashboard/${created.id}`,
      tiles,
      skipped: [],
    })
  }

  return result
}
