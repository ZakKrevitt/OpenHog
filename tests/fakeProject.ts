/**
 * A believable PostHog project, as canned HogQL answers.
 *
 * Modelled on a consumer app with a specific, recognisable problem: plenty of
 * traffic, decent signup conversion, and then a cliff at activation followed by
 * poor retention. That shape is the single most common thing wrong with a real
 * product, and it is what the findings engine most needs to get right.
 */

import type { MockState } from './mockPosthog.js'

export interface FakeProjectOptions {
  /** Make the numbers healthy instead, to exercise the strength findings. */
  healthy?: boolean
  /** Drop these event names, to exercise blind-spot findings. */
  without?: string[]
  /** Break the instrumentation, to exercise the trust findings. */
  brokenInstrumentation?: boolean
}

export function fakeProject(options: FakeProjectOptions = {}): MockState['hogql'] {
  const healthy = options.healthy ?? false
  const missing = new Set(options.without ?? [])

  const allEvents: [string, number, number][] = [
    ['$pageview', 412_000, 18_400],
    ['$pageleave', 398_000, 18_100],
    ['gig_detail_opened', 88_400, 9_200],
    ['search_submit', 41_200, 6_100],
    ['signup_completed', 3_140, 3_140],
    ['save_toggle', 12_800, 2_900],
    ['share_click', 2_240, 1_450],
    ['error_shown', 4_900, 1_960],
    ['list_created', 1_020, 640],
    ['invite_shared', 610, 380],
    ['notification_opened', 2_100, 900],
    ['legacy_onboarding_step', 1_400, 700],
  ]
  const events = allEvents.filter((entry) => !missing.has(entry[0]))

  const activationSample = healthy ? [3140, 2380] : [3140, 690]
  const retentionW1 = healthy ? [2400, 980] : [2400, 214]
  const retentionW4 = healthy ? [1900, 520] : [1900, 41]

  return [
    // Discovery
    {
      match: /GROUP BY event\s+ORDER BY events DESC/,
      rows: events.map(([name, count, people]) => [name, count, people]),
      columns: ['event', 'events', 'people'],
    },
    {
      match: /days_of_data/,
      rows: [[18_400, 968_000, 214]],
      columns: ['people', 'total_events', 'days_of_data'],
    },

    // Size and growth
    { match: /count\(DISTINCT if\(timestamp > now\(\) - INTERVAL 7 DAY/, rows: [[4820, 4610]] },
    {
      match: /countIf\(first_seen > now\(\) - INTERVAL 7 DAY\) AS current/,
      rows: [[healthy ? 890 : 640, 760]],
    },

    // Retention
    { match: /dateDiff\('day', first_seen, last_seen\) >= 7/, rows: [retentionW1] },
    { match: /dateDiff\('day', first_seen, last_seen\) >= 28/, rows: [retentionW4] },
    { match: /avg\(daily\) AS avg_dau/, rows: [[healthy ? 2600 : 780, 14_200]] },
    {
      match: /countIf\(active_days >= 5\) AS power_users/,
      rows: [[14_200, healthy ? 2400 : 520, 9800]],
    },
    { match: /countIf\(active_days = 1\) AS one_day/, rows: [[2400, healthy ? 1180 : 1830]] },

    // Funnel
    {
      match: /count\(DISTINCT if\(event = 'signup_completed', distinct_id, NULL\)\) AS signups/,
      rows: [[18_400, 3140]],
    },
    { match: /countIf\(activated_at > signed_up_at\) AS activated/, rows: [activationSample] },
    { match: /countIf\(paid_at > upstream_at\) AS paid/, rows: [[2380, 96]] },
    { match: /median\(hours_to_value\)/, rows: [[1840, healthy ? 0.4 : 4.2, 19.6]] },

    // Friction
    {
      match: /count\(DISTINCT if\(event = 'error_shown', distinct_id, NULL\)\) AS affected/,
      rows: [[14_200, healthy ? 220 : 1960, 4900]],
    },
    {
      match: /countIf\(event NOT IN \('\$pageview', '\$pageleave', '\$autocapture'\)\) AS actions/,
      rows: [[14_200, 154_000]],
    },

    // Acquisition
    {
      match: /ORDER BY people DESC\s+LIMIT 1/,
      rows: [[healthy ? 'google' : 'instagram', healthy ? 5200 : 12_600, 18_400]],
      columns: ['source', 'people', 'total'],
    },

    // Instrumentation trust
    {
      match: /arrayStringConcat\(groupArray\(event\)/,
      rows: options.brokenInstrumentation ? [[2, 'save_toggle, share_click']] : [[0, '']],
    },
    {
      match: /JSONExtractKeysAndValuesRaw/,
      rows: options.brokenInstrumentation ? [[3, 'search_query, gig_id, user_email']] : [[0, '']],
    },
    {
      match: /countIf\(event = '\$pageview'\) AS views/,
      rows: options.brokenInstrumentation ? [[42_000, 398_000]] : [[412_000, 398_000]],
    },
  ]
}
