/**
 * Content sites and publications. Pageviews are the easy number and the least
 * useful one, so this pack is about depth, return visits and whether reading
 * turns into a subscription.
 */

import type { Pack } from '../types.js'
import { funnel, hogql, retention, trends } from '../posthog/queries.js'
import { compact, dashboard, firstRole, role, sql, tile } from './helpers.js'

export const contentPack: Pack = {
  id: 'content',
  name: 'Content',
  description: 'Reading depth, which pieces earn return visits, and the path from reader to subscriber.',
  appliesTo: ['content'],
  events: [],
  build: (plan) => {
    const pageView = role(plan, 'page_view') ?? '$pageview'
    const opened = role(plan, 'content_opened')
    const share = role(plan, 'share')
    const save = role(plan, 'save')
    const subscribe = firstRole(plan, 'subscription_started', 'signup_completed')
    const search = role(plan, 'search')

    return compact([
      dashboard({
        key: 'content-performance',
        name: 'Content - what earns attention',
        description:
          'Which pieces bring people in, which keep them, and which turn a reader into someone who comes back on purpose.',
        question: 'Which writing is doing the work?',
        tiles: [
          tile({
            key: 'top-content',
            name: 'Pieces by reader',
            description: 'Content routes by distinct people, not raw views.',
            interpretation:
              'People rather than views, because one person refreshing is not an audience. Compare the ranking against the views ranking: a piece high on views and low on people is being shared into one thread somewhere.',
            width: 'full',
            query: trends({
              series: [{ event: opened ?? pageView, math: 'dau' }],
              dateFrom: '-30d',
              display: 'ActionsBarValue',
              breakdown: '$pathname',
              breakdownLimit: 30,
            }),
            requires: [pageView],
          }),
          tile({
            key: 'return-readers',
            name: 'Return readers',
            description: 'Retention for people whose first visit was to a content page.',
            interpretation:
              'This is the number that separates a publication from a series of viral posts. Traffic without return visits means you are renting attention from an algorithm.',
            width: 'half',
            query: retention({
              targetEvent: pageView,
              returningEvent: opened ?? pageView,
              period: 'Week',
              totalIntervals: 8,
            }),
            requires: [pageView],
          }),
          tile({
            key: 'reader-to-subscriber',
            name: 'Reader → subscriber',
            description: 'From reading something to signing up.',
            interpretation:
              'Break this down by landing page when you can. Usually one or two pieces convert far better than the rest, and those are the ones to put in front of new arrivals.',
            width: 'half',
            query: funnel({
              series: [opened ?? pageView, subscribe]
                .filter((event): event is string => Boolean(event))
                .map((event) => ({ event })),
              dateFrom: '-60d',
              windowInterval: 14,
            }),
            requires: [subscribe],
          }),
          tile({
            key: 'shares',
            name: 'Shares by piece',
            description: 'Which content gets pushed out.',
            interpretation:
              'Share rate per reader is a better quality signal than raw views, because it is a person putting their own name behind it. Write more of whatever is at the top.',
            width: 'half',
            query: trends({
              series: [{ event: share ?? pageView, math: 'total' }],
              dateFrom: '-60d',
              display: 'ActionsBarValue',
              breakdown: '$pathname',
            }),
            requires: [share],
          }),
          tile({
            key: 'depth',
            name: 'Pieces read per session',
            description: 'How many content pages an average session covers.',
            interpretation:
              'Above about 1.5 means your internal linking and recommendations work. At 1.0 every visitor reads one thing and leaves, and the fix is related-content placement rather than more writing.',
            width: 'half',
            query: hogql(sql`
              SELECT
                toStartOfWeek(timestamp) AS week,
                round(count() / nullif(count(DISTINCT $session_id), 0), 2) AS pages_per_session,
                count(DISTINCT $session_id) AS sessions
              FROM events
              WHERE event = '$pageview'
                AND timestamp > now() - INTERVAL 90 DAY
                AND $session_id IS NOT NULL
              GROUP BY week
              ORDER BY week
            `),
            requires: [pageView],
          }),
          tile({
            key: 'search',
            name: 'On-site search',
            description: 'What people look for once they are here.',
            interpretation:
              'Search on a content site is a direct request for something you have not written yet, or have written and buried. Both are worth acting on.',
            width: 'half',
            query: trends({ series: [{ event: search ?? pageView, math: 'total' }], dateFrom: '-60d' }),
            requires: [search],
          }),
          tile({
            key: 'saves',
            name: 'Saved to read later',
            description: 'Bookmarks and saves.',
            interpretation:
              'A save is a promise to return. Whether people keep that promise is visible in the return-readers tile - if saves are high and returns are low, a reminder is doing real work for the reader.',
            width: 'half',
            query: trends({ series: [{ event: save ?? pageView, math: 'total' }], dateFrom: '-60d' }),
            requires: [save],
          }),
        ],
      }),
    ])
  },
}
