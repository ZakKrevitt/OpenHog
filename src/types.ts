/**
 * The shapes every other module agrees on.
 *
 * Two of these are files a user will read, diff and hand-edit, so they are
 * contracts rather than internal state: `TrackingPlan` (openhog/tracking-plan.json)
 * and `OpenHogConfig` (openhog.config.json). Adding a required field to either
 * one breaks somebody's repo, so new fields are optional and `version` moves.
 */

/** What kind of product this is. Decides which dashboard packs apply. */
export type ProductKind =
  | 'saas'
  | 'consumer'
  | 'marketplace'
  | 'ecommerce'
  | 'ai-app'
  | 'devtool'
  | 'content'

export const PRODUCT_KINDS: ProductKind[] = [
  'saas',
  'consumer',
  'marketplace',
  'ecommerce',
  'ai-app',
  'devtool',
  'content',
]

/**
 * The lifecycle stage an event belongs to. This is what lets a pack say "give
 * me the activation events" without knowing what this particular product calls
 * them, and what orders the walkthrough.
 */
export type Stage =
  | 'acquisition'
  | 'activation'
  | 'engagement'
  | 'conversion'
  | 'retention'
  | 'referral'
  | 'health'

export const STAGES: Stage[] = [
  'acquisition',
  'activation',
  'engagement',
  'conversion',
  'retention',
  'referral',
  'health',
]

export type PropertyType = 'string' | 'number' | 'boolean' | 'enum'

export interface PlanProperty {
  name: string
  type: PropertyType
  description: string
  /** Allowed values, for `enum`. Also what the walkthrough lists as breakdowns. */
  values?: string[]
  required?: boolean
  /**
   * True when the raw value would be high cardinality or identifying and the
   * emitted code should bucket it instead. Drives the generated helper.
   */
  bucketed?: boolean
}

export interface PlanEvent {
  /** snake_case. This is the string PostHog sees. */
  name: string
  description: string
  stage: Stage
  properties: PlanProperty[]
  /**
   * True when the scanner found this name actually being emitted in the repo.
   * Every dashboard tile is gated on this: a tile whose events are not emitted
   * is never created, because a dashboard full of empty tiles is worse than a
   * smaller dashboard. This is the whole "no invented events" guarantee.
   */
  emitted: boolean
  /** `path/to/file.ts:120` for each call site the scanner found. */
  sources: string[]
  /** Where this event should probably fire, when it is not emitted yet. */
  suggestedLocations?: string[]
  /** The pack that asked for this event, when it did not come from the code. */
  origin?: 'code' | 'pack' | 'llm' | 'user'
}

export interface TrackingPlan {
  version: 1
  generatedAt: string
  generatedBy: string
  product: {
    name: string
    description: string
    kind: ProductKind
    /** 'web', 'ios', 'android', 'backend', 'cli' */
    surfaces: string[]
    url?: string
  }
  events: PlanEvent[]
  /**
   * Semantic role → the event name this repo actually uses for it. Packs are
   * written against roles, so this map is what makes a pack fit a codebase that
   * calls its signup event anything at all. Reviewable and hand-editable: if the
   * resolver picked the wrong event, correcting it here fixes every dashboard.
   */
  roles: Record<string, string>
  identity: {
    /** How the app derives distinct_id. Documented, not enforced. */
    distinctIdSource: string
    /** Routes replay and autocapture must never touch. */
    sensitiveRoutes: string[]
  }
  /** Pack ids whose dashboards this plan was built for. */
  packs: string[]
  /** Normalised route patterns, mirrored into the generated normalizeRoute(). */
  routes?: string[]
}

export type PostHogRegion = 'us' | 'eu' | 'custom'

