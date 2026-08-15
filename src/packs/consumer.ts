/**
 * Consumer apps. Growth is loops, not campaigns, so the questions are about
 * whether the product spreads itself and whether people come back unprompted.
 */

import type { Pack } from '../types.js'
import { bigNumber, funnel, hogql, retention, stickiness, trends } from '../posthog/queries.js'
import { compact, dashboard, firstRole, role, sql, tile } from './helpers.js'

export const consumerPack: Pack = {
  id: 'consumer',
  name: 'Consumer',
  description: 'Viral loops, session depth, notification effectiveness and habit formation.',
  appliesTo: ['consumer'],
  events: [],
  build: (plan) => {
    const pageView = role(plan, 'page_view') ?? '$pageview'
    const share = role(plan, 'share')
    const inviteSent = role(plan, 'invite_sent')
    const inviteAccepted = role(plan, 'invite_accepted')
    const signup = role(plan, 'signup_completed')
    const follow = role(plan, 'follow')
    const notification = role(plan, 'notification_opened')
    const core = firstRole(plan, 'core_action', 'content_opened', 'save')
    const save = role(plan, 'save')
    const install = role(plan, 'install')

    return compact([
      dashboard({
        key: 'consumer-loops',
        name: 'Consumer - viral loops',
        description:
          'Whether the product brings its own users. Every tile is one half of a loop: something pushed out, and something that came back in.',
        question: 'Does one user produce another user?',
        tiles: [
          tile({
            key: 'shares',
            name: 'Shares',
            description: 'How often people push something out of the product.',
            interpretation:
              'The input to every loop. If this is near zero, no amount of referral copy will help - the thing being shared is not worth sharing yet.',
            width: 'third',
            query: bigNumber({ event: share ?? pageView, math: 'total' }, '-7d'),
            requires: [share],
          }),
          tile({
            key: 'invites-sent',
            name: 'Invites sent',
            description: 'Deliberate invitations, as opposed to passive shares.',
            interpretation:
              'Compare with shares. A product with many shares and few invites spreads to strangers; one with many invites spreads inside groups. They need completely different growth work.',
            width: 'third',
            query: bigNumber({ event: inviteSent ?? pageView, math: 'total' }, '-7d'),
            requires: [inviteSent],
          }),
          tile({
            key: 'invites-accepted',
            name: 'Invites accepted',
            description: 'The other end of the loop.',
            interpretation:
              'Accepted divided by sent is your invite conversion rate. Under about 20% usually means the landing page the invite points at does not explain what the sender was excited about.',
            width: 'third',
            query: bigNumber({ event: inviteAccepted ?? pageView, math: 'total' }, '-7d'),
            requires: [inviteAccepted],
          }),
          tile({
            key: 'loop-over-time',
            name: 'The loop over time',
            description: 'Shares, invites sent, invites accepted and signups on one axis.',
            interpretation:
              'You are looking for the accepted line to move a few days after the sent line, and signups to move with it. If sent rises and accepted does not follow, the loop is broken at the landing step, which is the cheapest place to fix it.',
            width: 'full',
            query: trends({
              series: [
                ...(share ? [{ event: share, name: 'Shares' }] : []),
                ...(inviteSent ? [{ event: inviteSent, name: 'Invites sent' }] : []),
                ...(inviteAccepted ? [{ event: inviteAccepted, name: 'Invites accepted' }] : []),
                ...(signup ? [{ event: signup, name: 'Signups' }] : []),
              ],
              dateFrom: '-90d',
              interval: 'day',
            }),
            requires: [share ?? inviteSent],
          }),
          tile({
            key: 'invite-funnel',
            name: 'Invite → signup funnel',
            description: 'From an invite being sent to a new account existing.',
            interpretation:
              'The k-factor made concrete. If 100 invites produce fewer than about 20 accounts, work on the invite landing page before you work on getting more invites sent.',
            width: 'half',
            query: funnel({
              series: [inviteSent, inviteAccepted, signup]
                .filter((event): event is string => Boolean(event))
                .map((event) => ({ event })),
              dateFrom: '-60d',
              windowInterval: 14,
            }),
            requires: [inviteSent, signup],
          }),
          tile({
            key: 'social-graph',
            name: 'Connections made',
            description: 'Follows, friendships or connections created over time.',
            interpretation:
              'In a social product the number of connections a person makes in their first week is usually the strongest retention predictor available. If you only instrument one thing more, make it this, bucketed by first-week count.',
            width: 'half',
            query: trends({
              series: [{ event: follow ?? pageView, name: 'Connections', math: 'total' }],
              dateFrom: '-90d',
              interval: 'week',
            }),
            requires: [follow],
          }),
        ],
      }),
      dashboard({
        key: 'consumer-habit',
        name: 'Consumer - habit & depth',
        description:
          'Whether using this is becoming a habit: how often people come back on their own, how deep a session goes, and whether notifications are helping or just annoying.',
        question: 'Is this becoming a habit, or a thing people tried once?',
        tiles: [
          tile({
            key: 'stickiness',
            name: 'Days active per month',
            description: 'How many distinct days people were active in a 30-day window.',
            interpretation:
              'The bar at "1" is people who never came back. Everything to the right of about 5 days is your real user base. Track the ratio between them week to week.',
            width: 'half',
            query: stickiness({ series: [{ event: core ?? pageView }], dateFrom: '-30d' }),
            requires: [core ?? pageView],
          }),
          tile({
            key: 'retention',
            name: 'Day-by-day retention',
            description: 'Daily retention for the first two weeks after someone first appears.',
            interpretation:
              'Consumer products live or die on day 1 and day 7. Day 1 under about 25% means the first session does not deliver anything worth returning for - that is a first-run problem, not a notification problem.',
            width: 'half',
            query: retention({
              targetEvent: pageView,
              returningEvent: core ?? pageView,
              period: 'Day',
              totalIntervals: 14,
            }),
            requires: [pageView],
          }),
          tile({
            key: 'notifications',
            name: 'Notification opens',
            description: 'How often a push or email actually brought someone back.',
            interpretation:
              'Judge against sends, not in isolation. If opens are flat while sends rise, you are training people to ignore you, and the cost of that shows up as permanently lower reach.',
            width: 'half',
            query: trends({
              series: [{ event: notification ?? pageView, math: 'total' }, { event: notification ?? pageView, math: 'dau' }],
              dateFrom: '-60d',
            }),
            requires: [notification],
          }),
          tile({
            key: 'saves',
            name: 'Saves per person',
            description: 'How much people are collecting.',
            interpretation:
              'Saving creates a reason to return that is independent of your notifications. A person with five saved things retains far better than one with none - worth building the first-run flow around.',
            width: 'half',
            query: trends({
              series: [{ event: save ?? pageView, math: 'avg_count_per_actor' }],
              dateFrom: '-60d',
              interval: 'week',
            }),
            requires: [save],
          }),
          tile({
            key: 'session-depth',
            name: 'Session depth',
            description: 'Average events and pages per session, by week.',
            interpretation:
              'Falling depth with steady visitors is the earliest sign of content or catalogue fatigue: people arrive, see nothing new, and leave sooner. It shows up here weeks before it shows up in retention.',
            width: 'half',
            query: hogql(sql`
              SELECT
                toStartOfWeek(timestamp) AS week,
                round(count() / nullif(count(DISTINCT $session_id), 0), 1) AS events_per_session,
                count(DISTINCT $session_id) AS sessions
              FROM events
              WHERE timestamp > now() - INTERVAL 90 DAY
                AND $session_id IS NOT NULL
              GROUP BY week
              ORDER BY week
            `),
            requires: [pageView],
          }),
          tile({
            key: 'install',
            name: 'Installs / add to home screen',
            description: 'People who installed the app or added it to their home screen.',
            interpretation:
              'Installed users retain several times better than browser-only ones in almost every consumer product. If this is low, the install prompt is either absent or shown before anyone has a reason to say yes.',
            width: 'half',
            query: trends({ series: [{ event: install ?? pageView, math: 'total' }], dateFrom: '-90d', interval: 'week' }),
            requires: [install],
          }),
        ],
      }),
    ])
  },
}
