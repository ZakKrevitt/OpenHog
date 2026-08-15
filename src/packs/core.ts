/**
 * The core pack. Every product gets these, whatever it is.
 *
 * Six dashboards, in the order a person actually uses them: how are we doing,
 * where did they come from, did they get through, what did they do, what broke,
 * and is the measurement itself trustworthy. That last one is the dashboard
 * nobody builds and everybody needs.
 */

import type { Pack, PackDashboard, TrackingPlan } from '../types.js'
import { bigNumber, funnel, hogql, lifecycle, paths, retention, stickiness, trends } from '../posthog/queries.js'
import { compact, dashboard, firstRole, role, sql, sqlList, tile } from './helpers.js'

function northStar(plan: TrackingPlan): PackDashboard | null {
  const pageView = role(plan, 'page_view') ?? '$pageview'
  const signup = role(plan, 'signup_completed')
  const activation = firstRole(plan, 'activation', 'core_action', 'save', 'upload')
  const engagement = firstRole(plan, 'core_action', 'content_opened', 'search') ?? pageView

  return dashboard({
    key: 'north-star',
    name: '1. North Star - activation & retention',
    description:
      'The daily check. If you only look at one dashboard, this is it. Everything here is about whether people arrive, get value, and come back.',
    question: 'Are we growing, and are the people we get sticking around?',
    tiles: [
      tile({
        key: 'wau',
        name: 'Weekly active people',
        description: 'Unique people who did anything at all in the last 7 days, against the 7 days before.',
        interpretation:
          'The headline number. A flat WAU with rising signups means you have a retention problem, not a growth problem - go to the retention curve below before you spend anything on acquisition.',
        width: 'third',
        query: bigNumber({ event: pageView, math: 'dau', name: 'Active people' }, '-7d'),
        requires: [pageView],
      }),
      tile({
        key: 'new-users',
        name: 'New people this week',
        description: 'People whose first ever event landed in the last 7 days.',
        interpretation:
          'Top of funnel. Compare its shape to the acquisition dashboard: if this moves and no channel moved, you were probably mentioned somewhere. Check referrers.',
        width: 'third',
        query: signup
          ? bigNumber({ event: signup, math: 'total', name: 'Signups' }, '-7d')
          : bigNumber({ event: pageView, math: 'dau', name: 'Visitors' }, '-7d'),
        requires: [signup ?? pageView],
      }),
      tile({
        key: 'activation-count',
        name: 'People who reached value',
        description: `People who did "${activation ?? 'the core action'}" in the last 7 days.`,
        interpretation:
          'The number that actually predicts revenue. If signups rise and this does not, your onboarding is leaking and every acquisition pound is being wasted.',
        width: 'third',
        query: activation
          ? bigNumber({ event: activation, math: 'dau', name: 'Activated' }, '-7d')
          : bigNumber({ event: pageView, math: 'dau' }, '-7d'),
        requires: [activation],
      }),
      tile({
        key: 'active-trend',
        name: 'Active people over time',
        description: 'Daily and weekly unique people, 90 days.',
        interpretation:
          'Look for the gap between the daily and weekly lines. A daily line close to the weekly line means people use you every day; far below means weekly or occasional use. That ratio should inform whether you send daily notifications at all.',
        width: 'full',
        query: trends({
          series: [
            { event: pageView, name: 'Daily active', math: 'dau' },
            { event: pageView, name: 'Weekly active', math: 'weekly_active' },
            { event: pageView, name: 'Monthly active', math: 'monthly_active' },
          ],
          dateFrom: '-90d',
          interval: 'day',
        }),
        requires: [pageView],
      }),
      tile({
        key: 'activation-funnel',
        name: 'Activation funnel',
        description: 'Visit → sign up → first real action, over 14 days.',
        interpretation:
          'The single most actionable chart in this project. The biggest percentage drop is your next piece of work - not the step with the fewest people, the step with the steepest fall.',
        width: 'half',
        query: funnel({
          series: [
            { event: pageView, name: 'Visited' },
            ...(signup ? [{ event: signup, name: 'Signed up' }] : []),
            ...(activation ? [{ event: activation, name: 'Reached value' }] : []),
          ],
          dateFrom: '-30d',
          windowInterval: 14,
        }),
        requires: [pageView, signup ?? activation],
      }),
      tile({
        key: 'retention',
        name: 'New-person retention',
        description: 'Of the people who first appeared in a given week, how many came back in later weeks.',
        interpretation:
          'Read the first column down, not across. If week 1 is under ~20% for a consumer product or ~40% for a tool people pay for, fixing retention beats every other project you could pick. A curve that flattens (rather than falling to zero) is a real product; one that hits zero by week 4 is a leaky bucket.',
        width: 'half',
        query: retention({
          targetEvent: pageView,
          returningEvent: engagement,
          period: 'Week',
          totalIntervals: 8,
          retentionType: 'retention_first_time',
        }),
        requires: [pageView],
      }),
      tile({
        key: 'lifecycle',
        name: 'Lifecycle - new, returning, resurrecting, dormant',
        description: 'Every active person each week, split by whether this is new behaviour or a return.',
        interpretation:
          'Dormant (below the line) is churn made visible. If the dormant bar is consistently bigger than new plus resurrecting, you are shrinking even while signups look healthy.',
        width: 'full',
        query: lifecycle({ event: engagement, interval: 'week', dateFrom: '-90d' }),
        requires: [engagement],
      }),
      tile({
        key: 'stickiness',
        name: 'Stickiness',
        description: 'How many distinct days people were active in a 30-day window.',
        interpretation:
          'A big spike at "1 day" is the tourist bar: people who tried you once. The size of that bar against the rest is your first-session failure rate, in one picture.',
        width: 'half',
        query: stickiness({ series: [{ event: engagement }], dateFrom: '-30d' }),
        requires: [engagement],
      }),
      tile({
        key: 'power-users',
        name: 'Most engaged people',
        description: 'Top people by event count over 30 days, with how many distinct days they showed up.',
        interpretation:
          'Go and talk to the top ten. Their usage pattern is what your onboarding should be teaching, and they are the ones who will tell you what to build next.',
        width: 'half',
        query: hogql(sql`
          SELECT
            distinct_id AS person,
            count() AS actions,
            count(DISTINCT toDate(timestamp)) AS active_days,
            max(timestamp) AS last_seen
          FROM events
          WHERE timestamp > now() - INTERVAL 30 DAY
          GROUP BY person
          ORDER BY active_days DESC, actions DESC
          LIMIT 25
        `),
        requires: [pageView],
      }),
    ],
  })
}

