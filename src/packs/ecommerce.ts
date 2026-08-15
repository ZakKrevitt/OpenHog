/**
 * Ecommerce. One funnel matters more than everything else, so this pack spends
 * most of its tiles on the cart and the rest on what people looked at first.
 */

import type { Pack } from '../types.js'
import { bigNumber, funnel, hogql, paths, trends } from '../posthog/queries.js'
import { compact, dashboard, firstRole, role, sql, tile } from './helpers.js'

export const ecommercePack: Pack = {
  id: 'ecommerce',
  name: 'Ecommerce',
  description: 'Cart funnel, product discovery, abandonment and repeat purchase.',
  appliesTo: ['ecommerce'],
  events: [],
  build: (plan) => {
    const pageView = role(plan, 'page_view') ?? '$pageview'
    const product = firstRole(plan, 'content_opened', 'core_action')
    const checkout = role(plan, 'checkout_started')
    const purchase = role(plan, 'purchase')
    const search = role(plan, 'search')
    const save = role(plan, 'save')

    return compact([
      dashboard({
        key: 'ecommerce-funnel',
        name: 'Ecommerce — the cart funnel',
        description:
          'From landing to paid, and every place money leaks out on the way. Abandonment gets its own tiles because it is where the recoverable revenue is.',
        question: 'How much revenue is leaking, and at which step?',
        tiles: [
          tile({
            key: 'orders',
            name: 'Orders',
            description: 'Completed purchases in the last 7 days, against the week before.',
            interpretation:
              'Check this against the same week last year, not last week — almost every store is seasonal enough that week-on-week is noise.',
            width: 'third',
            query: bigNumber({ event: purchase ?? pageView, math: 'total' }, '-7d'),
            requires: [purchase],
          }),
          tile({
            key: 'checkouts',
            name: 'Checkouts started',
            description: 'People who entered the paying flow.',
            interpretation:
              'The gap between this and orders is your abandonment, and it is nearly always the largest single recoverable number in the business.',
            width: 'third',
            query: bigNumber({ event: checkout ?? pageView, math: 'total' }, '-7d'),
            requires: [checkout],
          }),
          tile({
            key: 'buyers',
            name: 'Distinct buyers',
            description: 'People who bought at least once in 7 days.',
            interpretation:
              'Orders divided by buyers is basket frequency. Rising orders with flat buyers means your existing customers are buying more, which is cheaper growth than any ad.',
            width: 'third',
            query: bigNumber({ event: purchase ?? pageView, math: 'dau' }, '-7d'),
            requires: [purchase],
          }),
          tile({
            key: 'full-funnel',
            name: 'Browse → product → checkout → paid',
            description: 'The whole path with a 7-day window.',
            interpretation:
              'Two steps to watch. Product-to-checkout is a merchandising and pricing problem. Checkout-to-paid is a forms, shipping-cost and payment-method problem, and it is usually the cheaper of the two to fix.',
            width: 'full',
            query: funnel({
              series: [pageView, product, checkout, purchase]
                .filter((event): event is string => Boolean(event))
                .map((event) => ({ event })),
              dateFrom: '-30d',
              windowInterval: 7,
            }),
            requires: [pageView, purchase],
          }),
          tile({
            key: 'abandon-by-device',
            name: 'Checkout completion by device',
            description: 'The checkout-to-paid step, split by device type.',
            interpretation:
              'Mobile checkout completion is almost always worse. If the gap is more than about ten points, the fix is usually payment methods (wallet buttons) rather than layout.',
            width: 'half',
            query: funnel({
              series: [checkout, purchase]
                .filter((event): event is string => Boolean(event))
                .map((event) => ({ event })),
              dateFrom: '-30d',
              breakdown: '$device_type',
            }),
            requires: [checkout, purchase],
          }),
          tile({
            key: 'abandon-paths',
            name: 'Where abandoners go instead',
            description: 'Page paths that start at checkout and do not end at a purchase.',
            interpretation:
              'People bouncing to a shipping or returns page are telling you your policy is not visible early enough. That is a copy fix, and it is free.',
            width: 'half',
            query: paths({ dateFrom: '-14d', startPoint: checkout ?? undefined, stepLimit: 4 }),
            requires: [checkout],
          }),
          tile({
            key: 'repeat-rate',
            name: 'Repeat purchase rate',
            description: 'Share of buyers each month who had bought before.',
            interpretation:
              'The number that decides whether you have a business or a series of transactions. Under about 20% and every month starts from zero, which makes paid acquisition the only lever you have.',
            width: 'full',
            query: hogql(sql`
              SELECT
                toStartOfMonth(timestamp) AS month,
                count(DISTINCT distinct_id) AS buyers,
                count() AS orders,
                round(orders / nullif(buyers, 0), 2) AS orders_per_buyer
              FROM events
              WHERE event = ${`'${purchase ?? 'purchase'}'`}
                AND timestamp > now() - INTERVAL 12 MONTH
              GROUP BY month
              ORDER BY month
            `),
            requires: [purchase],
          }),
        ],
      }),
      dashboard({
        key: 'ecommerce-discovery',
        name: 'Ecommerce — discovery',
        description: 'How people find things to buy, and what happens when they cannot.',
        question: 'Can people find what they came for?',
        tiles: [
          tile({
            key: 'search-to-purchase',
            name: 'Search → product → purchase',
            description: 'The funnel for people who use search.',
            interpretation:
              'Searchers usually convert far better than browsers. If they do not here, your search results are wrong, and that is a catalogue or synonym problem rather than a UI one.',
            width: 'half',
            query: funnel({
              series: [search, product, purchase]
                .filter((event): event is string => Boolean(event))
                .map((event) => ({ event })),
              dateFrom: '-30d',
            }),
            requires: [search, purchase],
          }),
          tile({
            key: 'top-products',
            name: 'Most-viewed products',
            description: 'Product page views by route.',
            interpretation:
              'Cross-reference with what actually sells. A product with heavy traffic and no sales has a price, photo or stock problem, and it is the highest-leverage page on the site to fix.',
            width: 'half',
            query: trends({
              series: [{ event: product ?? pageView, math: 'total' }],
              dateFrom: '-30d',
              display: 'ActionsBarValue',
              breakdown: '$pathname',
              breakdownLimit: 25,
            }),
            requires: [product],
          }),
          tile({
            key: 'wishlist',
            name: 'Saved for later',
            description: 'Wishlist and save events.',
            interpretation:
              'A saved item is a stated intent to buy that has not happened yet. This is the most legitimate reminder email you will ever send.',
            width: 'half',
            query: trends({ series: [{ event: save ?? pageView, math: 'total' }], dateFrom: '-60d' }),
            requires: [save],
          }),
        ],
      }),
    ])
  },
}
