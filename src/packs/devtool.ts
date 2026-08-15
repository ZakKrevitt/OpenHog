/**
 * Developer tools. The whole game is time-to-first-success: the gap between
 * "installed it" and "it worked once" decides whether anyone ever comes back.
 */

import type { Pack } from '../types.js'
import { bigNumber, funnel, hogql, retention, trends } from '../posthog/queries.js'
import { compact, dashboard, firstRole, role, sql, tile } from './helpers.js'

export const devtoolPack: Pack = {
  id: 'devtool',
  name: 'Developer tool',
  description: 'Time to first success, docs behaviour, API key lifecycle and the drop-off between install and use.',
  appliesTo: ['devtool'],
  events: [],
  build: (plan) => {
    const pageView = role(plan, 'page_view') ?? '$pageview'
    const signup = role(plan, 'signup_completed')
    const install = role(plan, 'install')
    const apiKey = role(plan, 'api_key_created')
    const firstSuccess = firstRole(plan, 'first_success', 'activation', 'core_action')
    const errorEvent = role(plan, 'error')
    const search = role(plan, 'search')

    return compact([
      dashboard({
        key: 'devtool-ttfs',
        name: 'Dev tool — time to first success',
        description:
          'The only funnel that matters for a developer product: from discovering it to having it work once. Everything else is downstream of this.',
        question: 'How long does it take to get it working, and how many give up?',
        tiles: [
          tile({
            key: 'first-successes',
            name: 'First successes this week',
            description: 'People who got it working for the first time.',
            interpretation:
              'The only acquisition number worth reporting. Stars, installs and signups are all upstream proxies that can rise while this stays flat.',
            width: 'third',
            query: bigNumber({ event: firstSuccess ?? pageView, math: 'dau' }, '-7d'),
            requires: [firstSuccess],
          }),
          tile({
            key: 'keys',
            name: 'API keys created',
            description: 'Credentials issued.',
            interpretation:
              'The step immediately before the first real call. A big gap between keys created and first successes means the quickstart is wrong, and it is the highest-leverage document you own.',
            width: 'third',
            query: bigNumber({ event: apiKey ?? pageView, math: 'total' }, '-7d'),
            requires: [apiKey],
          }),
          tile({
            key: 'installs',
            name: 'Installs',
            description: 'Package installs or setup completions.',
            interpretation:
              'Compare to first successes for your true drop-off. In most developer tools more than half of installs never produce a working call, and nobody measures it.',
            width: 'third',
            query: bigNumber({ event: install ?? pageView, math: 'total' }, '-7d'),
            requires: [install],
          }),
          tile({
            key: 'ttfs-funnel',
            name: 'Docs → signup → key → first success',
            description: 'The onboarding path with a 14-day window.',
            interpretation:
              'Find the steepest step and go and do it yourself on a clean machine. Developer onboarding breaks in places the authors cannot see because their environment is already configured.',
            width: 'full',
            query: funnel({
              series: [pageView, signup, apiKey, firstSuccess]
                .filter((event): event is string => Boolean(event))
                .map((event) => ({ event })),
              dateFrom: '-90d',
              windowInterval: 14,
            }),
            requires: [pageView, firstSuccess],
          }),
          tile({
            key: 'time-to-success',
            name: 'How long it takes',
            description: 'Distribution of time from signup to first success.',
            interpretation:
              'Under ten minutes is excellent, over a day means people are giving up and coming back later, if at all. The long tail is where you should point your quickstart rewrite.',
            width: 'half',
            query: funnel({
              series: [signup, firstSuccess]
                .filter((event): event is string => Boolean(event))
                .map((event) => ({ event })),
              dateFrom: '-90d',
              vizType: 'time_to_convert',
              windowInterval: 30,
            }),
            requires: [signup, firstSuccess],
          }),
          tile({
            key: 'errors-before-success',
            name: 'Errors on the way',
            description: 'Error events over time, with people affected.',
            interpretation:
              'Errors during onboarding are far more costly than errors later: a developer who hits one in the first five minutes concludes the tool is broken rather than that they made a mistake.',
            width: 'half',
            query: trends({
              series: [
                { event: errorEvent ?? pageView, name: 'Errors', math: 'total' },
                { event: errorEvent ?? pageView, name: 'People affected', math: 'dau' },
              ],
              dateFrom: '-30d',
            }),
            requires: [errorEvent],
          }),
          tile({
            key: 'docs-pages',
            name: 'Most-read docs pages',
            description: 'Documentation routes by pageview.',
            interpretation:
              'A page far above the others is either the quickstart (good) or a concept people keep having to re-read (bad). If it is the second, the API is confusing and the docs are compensating.',
            width: 'half',
            query: trends({
              series: [{ event: pageView, math: 'total' }],
              dateFrom: '-30d',
              display: 'ActionsBarValue',
              breakdown: '$pathname',
              breakdownLimit: 25,
            }),
            requires: [pageView],
          }),
          tile({
            key: 'docs-search',
            name: 'Docs search',
            description: 'Searches within documentation.',
            interpretation:
              'Read the actual queries if you capture them (bucketed, not raw). Docs search terms are the most honest feature-request channel you will ever have.',
            width: 'half',
            query: trends({ series: [{ event: search ?? pageView, math: 'total' }], dateFrom: '-30d' }),
            requires: [search],
          }),
          tile({
            key: 'retention',
            name: 'Retention after first success',
            description: 'Do people who got it working come back?',
            interpretation:
              'If this curve is flat and high, stop working on the product and start working on distribution. If it falls off, the tool solved a one-off problem rather than a recurring one.',
            width: 'full',
            query: retention({
              targetEvent: firstSuccess ?? pageView,
              period: 'Week',
              totalIntervals: 12,
            }),
            requires: [firstSuccess],
          }),
          tile({
            key: 'stuck',
            name: 'People who signed up and never succeeded',
            description: 'Accounts with activity but no first success, oldest first.',
            interpretation:
              'The most valuable email list you have. They wanted it enough to sign up and something stopped them; ask them what, one at a time, and you will get your roadmap.',
            width: 'full',
            query: hogql(sql`
              SELECT
                distinct_id AS person,
                min(timestamp) AS first_seen,
                max(timestamp) AS last_seen,
                count() AS actions
              FROM events
              WHERE timestamp > now() - INTERVAL 60 DAY
              GROUP BY person
              HAVING countIf(event = ${`'${firstSuccess ?? 'first_success'}'`}) = 0
                AND actions > 3
              ORDER BY first_seen DESC
              LIMIT 50
            `),
            requires: [firstSuccess],
          }),
        ],
      }),
    ])
  },
}