function acquisition(plan: TrackingPlan): PackDashboard | null {
  const pageView = role(plan, 'page_view') ?? '$pageview'
  const conversion = firstRole(plan, 'signup_completed', 'purchase', 'subscription_started', 'activation')

  return dashboard({
    key: 'acquisition',
    name: '2. Acquisition - where people come from',
    description:
      'Every channel, ranked by whether it sends people who do anything. Volume without conversion is a vanity number, so both are always on the same dashboard here.',
    question: 'Which channels send people who actually stay?',
    tiles: [
      tile({
        key: 'visitors-by-source',
        name: 'Visitors by UTM source',
        description: 'New sessions, broken down by the utm_source they arrived with.',
        interpretation:
          '"(none)" is direct and organic traffic combined; it is normally the biggest bar and tells you least. Judge campaigns against each other, never against direct.',
        width: 'half',
        query: trends({
          series: [{ event: pageView, math: 'dau' }],
          dateFrom: '-30d',
          display: 'ActionsBarValue',
          breakdown: '$initial_utm_source',
          breakdownType: 'person',
        }),
        requires: [pageView],
      }),
      tile({
        key: 'visitors-by-referrer',
        name: 'Referring domains',
        description: 'Where the link that brought people here lived.',
        interpretation:
          'This is where you discover the forum thread or newsletter you did not know about. A domain you do not recognise near the top is worth ten minutes of reading.',
        width: 'half',
        query: trends({
          series: [{ event: pageView, math: 'dau' }],
          dateFrom: '-30d',
          display: 'ActionsBarValue',
          breakdown: '$referring_domain',
        }),
        requires: [pageView],
      }),
      tile({
        key: 'conversion-by-source',
        name: 'Channel quality',
        description:
          'Per source: people, how many converted, and the rate. Sorted so the best channel is at the top, not the biggest.',
        interpretation:
          'The table that decides your budget. A source with 40 visitors and 30% conversion beats one with 4,000 at 0.3%. Kill anything at the bottom with real volume - it is costing you money and polluting every other average on this project.',
        width: 'full',
        query: conversion
          ? hogql(sql`
              SELECT
                coalesce(nullIf(properties.$initial_utm_source, ''), properties.$initial_referring_domain, '(direct)') AS source,
                count(DISTINCT distinct_id) AS people,
                count(DISTINCT if(event = ${`'${conversion}'`}, distinct_id, NULL)) AS converted,
                round(100.0 * converted / nullif(people, 0), 1) AS conversion_rate_pct
              FROM events
              WHERE timestamp > now() - INTERVAL 30 DAY
              GROUP BY source
              HAVING people > 5
              ORDER BY people DESC
              LIMIT 40
            `)
          : hogql(sql`
              SELECT
                coalesce(nullIf(properties.$initial_utm_source, ''), properties.$initial_referring_domain, '(direct)') AS source,
                count(DISTINCT distinct_id) AS people,
                count() AS events
              FROM events
              WHERE timestamp > now() - INTERVAL 30 DAY
              GROUP BY source
              ORDER BY people DESC
              LIMIT 40
            `),
        requires: [pageView],
      }),
      tile({
        key: 'conversions-by-campaign',
        name: 'Conversions by campaign',
        description: 'The converting event, split by utm_campaign.',
        interpretation:
          'Compare against the visitors chart above. A campaign that is large here and small there is your best creative; copy it.',
        width: 'half',
        query: trends({
          series: [{ event: conversion ?? pageView, math: 'dau' }],
          dateFrom: '-30d',
          display: 'ActionsBarValue',
          breakdown: '$initial_utm_campaign',
          breakdownType: 'person',
        }),
        requires: [conversion],
      }),
      tile({
        key: 'landing-pages',
        name: 'Landing pages',
        description: 'The first page of each session, ranked.',
        interpretation:
          'Anything high in this list is doing acquisition work whether you meant it to or not. Those pages deserve the same care as your homepage.',
        width: 'half',
        query: trends({
          series: [{ event: pageView, math: 'dau' }],
          dateFrom: '-30d',
          display: 'ActionsBarValue',
          breakdown: '$initial_pathname',
          breakdownType: 'person',
        }),
        requires: [pageView],
      }),
      tile({
        key: 'geography',
        name: 'Where people are',
        description: 'Active people by country.',
        interpretation:
          'Check this against your timezone and your support hours. A product whose second-biggest country never sees a reply for 12 hours has a retention problem it will blame on the product.',
        width: 'half',
        query: trends({
          series: [{ event: pageView, math: 'dau' }],
          dateFrom: '-30d',
          display: 'WorldMap',
          breakdown: '$geoip_country_code',
        }),
        requires: [pageView],
      }),
      tile({
        key: 'device',
        name: 'Desktop vs mobile',
        description: 'Active people by device type.',
        interpretation:
          'If mobile is over half and your funnel conversion on mobile is worse (check the funnel dashboard, breakdown by device), that gap is usually the single cheapest fix available to you.',
        width: 'half',
        query: trends({
          series: [{ event: pageView, math: 'dau' }],
          dateFrom: '-30d',
          display: 'ActionsPie',
          breakdown: '$device_type',
        }),
        requires: [pageView],
      }),
    ],
  })
}

