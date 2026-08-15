/**
 * The metric catalogue.
 *
 * Each entry knows how to compute itself from the `events` table and how to
 * read its own result. Two rules apply throughout:
 *
 *   - A metric whose roles are unresolved returns `null` from `build` and is
 *     never computed. "You have no signups" and "you do not track signups" are
 *     different situations, and a tool that reports the second as the first has
 *     told you something false about your product.
 *   - Every query is bounded in time and avoids unbounded per-person arrays, so
 *     running the whole catalogue against a large project stays cheap.
 *
 * The SQL is HogQL, which is ClickHouse SQL with PostHog's schema sugar. Any
 * query that a given deployment cannot run is caught by the runner and reported
 * as unavailable, so a self-hosted version behind Cloud degrades rather than
 * breaks.
 */

import type { MetricDefinition, MetricValue } from './types.js'

export interface BuildContext {
  roles: Record<string, string>
  /** Lookback for the "recent" window, in days. */
  window: number
}

export interface BuiltQuery {
  sql: string
  parse: (rows: unknown[][]) => Partial<MetricValue>
}

export interface MetricRunner extends MetricDefinition {
  build: (context: BuildContext) => BuiltQuery | null
  /**
   * Why this metric cannot be computed for a given project, in the user's
   * terms. Metrics that accept a proxy role need this, because `requiresRoles`
   * can only express "all of these", not "any of these".
   */
  describeMissing?: (roles: Record<string, string>) => string | null
}

/**
 * The event that counts as reaching value.
 *
 * Most projects never name an event "activation". The action the product exists
 * for is the activation moment in practice, so falling back to it is what makes
 * the single most valuable finding available to a normal project rather than
 * only to one that already thought carefully about this.
 */
export function activationEvent(roles: Record<string, string>): string | null {
  return roles.activation ?? roles.core_action ?? roles.content_opened ?? null
}

