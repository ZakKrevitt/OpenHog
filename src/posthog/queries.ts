/**
 * PostHog query builders.
 *
 * These emit the modern `InsightVizNode` query format rather than the legacy
 * `filters` payload. Both still work, but a legacy insight opens in PostHog with
 * a "this insight uses an old format" affordance, and the query format is what
 * `POST /api/projects/:id/query/` accepts, which is what makes `openhog verify`
 * able to run a tile's own query and report whether it returns rows.
 *
 * Everything is deliberately loose-typed (`PostHogQuery = Record<string, unknown>`).
 * PostHog's schema moves; pinning it here would mean shipping a new OpenHog for
 * every upstream field addition.
 */

import type { PostHogQuery } from '../types.js'

export type Interval = 'hour' | 'day' | 'week' | 'month'
export type TrendsDisplay =
  | 'ActionsLineGraph'
  | 'ActionsLineGraphCumulative'
  | 'ActionsBar'
  | 'ActionsBarValue'
  | 'ActionsTable'
  | 'ActionsPie'
  | 'BoldNumber'
  | 'WorldMap'

export type MathType =
  | 'total'
  | 'dau'
  | 'weekly_active'
  | 'monthly_active'
  | 'unique_session'
  | 'avg_count_per_actor'

export interface SeriesSpec {
  event: string
  /** Display name on the chart. Defaults to the event name. */
  name?: string
  math?: MathType
  /** Property filters, as PostHog property objects. */
  properties?: PropertyFilter[]
  /** For `sum`/`avg` style maths over a numeric property. */
  mathProperty?: string
}

export interface PropertyFilter {
  key: string
  value: string | number | boolean | (string | number)[]
  operator?:
    | 'exact'
    | 'is_not'
    | 'icontains'
    | 'not_icontains'
    | 'regex'
    | 'gt'
    | 'lt'
    | 'is_set'
    | 'is_not_set'
  type?: 'event' | 'person' | 'session'
}

function series(specs: SeriesSpec[]): Record<string, unknown>[] {
  return specs.map((spec) => {
    const node: Record<string, unknown> = {
      kind: 'EventsNode',
      event: spec.event,
      name: spec.name ?? spec.event,
      math: spec.math ?? 'total',
    }
    if (spec.mathProperty) node.math_property = spec.mathProperty
    if (spec.properties?.length) node.properties = normaliseProperties(spec.properties)
    return node
  })
}

function normaliseProperties(properties: PropertyFilter[]): Record<string, unknown>[] {
  return properties.map((property) => ({
    key: property.key,
    value: property.value,
    operator: property.operator ?? 'exact',
    type: property.type ?? 'event',
  }))
}

function dateRange(from: string, to?: string): Record<string, unknown> {
  return to ? { date_from: from, date_to: to } : { date_from: from }
}

export interface TrendsOptions {
  series: SeriesSpec[]
  dateFrom?: string
  interval?: Interval
  display?: TrendsDisplay
  breakdown?: string
  breakdownType?: 'event' | 'person' | 'session'
  breakdownLimit?: number
  /** Show each series as a share of the total rather than an absolute count. */
  showPercentStackView?: boolean
  compareToPrevious?: boolean
  formula?: string
}

export function trends(options: TrendsOptions): PostHogQuery {
  const source: Record<string, unknown> = {
    kind: 'TrendsQuery',
    series: series(options.series),
    interval: options.interval ?? 'day',
    dateRange: dateRange(options.dateFrom ?? '-30d'),
    trendsFilter: {
      display: options.display ?? 'ActionsLineGraph',
      ...(options.showPercentStackView ? { showPercentStackView: true } : {}),
      ...(options.formula ? { formula: options.formula } : {}),
    },
    filterTestAccounts: true,
  }
  if (options.breakdown) {
    source.breakdownFilter = {
      breakdown: options.breakdown,
      breakdown_type: options.breakdownType ?? 'event',
      breakdown_limit: options.breakdownLimit ?? 10,
    }
  }
  if (options.compareToPrevious) {
    source.compareFilter = { compare: true }
  }
  return { kind: 'InsightVizNode', source }
}

export interface FunnelOptions {
  series: SeriesSpec[]
  dateFrom?: string
  /** How long a user has to complete the whole funnel. */
  windowInterval?: number
  windowIntervalUnit?: 'minute' | 'hour' | 'day' | 'week' | 'month'
  vizType?: 'steps' | 'time_to_convert' | 'trends'
  orderType?: 'ordered' | 'unordered' | 'strict'
  breakdown?: string
  layout?: 'horizontal' | 'vertical'
}

