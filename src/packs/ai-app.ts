/**
 * AI products. The distinctive questions are about quality and cost per
 * interaction, not page flow: did the model produce something the person kept,
 * and how many attempts did it take.
 */

import type { Pack } from '../types.js'
import { bigNumber, funnel, hogql, retention, trends } from '../posthog/queries.js'
import { compact, dashboard, firstRole, role, sql, tile } from './helpers.js'

export const aiAppPack: Pack = {
  id: 'ai-app',
  name: 'AI app',
  description: 'Generation volume, output quality signals, retry behaviour and cost per active user.',
  appliesTo: ['ai-app'],
  events: [],
  build: (plan) => {
    const pageView = role(plan, 'page_view') ?? '$pageview'
    const generate = firstRole(plan, 'ai_generation', 'message_sent', 'core_action')
    const feedback = role(plan, 'ai_feedback')
    const save = role(plan, 'save')
    const share = role(plan, 'share')
    const errorEvent = role(plan, 'error')
    const signup = role(plan, 'signup_completed')

    return compact([
      dashboard({
        key: 'ai-usage',
        name: 'AI - generation & quality',
        description:
          'What the model is being asked to do and whether the answer was good enough to keep. Retries and regenerations are treated as quality signals, because that is what they are.',
        question: 'Is the model producing things people actually keep?',
        tiles: [
          tile({
            key: 'generations',
            name: 'Generations',
            description: 'Model calls triggered by a person in the last 7 days.',
            interpretation:
              'Your cost driver and your usage metric at once. Track it against active people: rising generations with flat people means a few heavy users, which is a margin risk before it is a success.',
            width: 'third',
            query: bigNumber({ event: generate ?? pageView, math: 'total' }, '-7d'),
            requires: [generate],
          }),
          tile({
            key: 'generating-people',
            name: 'People generating',
            description: 'Distinct people who ran at least one generation.',
            interpretation:
              'The denominator for cost per user. If this is much smaller than active people, most of your users are looking rather than doing, and the prompt entry point is probably not obvious.',
            width: 'third',
            query: bigNumber({ event: generate ?? pageView, math: 'dau' }, '-7d'),
            requires: [generate],
          }),
          tile({
            key: 'per-person',
            name: 'Generations per person',
            description: 'Average generations per active person per day.',
            interpretation:
              'A sharp rise usually means retries, not enthusiasm. Check it against the feedback and regeneration tiles before celebrating.',
            width: 'third',
            query: trends({
              series: [{ event: generate ?? pageView, math: 'avg_count_per_actor' }],
              dateFrom: '-30d',
              display: 'BoldNumber',
            }),
            requires: [generate],
          }),
          tile({
            key: 'generation-outcome',
            name: 'Generate → keep',
            description: 'From a generation to the person saving, sharing or otherwise keeping the output.',
            interpretation:
              'The closest thing to a quality metric you can get without asking anyone. If keep rate falls after a model or prompt change, roll it back - this catches regressions that evals miss.',
            width: 'half',
            query: funnel({
              series: [generate, save ?? share]
                .filter((event): event is string => Boolean(event))
                .map((event) => ({ event })),
              dateFrom: '-30d',
              windowInterval: 1,
              windowIntervalUnit: 'hour',
            }),
            requires: [generate, save ?? share],
          }),
          tile({
            key: 'feedback',
            name: 'Explicit feedback',
            description: 'Thumbs, ratings and regenerations over time.',
            interpretation:
              'Volume matters less than direction. A rising regeneration rate is the earliest signal of a prompt or model regression, and it usually moves days before anyone complains.',
            width: 'half',
            query: trends({
              series: [{ event: feedback ?? pageView, math: 'total' }],
              dateFrom: '-60d',
              breakdown: 'rating',
            }),
            requires: [feedback],
          }),
          tile({
            key: 'errors',
            name: 'Failed generations',
            description: 'Errors during generation over time.',
            interpretation:
              'Separate provider failures from prompt failures if you can - they need different fixes and only one of them is yours. Either way a person who sees two failures in a row usually does not come back.',
            width: 'half',
            query: trends({
              series: [
                { event: errorEvent ?? pageView, name: 'Errors', math: 'total' },
                { event: generate ?? pageView, name: 'Generations', math: 'total' },
              ],
              dateFrom: '-30d',
            }),
            requires: [errorEvent, generate],
          }),
          tile({
            key: 'first-generation',
            name: 'Signup → first generation',
            description: 'How many new people ever run one generation, and how fast.',
            interpretation:
              'For an AI product this is the activation moment. Anyone who signs up and never generates has learned nothing about what you do, and will not return. Aim to make the first generation possible before signup.',
            width: 'half',
            query: funnel({
              series: [signup, generate]
                .filter((event): event is string => Boolean(event))
                .map((event) => ({ event })),
              dateFrom: '-60d',
              windowInterval: 7,
            }),
            requires: [signup, generate],
          }),
          tile({
            key: 'heavy-users',
            name: 'Heaviest generators',
            description: 'People by generation count over 30 days.',
            interpretation:
              'Read as a cost table as much as an engagement one. The top few people can be a meaningful share of your inference bill; check the shape before you price anything as unlimited.',
            width: 'full',
            query: hogql(sql`
              SELECT
                distinct_id AS person,
                count() AS generations,
                count(DISTINCT toDate(timestamp)) AS active_days,
                round(generations / nullif(active_days, 0), 1) AS per_active_day
              FROM events
              WHERE event = ${`'${generate ?? 'generate'}'`}
                AND timestamp > now() - INTERVAL 30 DAY
              GROUP BY person
              ORDER BY generations DESC
              LIMIT 30
            `),
            requires: [generate],
          }),
          tile({
            key: 'retention',
            name: 'Retention after first generation',
            description: 'Do people who generated once come back and generate again?',
            interpretation:
              'The only retention curve that matters for an AI product. Week 1 well under half usually means the output is impressive once and not useful twice.',
            width: 'full',
            query: retention({
              targetEvent: generate ?? pageView,
              period: 'Week',
              totalIntervals: 8,
            }),
            requires: [generate],
          }),
        ],
      }),
    ])
  },
}