/** Quote a value for HogQL. Event names come from PostHog, but never trust them. */
function esc(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

const num = (value: unknown): number => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** Safe division that returns null rather than NaN or Infinity. */
const ratio = (top: number, bottom: number): number | null =>
  bottom > 0 ? top / bottom : null

const first = (rows: unknown[][]): unknown[] => rows[0] ?? []

/**
 * Cohort window used by every retention metric: people whose first-ever event
 * was between 14 and 60 days ago. Anyone newer has not had time to come back,
 * and including them drags every retention number towards zero - the single
 * most common way retention gets misreported.
 */
const COHORT = 'first_seen > now() - INTERVAL 60 DAY AND first_seen < now() - INTERVAL 14 DAY'

/**
 * How far back "first ever seen" is checked. A person active before this looks
 * new when they return, which slightly inflates new-user counts on long-lived
 * projects. Unbounded would mean a full-table scan on every metric.
 */
const HISTORY = 180

export const METRICS: MetricRunner[] = [
  // -------------------------------------------------------------------------
  // Size and growth
  // -------------------------------------------------------------------------
  {
    id: 'active_people',
    name: 'Active people',
    question: 'How many distinct people used the product in the last 7 days?',
    unit: 'count',
    direction: 'higher',
    explanation:
      'The headline number. Compared against the 7 days before it, so you see direction rather than a bare count.',
    build: () => ({
      sql: `
        SELECT
          count(DISTINCT if(timestamp > now() - INTERVAL 7 DAY, distinct_id, NULL)) AS current,
          count(DISTINCT if(timestamp <= now() - INTERVAL 7 DAY, distinct_id, NULL)) AS previous
        FROM events
        WHERE timestamp > now() - INTERVAL 14 DAY
      `,
      parse: (rows) => {
        const row = first(rows)
        return { value: num(row[0]), previous: num(row[1]), sample: num(row[0]), confidence: 'high' }
      },
    }),
  },

  {
    id: 'new_people',
    name: 'New people',
    question: 'How many people showed up for the first time in the last 7 days?',
    unit: 'count',
    direction: 'higher',
    explanation:
      'People whose first ever event landed in the window. This is top of funnel, and it moves before every other number does.',
    build: () => ({
      sql: `
        SELECT
          countIf(first_seen > now() - INTERVAL 7 DAY) AS current,
          countIf(first_seen <= now() - INTERVAL 7 DAY AND first_seen > now() - INTERVAL 14 DAY) AS previous
        FROM (
          SELECT distinct_id, min(timestamp) AS first_seen
          FROM events
          WHERE timestamp > now() - INTERVAL ${HISTORY} DAY
          GROUP BY distinct_id
        )
      `,
      parse: (rows) => {
        const row = first(rows)
        return { value: num(row[0]), previous: num(row[1]), sample: num(row[0]), confidence: 'high' }
      },
    }),
  },

  {
    id: 'growth_rate',
    name: 'Week-on-week growth',
    question: 'Are more people arriving this week than last?',
    unit: 'percent',
    direction: 'higher',
    minSample: 20,
    explanation:
      'Change in new people, week on week. One week is noisy; read it as a direction over several weeks rather than a verdict.',
    build: () => ({
      sql: `
        SELECT
          countIf(first_seen > now() - INTERVAL 7 DAY) AS current,
          countIf(first_seen <= now() - INTERVAL 7 DAY AND first_seen > now() - INTERVAL 14 DAY) AS previous
        FROM (
          SELECT distinct_id, min(timestamp) AS first_seen
          FROM events
          WHERE timestamp > now() - INTERVAL ${HISTORY} DAY
          GROUP BY distinct_id
        )
      `,
      parse: (rows) => {
        const row = first(rows)
        const current = num(row[0])
        const previous = num(row[1])
        return {
          value: previous > 0 ? (current - previous) / previous : null,
          sample: current + previous,
          extra: { current, previous },
          confidence: previous >= 20 ? 'high' : 'low',
        }
      },
    }),
  },

  // -------------------------------------------------------------------------
  // Retention: the number that decides whether anything else matters
  // -------------------------------------------------------------------------
  {
    id: 'retention_w1',
    name: 'Week-1 retention',
    question: 'Of the people who showed up, how many came back a week later?',
    unit: 'percent',
    direction: 'higher',
    minSample: 30,
    explanation:
      'Share of a cohort who were still active at least 7 days after their first visit. Only people who first appeared 14 to 60 days ago are counted, because anyone newer has not had the chance to come back yet.',
    build: () => ({
      sql: `
        SELECT
          count() AS cohort,
          countIf(dateDiff('day', first_seen, last_seen) >= 7) AS retained
        FROM (
          SELECT distinct_id, min(timestamp) AS first_seen, max(timestamp) AS last_seen
          FROM events
          WHERE timestamp > now() - INTERVAL ${HISTORY} DAY
          GROUP BY distinct_id
          HAVING ${COHORT}
        )
      `,
      parse: (rows) => {
        const row = first(rows)
        const cohort = num(row[0])
        return {
          value: ratio(num(row[1]), cohort),
          sample: cohort,
          extra: { cohort, retained: num(row[1]) },
          confidence: cohort >= 100 ? 'high' : cohort >= 30 ? 'medium' : 'low',
        }
      },
    }),
  },

  {
    id: 'retention_w4',
    name: 'Week-4 retention',
    question: 'Does the retention curve flatten out, or fall to zero?',
    unit: 'percent',
    direction: 'higher',
    minSample: 30,
    explanation:
      'Share of the same cohort still active 28 days after their first visit. Read together with week 1: a curve that flattens is a real product, one that reaches zero is a leaky bucket.',
    build: () => ({
      sql: `
        SELECT
          count() AS cohort,
          countIf(dateDiff('day', first_seen, last_seen) >= 28) AS retained
        FROM (
          SELECT distinct_id, min(timestamp) AS first_seen, max(timestamp) AS last_seen
          FROM events
          WHERE timestamp > now() - INTERVAL ${HISTORY} DAY
          GROUP BY distinct_id
          HAVING first_seen > now() - INTERVAL 120 DAY AND first_seen < now() - INTERVAL 35 DAY
        )
      `,
      parse: (rows) => {
        const row = first(rows)
        const cohort = num(row[0])
        return {
          value: ratio(num(row[1]), cohort),
          sample: cohort,
          confidence: cohort >= 100 ? 'high' : cohort >= 30 ? 'medium' : 'low',
        }
      },
    }),
  },

  {
    id: 'stickiness',
    name: 'Stickiness (DAU/MAU)',
    question: 'How much of your monthly audience shows up on an average day?',
    unit: 'ratio',
    direction: 'higher',
    minSample: 50,
    explanation:
      'Average daily actives divided by monthly actives. Roughly, the share of days a typical user is present. Above ~0.2 is a habit; below ~0.05 is occasional use, and daily notifications will annoy rather than retain.',
    build: () => ({
      sql: `
        SELECT
          avg(daily) AS avg_dau,
          max(monthly) AS mau
        FROM (
          SELECT
            toDate(timestamp) AS day,
            count(DISTINCT distinct_id) AS daily,
            (SELECT count(DISTINCT distinct_id) FROM events WHERE timestamp > now() - INTERVAL 30 DAY) AS monthly
          FROM events
          WHERE timestamp > now() - INTERVAL 30 DAY
          GROUP BY day
        )
      `,
      parse: (rows) => {
        const row = first(rows)
        const dau = num(row[0])
        const mau = num(row[1])
        return {
          value: ratio(dau, mau),
          sample: mau,
          extra: { avg_dau: Math.round(dau), mau },
          confidence: mau >= 200 ? 'high' : mau >= 50 ? 'medium' : 'low',
        }
      },
    }),
  },

  {
    id: 'power_user_share',
    name: 'Power users',
    question: 'What share of active people use it regularly rather than once?',
    unit: 'percent',
    direction: 'higher',
    minSample: 50,
    explanation:
      'Share of people active in the last 30 days who were present on 5 or more distinct days. These are the people whose behaviour your onboarding should be trying to reproduce.',
    build: () => ({
      sql: `
        SELECT
          count() AS people,
          countIf(active_days >= 5) AS power_users,
          countIf(active_days = 1) AS one_day_only
        FROM (
          SELECT distinct_id, count(DISTINCT toDate(timestamp)) AS active_days
          FROM events
          WHERE timestamp > now() - INTERVAL 30 DAY
          GROUP BY distinct_id
        )
      `,
      parse: (rows) => {
        const row = first(rows)
        const people = num(row[0])
        return {
          value: ratio(num(row[1]), people),
          sample: people,
          extra: {
            power_users: num(row[1]),
            one_day_only: num(row[2]),
            one_day_share: people > 0 ? num(row[2]) / people : 0,
          },
          confidence: people >= 200 ? 'high' : people >= 50 ? 'medium' : 'low',
        }
      },
    }),
  },

  // -------------------------------------------------------------------------
  // The funnel
  // -------------------------------------------------------------------------
  {
    id: 'signup_conversion',
    name: 'Visit → signup',
    question: 'What share of people who arrive create an account?',
    unit: 'percent',
    direction: 'higher',
    requiresRoles: ['signup_completed'],
    minSample: 50,
    explanation:
      'Of everyone seen in the last 30 days, the share who completed a signup. A low number here is a landing page or a value-proposition problem, not a product one.',
    build: ({ roles }) => {
      const signup = roles.signup_completed
      if (!signup) return null
      return {
        sql: `
          SELECT
            count(DISTINCT distinct_id) AS visitors,
            count(DISTINCT if(event = ${esc(signup)}, distinct_id, NULL)) AS signups
          FROM events
          WHERE timestamp > now() - INTERVAL 30 DAY
        `,
        parse: (rows) => {
          const row = first(rows)
          const visitors = num(row[0])
          return {
            value: ratio(num(row[1]), visitors),
            sample: visitors,
            extra: { visitors, signups: num(row[1]) },
            confidence: visitors >= 500 ? 'high' : visitors >= 50 ? 'medium' : 'low',
          }
        },
      }
    },
  },

  {
    id: 'activation_rate',
    name: 'Signup → activation',
    question: 'Of the people who sign up, how many ever reach the point of value?',
    unit: 'percent',
    direction: 'higher',
    requiresRoles: ['signup_completed'],
    minSample: 30,
    explanation:
      'The share of people who signed up and then did the thing the product is actually for. This is usually the largest recoverable loss in the whole funnel, and the one teams look at least.',
    describeMissing: (roles) =>
      activationEvent(roles)
        ? null
        : 'Nothing in this project looks like a core action, so there is no way to tell who reached value.',
    build: ({ roles }) => {
      const signup = roles.signup_completed
      const activation = activationEvent(roles)
      if (!signup || !activation) return null
      return {
        sql: `
          SELECT
            count() AS signed_up,
            countIf(activated_at > signed_up_at) AS activated
          FROM (
            SELECT
              distinct_id,
              minIf(timestamp, event = ${esc(signup)}) AS signed_up_at,
              minIf(timestamp, event = ${esc(activation)}) AS activated_at
            FROM events
            WHERE event IN (${esc(signup)}, ${esc(activation)})
              AND timestamp > now() - INTERVAL 60 DAY
            GROUP BY distinct_id
            HAVING countIf(event = ${esc(signup)}) > 0
          )
        `,
        parse: (rows) => {
          const row = first(rows)
          const signedUp = num(row[0])
          return {
            value: ratio(num(row[1]), signedUp),
            sample: signedUp,
            extra: { signed_up: signedUp, activated: num(row[1]) },
            confidence: signedUp >= 200 ? 'high' : signedUp >= 30 ? 'medium' : 'low',
          }
        },
      }
    },
  },

  {
    id: 'purchase_conversion',
    name: 'Activation → paid',
    question: 'Of the people who got value, how many paid?',
    unit: 'percent',
    direction: 'higher',
    requiresRoles: ['purchase'],
    minSample: 30,
    explanation:
      'The commercial step. Read it against activation: a healthy activation rate with poor conversion is a pricing or packaging problem, while poor activation makes this number meaningless.',
    build: ({ roles }) => {
      const purchase = roles.purchase
      const upstream = activationEvent(roles) ?? roles.signup_completed
      if (!purchase || !upstream) return null
      return {
        sql: `
          SELECT
            count() AS upstream,
            countIf(paid_at > upstream_at) AS paid
          FROM (
            SELECT
              distinct_id,
              minIf(timestamp, event = ${esc(upstream)}) AS upstream_at,
              minIf(timestamp, event = ${esc(purchase)}) AS paid_at
            FROM events
            WHERE event IN (${esc(upstream)}, ${esc(purchase)})
              AND timestamp > now() - INTERVAL 90 DAY
            GROUP BY distinct_id
            HAVING countIf(event = ${esc(upstream)}) > 0
          )
        `,
        parse: (rows) => {
          const row = first(rows)
          const upstreamCount = num(row[0])
          return {
            value: ratio(num(row[1]), upstreamCount),
            sample: upstreamCount,
            extra: { upstream: upstreamCount, paid: num(row[1]) },
            confidence: upstreamCount >= 200 ? 'high' : upstreamCount >= 30 ? 'medium' : 'low',
          }
        },
      }
    },
  },

  {
    id: 'time_to_value',
    name: 'Time to first value',
    question: 'How long does it take someone to get something out of this?',
    unit: 'days',
    direction: 'lower',
    minSample: 30,
    explanation:
      'Median time from a person first appearing to them reaching the activation moment. A long tail means people leave and come back to finish, which is a case for a reminder. A tight distribution means it is a single-session decision.',
    describeMissing: (roles) =>
      activationEvent(roles)
        ? null
        : 'Nothing in this project looks like a core action to measure time-to-value against.',
    build: ({ roles }) => {
      const activation = activationEvent(roles)
      if (!activation) return null
      return {
        sql: `
          SELECT
            count() AS people,
            median(hours_to_value) / 24 AS median_days,
            quantile(0.9)(hours_to_value) / 24 AS p90_days
          FROM (
            SELECT
              distinct_id,
              dateDiff('hour', min(timestamp), minIf(timestamp, event = ${esc(activation)})) AS hours_to_value
            FROM events
            WHERE timestamp > now() - INTERVAL 90 DAY
            GROUP BY distinct_id
            HAVING countIf(event = ${esc(activation)}) > 0
          )
          WHERE hours_to_value >= 0
        `,
        parse: (rows) => {
          const row = first(rows)
          const people = num(row[0])
          return {
            value: num(row[1]),
            sample: people,
            extra: { p90_days: Number(num(row[2]).toFixed(1)) },
            confidence: people >= 100 ? 'high' : people >= 30 ? 'medium' : 'low',
          }
        },
      }
    },
  },

  // -------------------------------------------------------------------------
  // Friction
  // -------------------------------------------------------------------------
  {
    id: 'one_visit_share',
    name: 'People who never came back',
    question: 'What share of people showed up exactly once and vanished?',
    unit: 'percent',
    direction: 'lower',
    minSample: 50,
    explanation:
      'Share of people whose entire history is a single day. This is the clearest possible statement of first-session failure, and it is usually much higher than teams expect.',
    build: () => ({
      sql: `
        SELECT
          count() AS people,
          countIf(active_days = 1) AS one_day
        FROM (
          SELECT distinct_id, count(DISTINCT toDate(timestamp)) AS active_days, min(timestamp) AS first_seen
          FROM events
          WHERE timestamp > now() - INTERVAL ${HISTORY} DAY
          GROUP BY distinct_id
          HAVING ${COHORT}
        )
      `,
      parse: (rows) => {
        const row = first(rows)
        const people = num(row[0])
        return {
          value: ratio(num(row[1]), people),
          sample: people,
          confidence: people >= 200 ? 'high' : people >= 50 ? 'medium' : 'low',
        }
      },
    }),
  },

  {
    id: 'error_exposure',
    name: 'People hitting errors',
    question: 'What share of active people saw something break?',
    unit: 'percent',
    direction: 'lower',
    requiresRoles: ['error'],
    minSample: 50,
    explanation:
      'People affected matters far more than error count. One broken loop firing a thousand times for one user is a bug report; the same count spread over four hundred people is an incident.',
    build: ({ roles }) => {
      const errorEvent = roles.error
      if (!errorEvent) return null
      return {
        sql: `
          SELECT
            count(DISTINCT distinct_id) AS people,
            count(DISTINCT if(event = ${esc(errorEvent)}, distinct_id, NULL)) AS affected,
            countIf(event = ${esc(errorEvent)}) AS error_events
          FROM events
          WHERE timestamp > now() - INTERVAL 30 DAY
        `,
        parse: (rows) => {
          const row = first(rows)
          const people = num(row[0])
          return {
            value: ratio(num(row[1]), people),
            sample: people,
            extra: { affected: num(row[1]), error_events: num(row[2]) },
            confidence: people >= 200 ? 'high' : people >= 50 ? 'medium' : 'low',
          }
        },
      }
    },
  },

  {
    id: 'engagement_depth',
    name: 'Actions per active person',
    question: 'How much does a typical active person actually do?',
    unit: 'perPerson',
    direction: 'higher',
    minSample: 50,
    explanation:
      'Events per active person over 30 days, excluding pageviews. Rising while active people stay flat means the product is getting more useful to the people who already have it.',
    build: () => ({
      sql: `
        SELECT
          count(DISTINCT distinct_id) AS people,
          countIf(event NOT IN ('$pageview', '$pageleave', '$autocapture')) AS actions
        FROM events
        WHERE timestamp > now() - INTERVAL 30 DAY
      `,
      parse: (rows) => {
        const row = first(rows)
        const people = num(row[0])
        return {
          value: ratio(num(row[1]), people),
          sample: people,
          confidence: people >= 100 ? 'high' : people >= 50 ? 'medium' : 'low',
        }
      },
    }),
  },

  // -------------------------------------------------------------------------
  // Acquisition
  // -------------------------------------------------------------------------
  {
    id: 'channel_concentration',
    name: 'Top channel share',
    question: 'How much of your traffic comes from a single source?',
    unit: 'percent',
    direction: 'neutral',
    minSample: 100,
    explanation:
      'Share of people arriving from the largest single channel. High concentration is fragile: one algorithm change or one policy update and the number that matters halves overnight.',
    build: () => ({
      sql: `
        SELECT
          source,
          people,
          total
        FROM (
          SELECT
            coalesce(nullIf(properties.$initial_utm_source, ''), properties.$initial_referring_domain, '(direct)') AS source,
            count(DISTINCT distinct_id) AS people,
            (SELECT count(DISTINCT distinct_id) FROM events WHERE timestamp > now() - INTERVAL 30 DAY) AS total
          FROM events
          WHERE timestamp > now() - INTERVAL 30 DAY
          GROUP BY source
          ORDER BY people DESC
          LIMIT 1
        )
      `,
      parse: (rows) => {
        const row = first(rows)
        const total = num(row[2])
        return {
          value: ratio(num(row[1]), total),
          sample: total,
          extra: { top_source: String(row[0] ?? 'unknown'), top_source_people: num(row[1]) },
          confidence: total >= 300 ? 'high' : total >= 100 ? 'medium' : 'low',
        }
      },
    }),
  },

  // -------------------------------------------------------------------------
  // Whether the measurement itself is trustworthy
  // -------------------------------------------------------------------------
  {
    id: 'silent_events',
    name: 'Events that stopped arriving',
    question: 'Has any instrumentation broken recently?',
    unit: 'count',
    direction: 'lower',
    explanation:
      'Events PostHog saw between 8 and 30 days ago and has not seen since. Each one is a chart somewhere that is now quietly drawing a flat line.',
    build: () => ({
      sql: `
        SELECT
          count() AS silent,
          arrayStringConcat(groupArray(event), ', ') AS names
        FROM (
          SELECT event
          FROM events
          WHERE timestamp > now() - INTERVAL 30 DAY AND timestamp < now() - INTERVAL 7 DAY
          GROUP BY event
          HAVING count() > 20
        )
        WHERE event NOT IN (
          SELECT DISTINCT event FROM events WHERE timestamp > now() - INTERVAL 7 DAY
        )
      `,
      parse: (rows) => {
        const row = first(rows)
        return {
          value: num(row[0]),
          extra: { names: String(row[1] ?? '') },
          confidence: 'high',
        }
      },
    }),
  },

  {
    id: 'high_cardinality_properties',
    name: 'Runaway properties',
    question: 'Is any property quietly exploding your bill and your breakdowns?',
    unit: 'count',
    direction: 'lower',
    explanation:
      'Event properties carrying more than 50 distinct values in a week. Almost always a raw id, email, URL or free-text search term that should have been bucketed at the call site.',
    build: () => ({
      sql: `
        SELECT
          count() AS runaway,
          arrayStringConcat(arraySlice(groupArray(property), 1, 5), ', ') AS worst
        FROM (
          SELECT
            key AS property,
            uniq(value) AS distinct_values
          FROM events
          ARRAY JOIN
            JSONExtractKeysAndValuesRaw(properties) AS kv,
            kv.1 AS key,
            kv.2 AS value
          WHERE timestamp > now() - INTERVAL 7 DAY
            AND NOT startsWith(key, '$')
          GROUP BY property
          HAVING distinct_values > 50
          ORDER BY distinct_values DESC
        )
      `,
      parse: (rows) => {
        const row = first(rows)
        return { value: num(row[0]), extra: { worst: String(row[1] ?? '') }, confidence: 'high' }
      },
    }),
  },

  {
    id: 'pageview_integrity',
    name: 'Pageview integrity',
    question: 'Is the SDK capturing the first page load of each session?',
    unit: 'ratio',
    direction: 'neutral',
    explanation:
      'Ratio of $pageview to $pageleave. These should track each other closely. Far more page-leaves means the SDK is missing the first load of every session, so every traffic number is understated and Web Analytics reads near zero.',
    build: () => ({
      sql: `
        SELECT
          countIf(event = '$pageview') AS views,
          countIf(event = '$pageleave') AS leaves
        FROM events
        WHERE timestamp > now() - INTERVAL 14 DAY
          AND event IN ('$pageview', '$pageleave')
      `,
      parse: (rows) => {
        const row = first(rows)
        const views = num(row[0])
        const leaves = num(row[1])
        return {
          value: leaves > 0 ? views / leaves : null,
          sample: views + leaves,
          extra: { views, leaves },
          confidence: leaves >= 100 ? 'high' : 'low',
        }
      },
    }),
  },
]

export function metricById(id: string): MetricRunner | undefined {
  return METRICS.find((metric) => metric.id === id)
}