function criticalPath(plan: TrackingPlan): PackDashboard | null {
  const pageView = role(plan, 'page_view') ?? '$pageview'
  const steps = [
    role(plan, 'signup_started'),
    role(plan, 'signup_completed'),
    role(plan, 'onboarding_completed'),
    firstRole(plan, 'activation', 'core_action'),
  ].filter((value): value is string => Boolean(value))

  const conversion = firstRole(plan, 'purchase', 'subscription_started', 'activation', 'core_action')

  return dashboard({
    key: 'critical-path',
    name: '3. The critical path',
    description:
      'The sequence you need people to complete, measured as one funnel and then broken apart by the things that usually explain the drop-off: device, channel, and time taken.',
    question: 'Where exactly do people fall out, and who falls out hardest?',
    tiles: [
      tile({
        key: 'main-funnel',
        name: 'Main funnel',
        description: `${[pageView, ...steps].join(' → ')}, 14-day window.`,
        interpretation:
          'Fix the steepest single drop first, then re-check. Do not optimise a 4% step into a 6% step while a 70% drop sits above it.',
        width: 'full',
        query: funnel({
          series: [pageView, ...steps].map((event) => ({ event })),
          dateFrom: '-30d',
          windowInterval: 14,
        }),
        requires: [pageView, steps[0] ?? null],
      }),
      tile({
        key: 'funnel-by-device',
        name: 'Same funnel, split by device',
        description: 'The critical path, broken down by device type.',
        interpretation:
          'A mobile conversion rate materially below desktop is nearly always layout, not intent. Open the mobile session replays for the step that drops.',
        width: 'half',
        query: funnel({
          series: [pageView, ...steps].map((event) => ({ event })),
          dateFrom: '-30d',
          breakdown: '$device_type',
        }),
        requires: [pageView, steps[0] ?? null],
      }),
      tile({
        key: 'time-to-convert',
        name: 'How long conversion takes',
        description: 'Distribution of time from the first step to the last.',
        interpretation:
          'A long tail means people leave and come back to finish. That is a case for a reminder email. A tight distribution means it is a single-session decision, and reminders will annoy rather than convert.',
        width: 'half',
        query: funnel({
          series: [pageView, ...steps].map((event) => ({ event })),
          dateFrom: '-30d',
          vizType: 'time_to_convert',
        }),
        requires: [pageView, steps[0] ?? null],
      }),
      tile({
        key: 'funnel-by-source',
        name: 'Same funnel, split by channel',
        description: 'The critical path, broken down by where people came from.',
        interpretation:
          'This is how you find the channel that sends traffic which never converts. Compare against the acquisition dashboard before you conclude a channel is bad - small samples swing wildly here.',
        width: 'half',
        query: funnel({
          series: [pageView, ...steps].map((event) => ({ event })),
          dateFrom: '-30d',
          breakdown: '$initial_utm_source',
        }),
        requires: [pageView, steps[0] ?? null],
      }),
      tile({
        key: 'paths-to-conversion',
        name: 'Routes people take before converting',
        description: 'The most common page sequences that end at the converting event.',
        interpretation:
          'If a page shows up here that you did not design as part of the path, it is doing persuasion work. Find out what it says and say it earlier.',
        width: 'half',
        query: paths({ dateFrom: '-14d', endPoint: conversion ?? undefined, stepLimit: 5 }),
        requires: [pageView],
      }),
    ],
  })
}

