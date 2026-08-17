/**
 * Run the metric catalogue against a project.
 *
 * Every metric is computed independently and every failure is contained. A
 * HogQL function an older self-hosted deployment does not have, a permission
 * gap, a timeout on a very large project: any of these make one metric
 * unavailable and none of them stop the report. The alternative - one bad query
 * taking the whole run down - is how a diagnostic tool becomes something people
 * stop running.
 */

import type { PostHogClient } from '../posthog/client.js'
import type { ProductKind } from '../types.js'
import { METRICS, type MetricRunner } from './definitions.js'
import type { MetricSet, MetricValue } from './types.js'
import { discoverProject, type Discovery } from './discover.js'

export interface ComputeOptions {
  client: PostHogClient
  projectId: number
  projectName?: string
  /** Overrides the kind inferred from the event vocabulary. */
  productKind?: ProductKind
  /** Overrides individual role resolutions, e.g. from a tracking plan. */
  roles?: Record<string, string>
  onProgress?: (message: string) => void
  /** Run at most this many queries at once. PostHog rate limits aggressively. */
  concurrency?: number
}

interface QueryResponse {
  results?: unknown[][]
}

async function runMetric(
  metric: MetricRunner,
  options: ComputeOptions,
  roles: Record<string, string>,
  daysOfData: number,
): Promise<MetricValue> {
  const base: MetricValue = { id: metric.id, value: null, confidence: 'none' }

  // A young project answers long-window questions with confident nonsense, and
  // no sample-size check catches it because the denominator is large. Verified
  // against a real three-day-old project that reported a 30-day stickiness and
  // a 0% power-user share, the second of which is a critical finding.
  if (metric.minDays && daysOfData > 0 && daysOfData < metric.minDays) {
    return {
      ...base,
      note: `Needs about ${metric.minDays} days of history to mean anything; this project has ${daysOfData}.`,
    }
  }

  const missing = (metric.requiresRoles ?? []).filter((role) => !roles[role])
  if (missing.length) {
    return {
      ...base,
      note: `Needs an event for: ${missing.join(', ')}. This project does not appear to send one.`,
    }
  }

  const described = metric.describeMissing?.(roles)
  if (described) return { ...base, note: described }

  const built = metric.build({ roles, window: 30 })
  if (!built) {
    return { ...base, note: 'Could not be built for this project.' }
  }

  try {
    const response = await options.client.query<QueryResponse>(options.projectId, {
      kind: 'HogQLQuery',
      query: built.sql,
    })
    const parsed = built.parse(response.results ?? [])
    const value: MetricValue = { ...base, ...parsed }

    // A metric whose denominator is too small is reported, but never used to
    // make a claim. Telling somebody their retention is bad off twelve users is
    // worse than saying nothing.
    if (metric.minSample && (value.sample ?? 0) < metric.minSample) {
      value.confidence = 'low'
      value.note = `Only ${value.sample ?? 0} people in the sample; too few to draw a conclusion from.`
    }
    return value
  } catch (error) {
    return {
      ...base,
      note: error instanceof Error ? error.message : String(error),
    }
  }
}

/** Run tasks with a bounded number in flight. */
async function pooled<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= tasks.length) return
      results[index] = await tasks[index]!()
    }
  })
  await Promise.all(workers)
  return results
}

export async function computeMetrics(options: ComputeOptions): Promise<MetricSet> {
  const progress = options.onProgress ?? (() => {})

  progress('reading what this project measures')
  const discovery: Discovery = await discoverProject(options.client, options.projectId)

  const roles = { ...discovery.roles, ...options.roles }
  const productKind = options.productKind ?? discovery.productKind

  progress(`computing ${METRICS.length} metrics`)
  const values = await pooled(
    METRICS.map((metric) => async () => {
      progress(metric.name)
      return runMetric(metric, options, roles, discovery.daysOfData)
    }),
    options.concurrency ?? 4,
  )

  const byId: Record<string, MetricValue> = {}
  const unavailable: { id: string; reason: string }[] = []
  for (const value of values) {
    byId[value.id] = value
    if (value.value === null) {
      unavailable.push({ id: value.id, reason: value.note ?? 'Unknown' })
    }
  }

  return {
    values: byId,
    context: {
      projectName: options.projectName ?? `Project ${options.projectId}`,
      projectId: options.projectId,
      productKind,
      roles,
      eventVolumes: discovery.events,
      activePeople: discovery.activePeople,
      totalEvents: discovery.totalEvents,
      daysOfData: discovery.daysOfData,
      unavailable,
    },
  }
}

export { METRICS }
