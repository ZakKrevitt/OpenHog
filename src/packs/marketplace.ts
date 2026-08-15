/**
 * Marketplaces have two user bases and one number that matters: whether a
 * search finds something worth transacting on. Liquidity, not traffic.
 */

import type { Pack } from '../types.js'
import { funnel, hogql, trends } from '../posthog/queries.js'
import { compact, dashboard, firstRole, role, sql, tile } from './helpers.js'

export const marketplacePack: Pack = {
  id: 'marketplace',
  name: 'Marketplace',
  description: 'Supply and demand balance, search liquidity, and the path from browsing to a transaction.',
  appliesTo: ['marketplace'],
  events: [],
  build: (plan) => {
    const pageView = role(plan, 'page_view') ?? '$pageview'
    const search = role(plan, 'search')
    const listing = firstRole(plan, 'content_opened', 'core_action')
    const created = role(plan, 'core_action')
    const transaction = firstRole(plan, 'purchase', 'checkout_started')
    const empty = role(plan, 'empty_state')
    const message = role(plan, 'message_sent')

    return compact([
      dashboard({
        key: 'marketplace-liquidity',
        name: 'Marketplace — liquidity',
        description:
          'Whether demand finds supply. A marketplace with plenty of both sides and no liquidity is two mailing lists.',
        question: 'Do searches turn into transactions?',
        tiles: [
          tile({
            key: 'search-funnel',
            name: 'Search → listing → transaction',
            description: 'The core liquidity funnel.',
            interpretation:
              'The search-to-listing step is a matching problem (inventory, ranking, filters). The listing-to-transaction step is a trust problem (photos, reviews, price, response time). They are fixed by completely different teams — read which one is leaking before assigning work.',
            width: 'full',
            query: funnel({
              series: [search, listing, transaction]
                .filter((event): event is string => Boolean(event))
                .map((event) => ({ event })),
              dateFrom: '-30d',
              windowInterval: 7,
            }),
            requires: [search, listing],
          }),
          tile({
            key: 'zero-results',
            name: 'Searches that found nothing',
            description: 'Empty-result searches over time.',
            interpretation:
              'Every one of these is demand you already have and cannot serve. This is your supply acquisition roadmap, written by your own users, and it is more reliable than any market research.',
            width: 'half',
            query: trends({
              series: [
                { event: empty ?? pageView, name: 'Zero results', math: 'total' },
                { event: search ?? pageView, name: 'All searches', math: 'total' },
              ],
              dateFrom: '-60d',
            }),
            requires: [empty, search],
          }),
          tile({
            key: 'supply-demand',
            name: 'Supply and demand over time',
            description: 'Listings created against listings viewed, weekly.',
            interpretation:
              'The ratio matters more than either line. Demand growing faster than supply shows up as rising zero-result searches long before anyone complains; supply outpacing demand shows up as unhappy sellers.',
            width: 'half',
            query: trends({
              series: [
                ...(created ? [{ event: created, name: 'Listings created', math: 'total' as const }] : []),
                ...(listing ? [{ event: listing, name: 'Listings viewed', math: 'total' as const }] : []),
              ],
              dateFrom: '-90d',
              interval: 'week',
            }),
            requires: [created ?? listing],
          }),
          tile({
            key: 'contact-rate',
            name: 'Listing → contact',
            description: 'How often viewing a listing leads to a message or enquiry.',
            interpretation:
              'In any marketplace with a negotiation step, this is the real conversion event. Response time on the other side is what determines whether it turns into money — instrument that next.',
            width: 'half',
            query: funnel({
              series: [listing, message]
                .filter((event): event is string => Boolean(event))
                .map((event) => ({ event })),
              dateFrom: '-30d',
              windowInterval: 1,
              windowIntervalUnit: 'day',
            }),
            requires: [listing, message],
          }),
          tile({
            key: 'both-sides',
            name: 'People who did both sides',
            description: 'People who both created and consumed, weekly.',
            interpretation:
              'A healthy marketplace usually grows a group who do both. If it is near zero, you are running two separate products that happen to share a database.',
            width: 'half',
            query: hogql(sql`
              SELECT
                toStartOfWeek(timestamp) AS week,
                count(DISTINCT distinct_id) AS people,
                count(DISTINCT if(event = ${`'${created ?? 'created'}'`}, distinct_id, NULL)) AS supply_side,
                count(DISTINCT if(event = ${`'${listing ?? 'viewed'}'`}, distinct_id, NULL)) AS demand_side
              FROM events
              WHERE timestamp > now() - INTERVAL 90 DAY
              GROUP BY week
              ORDER BY week
            `),
            requires: [created, listing],
          }),
        ],
      }),
    ])
  },
}