export function funnel(options: FunnelOptions): PostHogQuery {
  const source: Record<string, unknown> = {
    kind: 'FunnelsQuery',
    series: series(options.series),
    dateRange: dateRange(options.dateFrom ?? '-14d'),
    funnelsFilter: {
      funnelVizType: options.vizType ?? 'steps',
      funnelOrderType: options.orderType ?? 'ordered',
      funnelWindowInterval: options.windowInterval ?? 14,
      funnelWindowIntervalUnit: options.windowIntervalUnit ?? 'day',
      // Vertical reads far better once a funnel has more than three steps,
      // which most real ones do.
      layout: options.layout ?? (options.series.length > 3 ? 'vertical' : 'horizontal'),
    },
    filterTestAccounts: true,
  }
  if (options.breakdown) {
    source.breakdownFilter = { breakdown: options.breakdown, breakdown_type: 'event' }
  }
  return { kind: 'InsightVizNode', source }
}

export interface RetentionOptions {
  /** The event that puts someone into the cohort. */
  targetEvent: string
  /** The event that counts as coming back. Defaults to the target event. */
  returningEvent?: string
  period?: 'Hour' | 'Day' | 'Week' | 'Month'
  totalIntervals?: number
  dateFrom?: string
  /** `retention_first_time` measures true new-user retention. */
  retentionType?: 'retention_first_time' | 'retention_recurring'
}

export function retention(options: RetentionOptions): PostHogQuery {
  const entity = (event: string) => ({ id: event, name: event, type: 'events' as const, order: 0 })
  return {
    kind: 'InsightVizNode',
    source: {
      kind: 'RetentionQuery',
      dateRange: dateRange(options.dateFrom ?? '-60d'),
      retentionFilter: {
        period: options.period ?? 'Week',
        totalIntervals: options.totalIntervals ?? 8,
        targetEntity: entity(options.targetEvent),
        returningEntity: entity(options.returningEvent ?? options.targetEvent),
        retentionType: options.retentionType ?? 'retention_first_time',
        meanRetentionCalculation: 'simple',
      },
      filterTestAccounts: true,
    },
  }
}

export interface StickinessOptions {
  series: SeriesSpec[]
  dateFrom?: string
  interval?: Interval
}

export function stickiness(options: StickinessOptions): PostHogQuery {
  return {
    kind: 'InsightVizNode',
    source: {
      kind: 'StickinessQuery',
      series: series(options.series),
      interval: options.interval ?? 'day',
      dateRange: dateRange(options.dateFrom ?? '-30d'),
      stickinessFilter: {},
      filterTestAccounts: true,
    },
  }
}

export interface LifecycleOptions {
  event: string
  dateFrom?: string
  interval?: Interval
}

export function lifecycle(options: LifecycleOptions): PostHogQuery {
  return {
    kind: 'InsightVizNode',
    source: {
      kind: 'LifecycleQuery',
      series: series([{ event: options.event, math: 'total' }]),
      interval: options.interval ?? 'week',
      dateRange: dateRange(options.dateFrom ?? '-90d'),
      lifecycleFilter: { showLegend: true },
      filterTestAccounts: true,
    },
  }
}

export interface PathsOptions {
  dateFrom?: string
  startPoint?: string
  endPoint?: string
  includeEventTypes?: ('$pageview' | 'custom_event' | '$screen')[]
  stepLimit?: number
}

export function paths(options: PathsOptions = {}): PostHogQuery {
  const pathsFilter: Record<string, unknown> = {
    includeEventTypes: options.includeEventTypes ?? ['$pageview'],
    stepLimit: options.stepLimit ?? 5,
  }
  if (options.startPoint) pathsFilter.startPoint = options.startPoint
  if (options.endPoint) pathsFilter.endPoint = options.endPoint
  return {
    kind: 'InsightVizNode',
    source: {
      kind: 'PathsQuery',
      dateRange: dateRange(options.dateFrom ?? '-14d'),
      pathsFilter,
      filterTestAccounts: true,
    },
  }
}

/**
 * A HogQL table. Used where a question is genuinely a query rather than a chart:
 * "which events carry a property with more than 500 distinct values", "which of
 * my planned events has stopped arriving".
 */
export function hogql(query: string, options: { showExport?: boolean } = {}): PostHogQuery {
  return {
    kind: 'DataTableNode',
    source: { kind: 'HogQLQuery', query },
    showExport: options.showExport ?? true,
    showReload: true,
    showColumnConfigurator: false,
  }
}

/** A single big number, with the previous period underneath it. */
export function bigNumber(spec: SeriesSpec, dateFrom = '-7d'): PostHogQuery {
  return trends({
    series: [spec],
    dateFrom,
    display: 'BoldNumber',
    interval: 'day',
    compareToPrevious: true,
  })
}