function engagement(plan: TrackingPlan): PackDashboard | null {
  const pageView = role(plan, 'page_view') ?? '$pageview'
  const core = firstRole(plan, 'core_action', 'content_opened', 'search')
  const search = role(plan, 'search')
  const save = role(plan, 'save')

  return dashboard({
    key: 'engagement',
    name: '4. Engagement - what people actually do',
    description:
      'Everything people do once they are in, ranked by how often. Use it to find the features nobody has discovered and the ones you could delete.',
    question: 'What is this product being used for, really?',
    tiles: [
      tile({
        key: 'top-events',
        name: 'Every event, ranked',
        description: 'All events in the last 7 days with people, count, and actions per person.',
        interpretation:
          'The bottom of this table is your delete list: a feature used by four people is costing you maintenance and menu space. The top is what your onboarding should teach on day one.',
        width: 'full',
        query: hogql(sql`
          SELECT
            event,
            count() AS events,
            count(DISTINCT distinct_id) AS people,
            round(events / nullif(people, 0), 1) AS per_person
          FROM events
          WHERE timestamp > now() - INTERVAL 7 DAY
            AND event NOT IN ('$pageview', '$pageleave', '$autocapture')
          GROUP BY event
          ORDER BY events DESC
          LIMIT 100
        `),
        requires: [pageView],
      }),
      tile({
        key: 'core-action-trend',
        name: 'Core action over time',
        description: `How often "${core ?? 'the main action'}" happens, and how many people do it.`,
        interpretation:
          'The two lines should move together. Volume rising while people stay flat means a small group is doing more, which is fine but is not growth.',
        width: 'half',
        query: trends({
          series: [
            { event: core ?? pageView, name: 'Times', math: 'total' },
            { event: core ?? pageView, name: 'People', math: 'dau' },
          ],
          dateFrom: '-60d',
        }),
        requires: [core],
      }),
      tile({
        key: 'actions-per-person',
        name: 'Actions per active person',
        description: 'Average events per active person per day.',
        interpretation:
          'Depth of use. A number that climbs while active people stay flat is the signature of a product getting more useful to the people who already have it - usually the healthiest thing on this page.',
        width: 'half',
        query: trends({
          series: [{ event: core ?? pageView, math: 'avg_count_per_actor' }],
          dateFrom: '-60d',
        }),
        requires: [core ?? pageView],
      }),
      tile({
        key: 'top-pages',
        name: 'Most-visited pages',
        description: 'Pageviews by route.',
        interpretation:
          'Routes here should be normalised (`/items/:id`, not `/items/8f2c`). If you see raw ids, your instrumentation is leaking high-cardinality URLs - see the instrumentation health dashboard.',
        width: 'half',
        query: trends({
          series: [{ event: pageView, math: 'total' }],
          dateFrom: '-14d',
          display: 'ActionsBarValue',
          breakdown: '$pathname',
          breakdownLimit: 20,
        }),
        requires: [pageView],
      }),
      tile({
        key: 'search-usage',
        name: 'Search',
        description: 'How often people search, and how many distinct people do.',
        interpretation:
          'Heavy search usually means weak navigation. If search volume per person is high, people cannot find things by browsing.',
        width: 'half',
        query: trends({
          series: [
            { event: search ?? pageView, name: 'Searches', math: 'total' },
            { event: search ?? pageView, name: 'People searching', math: 'dau' },
          ],
          dateFrom: '-30d',
        }),
        requires: [search],
      }),
      tile({
        key: 'save-rate',
        name: 'Saves and bookmarks',
        description: 'How often people keep something for later.',
        interpretation:
          'Saving is one of the strongest retention predictors there is: people come back for the thing they saved. If this is low, ask whether saving is discoverable at all.',
        width: 'half',
        query: trends({
          series: [{ event: save ?? pageView, math: 'total' }, { event: save ?? pageView, math: 'dau' }],
          dateFrom: '-30d',
        }),
        requires: [save],
      }),
      tile({
        key: 'hour-of-day',
        name: 'When people use it',
        description: 'Activity by hour of day, project timezone.',
        interpretation:
          'Decides when you deploy, when you send notifications, and when you schedule maintenance. Confirm your project timezone is right first - a UTC project misplaces every evening product by a whole peak.',
        width: 'half',
        query: hogql(sql`
          SELECT
            toHour(timestamp) AS hour_of_day,
            count() AS events,
            count(DISTINCT distinct_id) AS people
          FROM events
          WHERE timestamp > now() - INTERVAL 30 DAY
          GROUP BY hour_of_day
          ORDER BY hour_of_day
        `),
        requires: [pageView],
      }),
    ],
  })
}

