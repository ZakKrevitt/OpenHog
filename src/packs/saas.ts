/**
 * SaaS. The questions are about money over time: does the trial convert, does
 * the account expand, and can you see churn coming before the invoice does.
 */

import type { Pack } from '../types.js'
import { bigNumber, funnel, hogql, retention, trends } from '../posthog/queries.js'
import { compact, dashboard, firstRole, role, sql, tile } from './helpers.js'

export const saasPack: Pack = {
  id: 'saas',
  name: 'SaaS',
  description: 'Trial to paid, feature adoption, expansion and churn warning signs.',
  appliesTo: ['saas'],
  events: [],
  build: (plan) => {
    const signup = role(plan, 'signup_completed')
    const trial = role(plan, 'trial_started')
    const pricing = role(plan, 'pricing_viewed')
    const subscribe = firstRole(plan, 'subscription_started', 'purchase')
    const cancel = role(plan, 'subscription_cancelled')
    const core = firstRole(plan, 'core_action', 'activation')
    const invite = role(plan, 'invite_sent')
    const pageView = role(plan, 'page_view') ?? '$pageview'

    return compact([
      dashboard({
        key: 'saas-revenue',
        name: 'SaaS — trial, conversion & churn',
        description:
          'The money path. Every tile here is about whether an account becomes, stays, or stops being a paying one.',
        question: 'Are trials turning into subscriptions, and are subscriptions surviving?',
        tiles: [
          tile({
            key: 'new-subs',
            name: 'New subscriptions',
            description: 'Subscriptions started in the last 7 days, against the week before.',
            interpretation:
              'Read alongside cancellations, never alone. Net is the only number that matters and it is the one nobody puts on a slide.',
            width: 'third',
            query: bigNumber({ event: subscribe ?? pageView, math: 'total' }, '-7d'),
            requires: [subscribe],
          }),
          tile({
            key: 'cancellations',
            name: 'Cancellations',
            description: 'Subscriptions ended in the last 7 days.',
            interpretation:
              'Sustained above new subscriptions means you are shrinking. Before rebuilding the product, check whether cancellations cluster at a specific tenure — a spike at month 2 is an onboarding failure surfacing late.',
            width: 'third',
            query: bigNumber({ event: cancel ?? pageView, math: 'total' }, '-7d'),
            requires: [cancel],
          }),
          tile({
            key: 'trials',
            name: 'Trials started',
            description: 'Trials begun in the last 7 days.',
            interpretation:
              'The leading indicator for revenue roughly one trial length from now. If this falls, the revenue drop is already booked.',
            width: 'third',
            query: bigNumber({ event: trial ?? pageView, math: 'total' }, '-7d'),
            requires: [trial],
          }),
          tile({
            key: 'trial-funnel',
            name: 'Signup → pricing → trial → paid',
            description: 'The whole commercial funnel, with a 30-day window.',
            interpretation:
              'The pricing step is the one to watch. Lots of pricing views with few trials means the price or the packaging is wrong, not the product. Few pricing views at all means people never got far enough to care.',
            width: 'full',
            query: funnel({
              series: [signup, pricing, trial, subscribe]
                .filter((event): event is string => Boolean(event))
                .map((event) => ({ event })),
              dateFrom: '-90d',
              windowInterval: 30,
            }),
            requires: [signup, subscribe],
          }),
          tile({
            key: 'conversion-over-time',
            name: 'Trials and conversions over time',
            description: 'Trials started and subscriptions started on the same axis.',
            interpretation:
              'The gap between the lines, shifted by your trial length, is your conversion rate drawn over time. A widening gap means recent cohorts are converting worse — look at what shipped.',
            width: 'half',
            query: trends({
              series: [
                { event: trial ?? subscribe ?? pageView, name: 'Trials' },
                { event: subscribe ?? pageView, name: 'Subscriptions' },
              ],
              dateFrom: '-90d',
              interval: 'week',
            }),
            requires: [subscribe],
          }),
          tile({
            key: 'churn-warning',
            name: 'Accounts going quiet',
            description:
              'People who were active in the previous 30 days and have done nothing in the last 14.',
            interpretation:
              'Your outreach list, in priority order. Churn is decided weeks before anyone clicks cancel, and this table is that window. Contact the top of the list this week.',
            width: 'half',
            query: hogql(sql`
              SELECT
                distinct_id AS person,
                max(timestamp) AS last_seen,
                dateDiff('day', max(timestamp), now()) AS days_quiet,
                count() AS lifetime_actions
              FROM events
              WHERE timestamp > now() - INTERVAL 60 DAY
              GROUP BY person
              HAVING days_quiet BETWEEN 14 AND 45
                AND lifetime_actions > 20
              ORDER BY lifetime_actions DESC
              LIMIT 50
            `),
            requires: [pageView],
          }),
          tile({
            key: 'paid-retention',
            name: 'Retention after subscribing',
            description: 'Of the people who subscribed in a given week, how many are still active later.',
            interpretation:
              'The honest churn number. A subscription that renews while nobody logs in is revenue you are about to lose; this curve sees it months before billing does.',
            width: 'full',
            query: retention({
              targetEvent: subscribe ?? pageView,
              returningEvent: core ?? pageView,
              period: 'Week',
              totalIntervals: 12,
            }),
            requires: [subscribe],
          }),
        ],
      }),
      dashboard({
        key: 'saas-adoption',
        name: 'SaaS — feature adoption & expansion',
        description:
          'Which parts of the product get used, by whom, and whether accounts are growing into more of it over time.',
        question: 'Is the product getting deeper for the accounts that stay?',
        tiles: [
          tile({
            key: 'feature-table',
            name: 'Feature adoption',
            description: 'Each event, with how many people used it and what share of active people that is.',
            interpretation:
              'Anything under about 5% of active people is either undiscoverable or unwanted. Decide which, then either surface it or delete it — carrying it costs you on every release.',
            width: 'full',
            query: hogql(sql`
              SELECT
                event AS feature,
                count(DISTINCT distinct_id) AS people,
                count() AS uses,
                round(100.0 * people / nullif((
                  SELECT count(DISTINCT distinct_id) FROM events WHERE timestamp > now() - INTERVAL 30 DAY
                ), 0), 1) AS pct_of_active
              FROM events
              WHERE timestamp > now() - INTERVAL 30 DAY
                AND event NOT IN ('$pageview', '$pageleave', '$autocapture')
              GROUP BY feature
              ORDER BY people DESC
              LIMIT 60
            `),
            requires: [pageView],
          }),
          tile({
            key: 'invites',
            name: 'Team invitations',
            description: 'Invites sent over time.',
            interpretation:
              'In B2B this is the strongest expansion signal there is: an account that invites colleagues is an account that renews. If it is flat, the invite flow is probably buried.',
            width: 'half',
            query: trends({ series: [{ event: invite ?? pageView, math: 'total' }], dateFrom: '-90d', interval: 'week' }),
            requires: [invite],
          }),
          tile({
            key: 'depth-over-time',
            name: 'Distinct features used per person',
            description: 'How much of the product an average active person touches.',
            interpretation:
              'Rising means accounts are maturing into the product, which is what predicts renewal better than raw usage. Falling while usage holds means people have settled into one feature and the rest is dead weight.',
            width: 'half',
            query: hogql(sql`
              SELECT
                toStartOfWeek(timestamp) AS week,
                round(count(DISTINCT event) / nullif(count(DISTINCT distinct_id), 0), 2) AS features_per_person
              FROM events
              WHERE timestamp > now() - INTERVAL 90 DAY
                AND event NOT IN ('$pageview', '$pageleave')
              GROUP BY week
              ORDER BY week
            `),
            requires: [pageView],
          }),
        ],
      }),
    ])
  },
}
