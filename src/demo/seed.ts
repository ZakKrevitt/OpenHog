/**
 * `openhog demo` — fill a project with realistic synthetic behaviour.
 *
 * An empty dashboard teaches nobody anything. Somebody evaluating whether this
 * is worth adopting needs to see what the charts look like when they work, and
 * a team that has just instrumented their app needs something on the screen
 * before real traffic arrives. So this generates data with the properties real
 * data has and fake data usually does not:
 *
 *   - Funnel shape. Each step loses people, and the loss is correlated with a
 *     hidden per-person quality, so segments differ rather than all converging
 *     on the same average.
 *   - Retention decay with a floor. A pure exponential decays to zero, which
 *     produces a retention chart no real product has ever had.
 *   - Weekly seasonality and a growth trend, so the trend lines look alive.
 *   - Channel quality that varies, so "conversion by source" is not flat.
 *
 * Everything is tagged `is_demo_data: true` and sent as a distinct person id
 * prefix, so it can be found and reasoned about later.
 */

import type { TrackingPlan } from '../types.js'
import type { PostHogClient } from '../posthog/client.js'

/** Deterministic PRNG, so a seeded project is reproducible and testable. */
export function makeRandom(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const SOURCES = [
  { name: 'google', weight: 30, quality: 1.0 },
  { name: '(direct)', weight: 25, quality: 1.3 },
  { name: 'x', weight: 12, quality: 0.7 },
  { name: 'producthunt', weight: 8, quality: 1.6 },
  { name: 'reddit', weight: 8, quality: 0.8 },
  { name: 'newsletter', weight: 7, quality: 2.1 },
  { name: 'hackernews', weight: 6, quality: 1.4 },
  { name: 'linkedin', weight: 4, quality: 0.6 },
]

const DEVICES = [
  { name: 'Desktop', weight: 55, quality: 1.2 },
  { name: 'Mobile', weight: 40, quality: 0.75 },
  { name: 'Tablet', weight: 5, quality: 0.9 },
]

const COUNTRIES = ['US', 'GB', 'DE', 'FR', 'CA', 'AU', 'NL', 'BR', 'IN', 'ES', 'SE', 'JP']
const BROWSERS = ['Chrome', 'Safari', 'Firefox', 'Edge']

function weightedPick<T extends { weight: number }>(items: T[], random: () => number): T {
  const total = items.reduce((sum, item) => sum + item.weight, 0)
  let roll = random() * total
  for (const item of items) {
    roll -= item.weight
    if (roll <= 0) return item
  }
  return items[items.length - 1]!
}

interface DemoEvent {
  event: string
  distinctId: string
  properties: Record<string, unknown>
  timestamp: string
}

export interface SeedOptions {
  plan: TrackingPlan
  /** How many people to simulate. */
  people?: number
  /** How many days of history. */
  days?: number
  seed?: number
  /** Fixed clock, so a seeded run is reproducible end to end. */
  now?: number
}

/**
 * The funnel the simulated people walk, in order, with the share of people who
 * get past each step at baseline quality.
 */
function funnelSteps(plan: TrackingPlan): { event: string; passRate: number }[] {
  const step = (role: string, passRate: number) =>
    plan.roles[role] ? [{ event: plan.roles[role]!, passRate }] : []

  return [
    ...step('signup_started', 0.34),
    ...step('signup_completed', 0.56),
    ...step('onboarding_completed', 0.71),
    ...step('activation', 0.62),
    ...step('core_action', 0.78),
    ...step('checkout_started', 0.19),
    ...step('purchase', 0.44),
  ]
}

/** Events a returning, engaged person does on a normal day. */
function habitualEvents(plan: TrackingPlan): string[] {
  return [
    plan.roles.core_action,
    plan.roles.content_opened,
    plan.roles.search,
    plan.roles.save,
    plan.roles.share,
    plan.roles.message_sent,
    plan.roles.ai_generation,
  ].filter((event): event is string => Boolean(event))
}

export function generateDemoEvents(options: SeedOptions): DemoEvent[] {
  const { plan } = options
  const people = options.people ?? 600
  const days = options.days ?? 60
  const random = makeRandom(options.seed ?? 20260815)

  const events: DemoEvent[] = []
  const steps = funnelSteps(plan)
  const habits = habitualEvents(plan)
  const errorEvent = plan.roles.error
  const pageView = plan.roles.page_view ?? '$pageview'
  const routes = (plan.routes ?? ['/']).slice(0, 12)
  const now = options.now ?? Date.now()
  const DAY = 86_400_000

  for (let person = 0; person < people; person += 1) {
    const distinctId = `openhog_demo_${person.toString(36).padStart(4, '0')}`
    const source = weightedPick(SOURCES, random)
    const device = weightedPick(DEVICES, random)
    const country = COUNTRIES[Math.floor(random() * COUNTRIES.length)]!
    const browser = BROWSERS[Math.floor(random() * BROWSERS.length)]!

    // Arrival is skewed towards recent days, plus a weekly dip, so the trend
    // lines have both growth and seasonality rather than being flat noise.
    const arrivalRoll = random() ** 0.7
    let firstDay = Math.floor(arrivalRoll * days)
    const weekday = (firstDay + 3) % 7
    if ((weekday === 5 || weekday === 6) && random() < 0.45) firstDay = Math.max(0, firstDay - 2)

    const quality = source.quality * device.quality * (0.55 + random() * 0.9)
    const firstSeen = now - (days - firstDay) * DAY

    const base = {
      $device_type: device.name,
      $browser: browser,
      $geoip_country_code: country,
      $initial_utm_source: source.name === '(direct)' ? '' : source.name,
      $initial_referring_domain: source.name === '(direct)' ? '$direct' : `${source.name}.com`,
      $lib: 'openhog-demo',
      is_demo_data: true,
    }

    const sessionTime = (dayOffset: number, minuteOffset: number): string => {
      // Cluster activity into waking hours so the "when people use it" chart is
      // not uniform, which is the tell of fake data.
      const hour = 8 + Math.floor(random() * 13)
      return new Date(
        firstSeen + dayOffset * DAY + hour * 3_600_000 + minuteOffset * 60_000,
      ).toISOString()
    }

    const push = (event: string, dayOffset: number, minuteOffset: number, extra: Record<string, unknown> = {}) => {
      const timestamp = sessionTime(dayOffset, minuteOffset)
      if (new Date(timestamp).getTime() > now) return
      events.push({ event, distinctId, properties: { ...base, ...extra }, timestamp })
    }

    // First session: landing pageview, then the funnel.
    const landing = routes[Math.floor(random() * routes.length)] ?? '/'
    push(pageView, 0, 0, { $pathname: landing, $current_url: `https://example.com${landing}` })

    let reached = 0
    let minute = 1
    for (const step of steps) {
      const chance = Math.min(0.97, step.passRate * quality)
      if (random() > chance) break
      minute += 1 + Math.floor(random() * 6)
      push(step.event, 0, minute, { surface: 'onboarding', source: 'first_session' })
      reached += 1
    }

    // People who never got past the first step or two rarely come back.
    const engaged = reached >= Math.min(2, steps.length)
    const retentionFloor = engaged ? 0.18 + quality * 0.08 : 0.02
    const halfLife = engaged ? 9 + quality * 5 : 2

    for (let day = 1; day <= days - firstDay; day += 1) {
      // Exponential decay towards a floor. A pure exponential reaches zero,
      // which is a retention curve no real product has ever had.
      const returnChance = retentionFloor + (0.62 - retentionFloor) * Math.exp(-day / halfLife)
      if (random() > returnChance) continue

      const route = routes[Math.floor(random() * routes.length)] ?? '/'
      push(pageView, day, 0, { $pathname: route, $current_url: `https://example.com${route}` })

      const actions = 1 + Math.floor(random() * (engaged ? 6 : 2))
      for (let action = 0; action < actions; action += 1) {
        const habit = habits[Math.floor(random() * habits.length)]
        if (!habit) break
        push(habit, day, 2 + action * 2, { surface: 'app', route })
      }

      // Errors are rare, cluster on mobile, and are correlated with leaving.
      if (errorEvent && random() < (device.name === 'Mobile' ? 0.035 : 0.015)) {
        push(errorEvent, day, 5, { error_type: 'request_failed', recoverable: true, route })
      }
    }
  }

  return events.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
}

export interface SeedResult {
  sent: number
  batches: number
}

export async function seedDemoData(
  client: PostHogClient,
  publicKey: string,
  options: SeedOptions & { onProgress?: (sent: number, total: number) => void },
): Promise<SeedResult> {
  const events = generateDemoEvents(options)
  const BATCH = 400
  let sent = 0
  let batches = 0

  for (let index = 0; index < events.length; index += BATCH) {
    const batch = events.slice(index, index + BATCH)
    await client.captureBatch(publicKey, batch)
    sent += batch.length
    batches += 1
    options.onProgress?.(sent, events.length)
    // PostHog's batch endpoint is generous but not unlimited, and a seeding run
    // that gets rate limited half way through leaves a lopsided dataset.
    await new Promise((resolve) => setTimeout(resolve, 120))
  }

  return { sent, batches }
}