function friction(plan: TrackingPlan): PackDashboard | null {
  const pageView = role(plan, 'page_view') ?? '$pageview'
  const errorEvent = role(plan, 'error')
  const empty = role(plan, 'empty_state')

  return dashboard({
    key: 'friction',
    name: '5. Friction & health',
    description:
      'Everywhere the product fails a person: errors they saw, searches that returned nothing, and sessions that ended after one page.',
    question: 'What is going wrong, for whom, and where?',
    tiles: [
      tile({
        key: 'errors-over-time',
        name: 'Errors people saw',
        description: 'Error events over time, with the number of distinct people affected.',
        interpretation:
          'People affected matters more than error count: one broken loop firing 900 times for one user is a bug report, while 900 errors across 400 people is an incident.',
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
        key: 'errors-by-route',
        name: 'Errors by page',
        description: 'Which routes produce the errors.',
        interpretation:
          'Sort by people, not by count, then open a session replay for the worst route. Ten minutes of replay usually beats an hour of log reading.',
        width: 'half',
        query: trends({
          series: [{ event: errorEvent ?? pageView, math: 'dau' }],
          dateFrom: '-30d',
          display: 'ActionsBarValue',
          breakdown: '$pathname',
        }),
        requires: [errorEvent],
      }),
      tile({
        key: 'empty-states',
        name: 'Empty states seen',
        description: 'How often people are shown nothing.',
        interpretation:
          'The most under-measured drop-off in software. Someone who searches and gets zero results usually leaves and never tells you. If this number is meaningful, the fix is a better empty state, not a better search box.',
        width: 'half',
        query: trends({
          series: [{ event: empty ?? pageView, math: 'total' }, { event: empty ?? pageView, math: 'dau' }],
          dateFrom: '-30d',
        }),
        requires: [empty],
      }),
      tile({
        key: 'bounce',
        name: 'One-page sessions',
        description: 'Share of sessions in which exactly one page was viewed, by landing page.',
        interpretation:
          'A high rate on a marketing page can be fine (they read it and left informed). A high rate on an app page is a failure. Judge each route against what it is for.',
        width: 'half',
        query: hogql(sql`
          SELECT
            properties.$pathname AS landing_page,
            count(DISTINCT $session_id) AS sessions,
            count(DISTINCT if(session_pages = 1, $session_id, NULL)) AS one_page_sessions,
            round(100.0 * one_page_sessions / nullif(sessions, 0), 1) AS one_page_pct
          FROM (
            SELECT
              $session_id,
              any(properties.$pathname) AS pathname,
              count() AS session_pages,
              any(properties) AS properties
            FROM events
            WHERE event = '$pageview'
              AND timestamp > now() - INTERVAL 14 DAY
              AND $session_id IS NOT NULL
            GROUP BY $session_id
          )
          GROUP BY landing_page
          HAVING sessions > 10
          ORDER BY sessions DESC
          LIMIT 30
        `),
        requires: [pageView],
      }),
      tile({
        key: 'drop-off-paths',
        name: 'Where sessions end',
        description: 'The page sequences that come immediately before someone leaves.',
        interpretation:
          'The last page in a common path is the page that lost them. If the same route keeps appearing at the end, that is where to spend your next hour.',
        width: 'full',
        query: paths({ dateFrom: '-14d', stepLimit: 4 }),
        requires: [pageView],
      }),
      tile({
        key: 'browser-errors',
        name: 'Errors by browser and OS',
        description: 'Error events broken down by browser.',
        interpretation:
          'A single browser dominating this chart out of proportion to its share of traffic (check the acquisition dashboard) means a compatibility bug, not a product bug.',
        width: 'half',
        query: trends({
          series: [{ event: errorEvent ?? pageView, math: 'total' }],
          dateFrom: '-30d',
          display: 'ActionsBarValue',
          breakdown: '$browser',
        }),
        requires: [errorEvent],
      }),
    ],
  })
}

