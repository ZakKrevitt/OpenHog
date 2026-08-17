/**
 * Metrics: the numbers, computed from a real project.
 *
 * The whole point of this layer is that a metric is not just a number. It is a
 * number plus what it means, what a normal value looks like, and how much you
 * should trust it given the sample it came from. A dashboard gives you the
 * first of those and leaves you to supply the other three from experience you
 * may not have.
 */

import type { ProductKind } from '../types.js'

export type MetricUnit = 'count' | 'percent' | 'ratio' | 'days' | 'perPerson'

/** Which way is good. Some metrics (error rate) are better when lower. */
export type Direction = 'higher' | 'lower' | 'neutral'

export interface MetricDefinition {
  id: string
  name: string
  /** The plain question this number answers. */
  question: string
  unit: MetricUnit
  direction: Direction
  /**
   * Roles this metric needs resolved. A metric whose roles are missing is not
   * computed at all, rather than computed as zero - "you have no signups" and
   * "you do not track signups" are completely different situations and
   * conflating them is how analytics tools lose people's trust.
   */
  requiresRoles?: string[]
  /**
   * How many people must be in the denominator before the number means
   * anything. Below this the metric is reported as low confidence and no
   * finding is raised from it.
   */
  minSample?: number
  /**
   * How many days of history the project needs before this number means
   * anything.
   *
   * This guard exists because a young project answers every long-window query
   * with a confident, plausible-looking lie. A three-day-old project returns a
   * 30-day stickiness of 0.25 and a power-user share of 0% - the second of
   * which reads as a critical finding - purely because nobody has had the
   * chance to be active on five separate days yet. Sample size does not catch
   * it: there were 5,534 people in that denominator.
   */
  minDays?: number
  /** Longer explanation, used in the report when the metric is shown. */
  explanation: string
}

export interface MetricValue {
  id: string
  /** Null when the metric could not be computed. `note` says why. */
  value: number | null
  /** Size of the denominator, for confidence. */
  sample?: number
  /** The same metric over the preceding period, when available. */
  previous?: number | null
  /** Supporting numbers a finding may want to quote. */
  extra?: Record<string, number | string>
  confidence: 'high' | 'medium' | 'low' | 'none'
  note?: string
}

export interface MetricSet {
  /** Keyed by metric id. Always contains an entry for every attempted metric. */
  values: Record<string, MetricValue>
  /** What the project looks like, for context in the report. */
  context: {
    projectName: string
    projectId: number
    productKind: ProductKind
    /** Roles resolved from the events PostHog has actually seen. */
    roles: Record<string, string>
    /** Event name → people in the last 30 days. */
    eventVolumes: { event: string; events: number; people: number }[]
    activePeople: number
    totalEvents: number
    daysOfData: number
    /** Metrics that could not be computed, with the reason. */
    unavailable: { id: string; reason: string }[]
  }
}

export function get(set: MetricSet, id: string): MetricValue | undefined {
  const value = set.values[id]
  return value && value.value !== null ? value : undefined
}

/** Value only if it is trustworthy enough to make a claim about. */
export function trusted(set: MetricSet, id: string): number | undefined {
  const metric = set.values[id]
  if (!metric || metric.value === null) return undefined
  if (metric.confidence === 'low' || metric.confidence === 'none') return undefined
  return metric.value
}

export function formatMetric(value: number, unit: MetricUnit): string {
  switch (unit) {
    case 'percent':
      return `${(value * 100).toFixed(value < 0.1 ? 1 : 0)}%`
    case 'ratio':
      return value.toFixed(2)
    case 'days':
      return value < 1 ? `${Math.round(value * 24)}h` : `${value.toFixed(1)} days`
    case 'perPerson':
      return value.toFixed(1)
    case 'count':
    default:
      if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
      if (value >= 10_000) return `${(value / 1000).toFixed(0)}k`
      if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
      return String(Math.round(value))
  }
}

/** Percentage change against the previous period, as a signed string. */
export function formatChange(current: number, previous: number): string | null {
  if (!previous) return null
  const change = (current - previous) / previous
  if (!Number.isFinite(change)) return null
  const sign = change >= 0 ? '+' : ''
  return `${sign}${(change * 100).toFixed(0)}%`
}