export interface OpenHogConfig {
  version: 1
  posthog: {
    region: PostHogRegion
    /** API host, e.g. https://us.posthog.com */
    host: string
    /** Ingestion host, e.g. https://us.i.posthog.com */
    ingestHost: string
    /** Asset host that serves lazily loaded bundles. Needed for CSP. */
    assetHost: string
    projectId?: number
    /** Env var name the app reads the public `phc_` token from. */
    publicKeyEnv: string
  }
  product: {
    kind: ProductKind
    packs: string[]
  }
  /** Paths the scanner should not walk. Merged with the built-in ignore list. */
  ignore?: string[]
  /** Where generated files land, relative to repo root. */
  paths?: {
    plan?: string
    analyticsModule?: string
    walkthrough?: string
  }
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

export type Framework =
  | 'nextjs'
  | 'react'
  | 'vue'
  | 'svelte'
  | 'sveltekit'
  | 'nuxt'
  | 'astro'
  | 'remix'
  | 'solid'
  | 'angular'
  | 'react-native'
  | 'expo'
  | 'swift-ios'
  | 'kotlin-android'
  | 'flutter'
  | 'django'
  | 'fastapi'
  | 'flask'
  | 'rails'
  | 'express'
  | 'node'
  | 'unknown'

export interface DetectedRoute {
  /** Normalised, with dynamic segments as `:param`. */
  path: string
  file: string
  /** A guess at what this page is for, used to name events. */
  role?: string
}

export interface DetectedEventCall {
  name: string
  file: string
  line: number
  /** The wrapper that was called, e.g. `posthog.capture` or `trackEvent`. */
  via: string
}

export interface ScanResult {
  root: string
  frameworks: Framework[]
  surfaces: string[]
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun' | 'none'
  product: {
    name: string
    description: string
    url?: string
    /** Raw text the description was drawn from, for LLM enrichment. */
    evidence: string[]
  }
  routes: DetectedRoute[]
  existingEvents: DetectedEventCall[]
  /** Signals that shift the product-kind guess and the pack choice. */
  signals: {
    hasAuth: boolean
    hasPayments: boolean
    hasUploads: boolean
    hasSearch: boolean
    hasChat: boolean
    hasLlm: boolean
    hasMarketplace: boolean
    hasSubscriptions: boolean
    hasBlog: boolean
    hasEmail: boolean
    hasWaitlist: boolean
    hasOnboarding: boolean
    hasSharing: boolean
    hasNotifications: boolean
  }
  /** Analytics libraries already present. */
  existingAnalytics: string[]
  /** Files that carry a Content-Security-Policy, for the doctor. */
  cspFiles: string[]
  /** Best-guess entry file to wire init into. */
  entryFile?: string
  filesScanned: number
}

// ---------------------------------------------------------------------------
// Dashboard packs
// ---------------------------------------------------------------------------

export type TileWidth = 'third' | 'half' | 'full'

export interface PackTile {
  /** Stable within a pack. Used to reconcile on re-sync instead of by name. */
  key: string
  name: string
  /** Shown under the tile title in PostHog. Says what the number is. */
  description: string
  /** The walkthrough line. Says what to DO when the number moves. */
  interpretation: string
  /**
   * Hard requirements. The tile is skipped unless every one of them resolved to
   * an event the repo emits. `$pageview` always counts, because the generated
   * SDK config sends it.
   */
  requires: string[]
  /**
   * Every event this tile's query actually references, derived from the query
   * rather than declared. A funnel may include optional steps that are not hard
   * requirements — a pricing step that only appears for products that have one —
   * so `requires` under-reports what is charted.
   *
   * This is the field the "no invented events" guarantee is checked against.
   */
  charts: string[]
  width?: TileWidth
  /** Built at sync time so the query can reference resolved event names. */
  query: PostHogQuery
}

export interface PackDashboard {
  key: string
  name: string
  description: string
  /** The single question this dashboard exists to answer. Leads the walkthrough. */
  question: string
  tiles: PackTile[]
}

export interface Pack {
  id: string
  name: string
  description: string
  appliesTo: ProductKind[]
  /** Events the pack's tiles are written against. Seeded into the plan. */
  events: PlanEvent[]
  /** Built against a concrete plan, so tiles can adapt to real event names. */
  build: (plan: TrackingPlan) => PackDashboard[]
}

// ---------------------------------------------------------------------------
// PostHog query JSON
// ---------------------------------------------------------------------------

/** Loose on purpose: PostHog's query schema moves faster than this package. */
export type PostHogQuery = Record<string, unknown>

export interface PostHogProject {
  id: number
  name: string
  api_token: string
  timezone?: string
  week_start_day?: number
  organization?: string
}

export interface CreatedDashboard {
  id: number
  name: string
  url: string
  tiles: { name: string; insightId: number }[]
  skipped: { name: string; missing: string[] }[]
}