/**
 * The dashboard nobody builds.
 *
 * Analytics rots silently: a refactor drops a call site, a property starts
 * carrying a raw id, a rename leaves half the events under the old name, and
 * every chart above keeps rendering a plausible-looking line. These tiles watch
 * the measurement itself, so the failure is visible in days rather than at the
 * quarterly review when somebody finally asks why the number looks wrong.
 */
function instrumentationHealth(plan: TrackingPlan): PackDashboard | null {
  const planned = plan.events.filter((event) => event.emitted).map((event) => event.name)
  const pageView = role(plan, 'page_view') ?? '$pageview'

  return dashboard({
    key: 'instrumentation-health',
    name: '6. Instrumentation health',
    description:
      'Is the measurement itself still true? These tiles watch for events that stopped arriving, properties that are quietly exploding in cardinality, and surfaces that went silent.',
    question: 'Can I trust the other five dashboards?',
    minTiles: 1,
    tiles: [
      tile({
        key: 'missing-events',
        name: '⚠ Planned events that have stopped arriving',
        description:
          'Events your code is supposed to emit that PostHog has not seen in 7 days. Generated from your tracking plan.',
        interpretation:
          'Every row here is a broken chart somewhere else. The usual causes, in order: a refactor dropped the call, a rename shipped to only one surface, or a consent banner is blocking the SDK for most users. Empty is the goal.',
        width: 'half',
        query: hogql(sql`
          SELECT planned_event AS event_missing_from_posthog
          FROM (SELECT arrayJoin([${sqlList(planned)}]) AS planned_event)
          WHERE planned_event NOT IN (
            SELECT DISTINCT event FROM events WHERE timestamp > now() - INTERVAL 7 DAY
          )
        `),
        requires: planned.length ? [pageView] : [null],
      }),
      tile({
        key: 'unplanned-events',
        name: 'Events arriving that are not in the plan',
        description: 'Event names PostHog has seen that your tracking plan does not list.',
        interpretation:
          'Either someone added tracking without updating the plan (run `openhog check`), or you have autocapture on and are paying for events nobody named. Both are worth ten minutes.',
        width: 'half',
        query: hogql(sql`
          SELECT
            event,
            count() AS events,
            count(DISTINCT distinct_id) AS people
          FROM events
          WHERE timestamp > now() - INTERVAL 7 DAY
            AND event NOT IN (${sqlList([...planned, '$pageview', '$pageleave', '$identify', '$set'])})
            AND NOT startsWith(event, '$feature')
          GROUP BY event
          ORDER BY events DESC
          LIMIT 50
        `),
        requires: planned.length ? [pageView] : [null],
      }),
      tile({
        key: 'cardinality',
        name: '⚠ Properties with runaway cardinality',
        description:
          'Event properties with more than 50 distinct values in a week. These are usually raw ids or URLs that should have been bucketed.',
        interpretation:
          'This is the tile that stops your PostHog bill running away and your breakdowns turning into 10,000-row lists. Anything here holding an id, an email, a raw URL or a free-text search term should be bucketed or dropped at the call site.',
        width: 'full',
        query: hogql(sql`
          SELECT
            key AS property,
            uniq(value) AS distinct_values,
            count() AS occurrences
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
          LIMIT 40
        `),
        requires: [pageView],
      }),
      tile({
        key: 'volume-by-day',
        name: 'Event volume (billing watch)',
        description: 'Total events per day, all names.',
        interpretation:
          'A step change with no product release behind it is nearly always an instrumentation bug: an event moved inside a render, or a loop started firing. Catch it here before it shows up on an invoice.',
        width: 'half',
        query: trends({ series: [{ event: pageView, math: 'total' }], dateFrom: '-30d', interval: 'day' }),
        requires: [pageView],
      }),
      tile({
        key: 'by-surface',
        name: 'Which surfaces are reporting',
        description: 'Events broken down by the SDK that sent them ($lib).',
        interpretation:
          'If you ship web and mobile, both should appear. A surface that vanishes from this chart has a broken build or an expired key, and it will look like a usage drop on every other dashboard.',
        width: 'half',
        query: trends({
          series: [{ event: pageView, math: 'total' }],
          dateFrom: '-30d',
          display: 'ActionsBarValue',
          breakdown: '$lib',
        }),
        requires: [pageView],
      }),
      tile({
        key: 'pageview-sanity',
        name: 'Pageviews vs page-leaves',
        description:
          'Both events over time. They should track each other closely.',
        interpretation:
          'Far more $pageleave than $pageview means the SDK is missing the first page load of each session - the classic `capture_pageview: "history_change"` trap, which silently drops every direct visit and every reload. If these lines diverge, your traffic numbers are wrong and Web Analytics will read near zero.',
        width: 'full',
        query: trends({
          series: [
            { event: '$pageview', name: 'Pageviews', math: 'total' },
            { event: '$pageleave', name: 'Page leaves', math: 'total' },
          ],
          dateFrom: '-30d',
        }),
        requires: [pageView],
      }),
    ],
  })
}

export const corePack: Pack = {
  id: 'core',
  name: 'Core',
  description:
    'Activation, acquisition, the critical path, engagement, friction, and a dashboard that watches the instrumentation itself. Every product gets these.',
  appliesTo: ['saas', 'consumer', 'marketplace', 'ecommerce', 'ai-app', 'devtool', 'content'],
  events: [],
  build: (plan) =>
    compact([
      northStar(plan),
      acquisition(plan),
      criticalPath(plan),
      engagement(plan),
      friction(plan),
      instrumentationHealth(plan),
    ]),
}
