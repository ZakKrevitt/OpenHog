/**
 * Turning numbers into things to do.
 *
 * This is the part that does not exist anywhere else. Every analytics tool will
 * show you a retention curve; none of them will tell you that yours is bad for
 * your kind of product, that it is the reason your acquisition spend is not
 * working, and which of the three plausible causes to check first.
 *
 * Three rules the whole file follows:
 *
 *   - **No claim without a sample.** A metric with low confidence never raises
 *     a finding. Telling somebody their retention is bad off twelve people is
 *     worse than saying nothing, because it is wrong *and* it teaches them to
 *     distrust everything else in the report.
 *   - **Every finding names one next action.** Not "consider improving
 *     onboarding". The specific thing to open tomorrow morning.
 *   - **Not measuring something is a finding too.** "You cannot see your
 *     activation rate" is more actionable than most numbers, and it is the gap
 *     that keeps teams guessing for years.
 */

import type { ProductKind } from '../types.js'
import { formatMetric, type MetricSet, type MetricValue } from '../metrics/types.js'
import { activationEvent, metricById } from '../metrics/definitions.js'
import { KIND_LABELS, bandFor, typicalRange } from './benchmarks.js'

export type Severity = 'critical' | 'warning' | 'opportunity' | 'strength'

export interface Evidence {
  label: string
  value: string
  /** The typical range for this product kind, when one exists. */
  typical?: string
}

export interface Finding {
  id: string
  severity: Severity
  /** Ranking within a severity, 0-100. Roughly "how much is this worth fixing". */
  impact: number
  /** The claim, as a sentence someone would say out loud. */
  title: string
  /** The number, formatted, for the big text. */
  headline?: string
  /** What the measurement actually is. */
  what: string
  /** Why it matters, with the comparison that makes it meaningful. */
  why: string
  /** The single next thing to do. */
  action: string
  evidence: Evidence[]
  confidence: 'high' | 'medium' | 'low'
  metricIds: string[]
  /** Set when this finding bears on the goal the user said they were working on. */
  goalRelevant?: boolean
  /**
   * Set on findings about the measurement rather than the product.
   *
   * These sort above everything else of the same severity, and above any goal,
   * because a number produced by broken instrumentation is not a number. Left
   * to impact scores alone this was only accidentally true: a retention finding
   * at 100 outranked a "two events stopped arriving" finding at 99, and the
   * report advised acting on a figure it had just said was unreliable.
   */
  trust?: boolean
}

/** Severity first, then trust, then the stated goal, then impact. */
export function rankFindings(findings: Finding[]): Finding[] {
  const order: Record<Severity, number> = { critical: 0, warning: 1, opportunity: 2, strength: 3 }
  return [...findings].sort(
    (a, b) =>
      order[a.severity] - order[b.severity] ||
      Number(Boolean(b.trust)) - Number(Boolean(a.trust)) ||
      Number(Boolean(b.goalRelevant)) - Number(Boolean(a.goalRelevant)) ||
      b.impact - a.impact,
  )
}

type Rule = (set: MetricSet) => Finding | null

/** Value only if the sample supports a claim. */
function claimable(set: MetricSet, id: string): MetricValue | null {
  const metric = set.values[id]
  if (!metric || metric.value === null) return null
  if (metric.confidence === 'low' || metric.confidence === 'none') return null
  return metric
}

function evidenceFor(set: MetricSet, id: string, label?: string): Evidence | null {
  const metric = set.values[id]
  const definition = metricById(id)
  if (!metric || metric.value === null || !definition) return null
  return {
    label: label ?? definition.name,
    value: formatMetric(metric.value, definition.unit),
    typical: typicalRange(id, set.context.productKind) ?? undefined,
  }
}

function evidence(set: MetricSet, ...ids: string[]): Evidence[] {
  return ids.map((id) => evidenceFor(set, id)).filter((item): item is Evidence => Boolean(item))
}

const confidenceOf = (...metrics: (MetricValue | null)[]): Finding['confidence'] => {
  if (metrics.some((metric) => metric?.confidence === 'medium')) return 'medium'
  return 'high'
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

const retentionRule: Rule = (set) => {
  const metric = claimable(set, 'retention_w1')
  if (!metric || metric.value === null) return null
  const band = bandFor('retention_w1', metric.value, set.context.productKind)
  if (!band || (band.band !== 'poor' && band.band !== 'fair')) return null

  const kind = KIND_LABELS[set.context.productKind]
  const critical = band.band === 'poor'

  return {
    id: 'retention-low',
    severity: critical ? 'critical' : 'warning',
    impact: critical ? 100 : 70,
    title: `Only ${formatMetric(metric.value, 'percent')} of people come back after a week`,
    headline: formatMetric(metric.value, 'percent'),
    what: `Of the ${metric.extra?.cohort ?? metric.sample} people who first appeared 2 to 8 weeks ago, ${metric.extra?.retained ?? 'n/a'} were still active a week later.`,
    why: `That is ${band.comparison}. ${band.benchmark.basis} Retention is the multiplier on everything else you do: at this level, most of what you spend on acquisition is refilling a bucket that empties, and no channel optimisation will change that.`,
    action: critical
      ? 'Stop working on acquisition and go and watch ten session replays of people who never returned. Look for the moment they hesitate on their first visit. Fixing the first session is worth more than any other project available to you right now.'
      : 'Split this by acquisition channel and by first landing page. Retention almost always varies more between segments than the average suggests, and the worst segment usually explains the whole number.',
    evidence: evidence(set, 'retention_w1', 'retention_w4', 'one_visit_share'),
    confidence: confidenceOf(metric),
    metricIds: ['retention_w1'],
  }
}

const leakyBucketRule: Rule = (set) => {
  const week1 = claimable(set, 'retention_w1')
  const week4 = claimable(set, 'retention_w4')
  if (!week1?.value || !week4?.value) return null
  // A curve that flattens is a real product. One that keeps falling is not.
  const survival = week4.value / week1.value
  if (survival > 0.45 || week1.value < 0.05) return null

  return {
    id: 'retention-collapsing',
    severity: 'critical',
    impact: 95,
    title: 'The retention curve is still falling at week 4, not flattening',
    headline: `${formatMetric(week1.value, 'percent')} → ${formatMetric(week4.value, 'percent')}`,
    what: `Week-1 retention is ${formatMetric(week1.value, 'percent')} and week-4 is ${formatMetric(week4.value, 'percent')}, so only ${formatMetric(survival, 'percent')} of the people who survived the first week survived the first month.`,
    why: 'A healthy product has a retention curve that decays and then flattens: there is a core of people for whom it became a habit. A curve that keeps falling at the same rate means no such core is forming, and the product is being consumed rather than adopted.',
    action: 'Find the people who ARE still here at week 4 and work out what they did in their first session that the others did not. That behaviour is your activation definition, and building onboarding around it is the highest-leverage work available.',
    evidence: evidence(set, 'retention_w1', 'retention_w4', 'power_user_share'),
    confidence: confidenceOf(week1, week4),
    metricIds: ['retention_w1', 'retention_w4'],
  }
}

const activationRule: Rule = (set) => {
  const metric = claimable(set, 'activation_rate')
  if (!metric?.value) return null
  const band = bandFor('activation_rate', metric.value, set.context.productKind)
  if (!band || (band.band !== 'poor' && band.band !== 'fair')) return null

  const lost = Number(metric.extra?.signed_up ?? 0) - Number(metric.extra?.activated ?? 0)

  return {
    id: 'activation-low',
    severity: band.band === 'poor' ? 'critical' : 'warning',
    impact: band.band === 'poor' ? 98 : 75,
    title: `${formatMetric(1 - metric.value, 'percent')} of people who sign up never reach the point of value`,
    headline: formatMetric(metric.value, 'percent'),
    what: `${metric.extra?.signed_up ?? metric.sample} people signed up in the last 60 days. ${metric.extra?.activated ?? 0} of them ever did "${activationEvent(set.context.roles)}". ${lost} did not.`,
    why: `These are people who already decided they wanted this. They gave you an email address and then left without ever seeing what the product does. It is almost always the largest single recoverable loss in a funnel, and it is the step teams look at least because it sits between two teams' remits.`,
    action: `Walk through your own signup on a clean browser and count the steps between finishing signup and doing "${activationEvent(set.context.roles)}". Every one of them is optional until proven otherwise. Then watch five replays of people who signed up and stopped.`,
    evidence: evidence(set, 'activation_rate', 'time_to_value', 'signup_conversion'),
    confidence: confidenceOf(metric),
    metricIds: ['activation_rate'],
  }
}

const oneVisitRule: Rule = (set) => {
  const metric = claimable(set, 'one_visit_share')
  if (!metric?.value) return null
  const band = bandFor('one_visit_share', metric.value, set.context.productKind)
  if (!band || band.band === 'good' || band.band === 'excellent') return null
  // Retention findings already cover this ground when both are bad.
  if (claimable(set, 'retention_w1')) {
    const retention = set.values.retention_w1?.value
    if (retention !== null && retention !== undefined && retention < 0.15) return null
  }

  return {
    id: 'one-visit',
    severity: band.band === 'poor' ? 'critical' : 'warning',
    impact: 85,
    title: `${formatMetric(metric.value, 'percent')} of people show up once and never return`,
    headline: formatMetric(metric.value, 'percent'),
    what: `Of ${metric.sample} people who first appeared 2 to 8 weeks ago, that share have exactly one active day in their entire history.`,
    why: `This is first-session failure stated as plainly as it can be. Everyone in that group arrived, formed a judgement, and decided not to come back. Whatever they saw in that one session is the single most important surface in the product.`,
    action: 'Look at what the most common landing page is for this group, and watch replays of five of their sessions end to end. You are looking for the point where the page stops answering the question that brought them.',
    evidence: evidence(set, 'one_visit_share', 'retention_w1', 'power_user_share'),
    confidence: confidenceOf(metric),
    metricIds: ['one_visit_share'],
  }
}

const stickinessRule: Rule = (set) => {
  const metric = claimable(set, 'stickiness')
  if (!metric?.value) return null
  const band = bandFor('stickiness', metric.value, set.context.productKind)
  if (!band || band.band !== 'poor') return null

  return {
    id: 'stickiness-low',
    severity: 'warning',
    impact: 60,
    title: `People come back about ${Math.max(1, Math.round(metric.value * 30))} day${Math.round(metric.value * 30) === 1 ? '' : 's'} a month`,
    headline: metric.value.toFixed(2),
    what: `Average daily actives (${metric.extra?.avg_dau ?? 'n/a'}) divided by monthly actives (${metric.extra?.mau ?? 'n/a'}).`,
    why: `That is ${band.comparison}. ${band.benchmark.basis} It matters most for what it rules out: at this frequency, daily notifications will read as noise and any feature that assumes a daily habit will not get used.`,
    action: 'Decide deliberately whether this is a weekly product or a daily one, then make the notification cadence, the digest frequency and the home screen match that. Most products at this level are trying to behave like daily products and annoying people.',
    evidence: evidence(set, 'stickiness', 'power_user_share', 'engagement_depth'),
    confidence: confidenceOf(metric),
    metricIds: ['stickiness'],
  }
}

const errorRule: Rule = (set) => {
  const metric = claimable(set, 'error_exposure')
  if (!metric?.value) return null
  const band = bandFor('error_exposure', metric.value, set.context.productKind)
  if (!band || band.band === 'good' || band.band === 'excellent') return null

  return {
    id: 'errors-widespread',
    severity: band.band === 'poor' ? 'critical' : 'warning',
    impact: band.band === 'poor' ? 90 : 65,
    title: `${formatMetric(metric.value, 'percent')} of active people saw an error`,
    headline: formatMetric(metric.value, 'percent'),
    what: `${metric.extra?.affected ?? 'n/a'} of ${metric.sample} active people triggered "${set.context.roles.error}" in the last 30 days, across ${metric.extra?.error_events ?? 'n/a'} events.`,
    why: 'People affected matters far more than error count. One broken loop firing a thousand times for one user is a bug report; the same count spread across hundreds of people is an incident that is quietly costing you retention, because someone who hits an error in their first session rarely comes back to give you a second chance.',
    action: 'Break the error event down by route and by browser, sorted by people rather than by count. Then open a session replay for the worst route. Ten minutes of replay usually beats an hour of log reading.',
    evidence: evidence(set, 'error_exposure', 'retention_w1'),
    confidence: confidenceOf(metric),
    metricIds: ['error_exposure'],
  }
}

const timeToValueRule: Rule = (set) => {
  const metric = claimable(set, 'time_to_value')
  if (metric?.value === null || metric?.value === undefined) return null
  const band = bandFor('time_to_value', metric.value, set.context.productKind)
  if (!band || band.band === 'good' || band.band === 'excellent') return null

  return {
    id: 'slow-time-to-value',
    severity: 'warning',
    impact: 72,
    title: `It takes a typical person ${formatMetric(metric.value, 'days')} to get anything out of this`,
    headline: formatMetric(metric.value, 'days'),
    what: `Median time from someone first appearing to them doing "${activationEvent(set.context.roles)}". The slowest 10% take ${metric.extra?.p90_days ?? 'n/a'} days.`,
    why: `${band.benchmark.basis} Every hour between arriving and getting value is an hour in which something else can interrupt, and the people who get interrupted mostly do not come back to finish.`,
    action: 'List everything that has to happen between arrival and that first moment of value, then remove or defer every step that is not strictly required. Ask specifically whether signup itself can happen after the first value rather than before it.',
    evidence: evidence(set, 'time_to_value', 'activation_rate'),
    confidence: confidenceOf(metric),
    metricIds: ['time_to_value'],
  }
}

const concentrationRule: Rule = (set) => {
  const metric = claimable(set, 'channel_concentration')
  if (!metric?.value) return null
  const band = bandFor('channel_concentration', metric.value, set.context.productKind)
  if (!band || band.band === 'good' || band.band === 'excellent') return null

  return {
    id: 'channel-concentration',
    severity: 'warning',
    impact: 55,
    title: `${formatMetric(metric.value, 'percent')} of your people come from one source`,
    headline: formatMetric(metric.value, 'percent'),
    what: `"${metric.extra?.top_source ?? 'unknown'}" accounts for ${metric.extra?.top_source_people ?? 'n/a'} of ${metric.sample} people in the last 30 days.`,
    why: 'Concentration reads as efficiency right up until it does not. One algorithm change, one policy update or one competitor outbidding you, and the number that matters halves in a week with nothing you can do about it in the short term.',
    action: 'Pick one channel that is currently under 5% and give it a month of deliberate effort. The goal is not to replace the top channel, it is to know whether a second one can work before you need it to.',
    evidence: evidence(set, 'channel_concentration'),
    confidence: confidenceOf(metric),
    metricIds: ['channel_concentration'],
  }
}

const growthRule: Rule = (set) => {
  const metric = claimable(set, 'growth_rate')
  if (metric?.value === null || metric?.value === undefined) return null
  if (metric.value > -0.15) return null

  return {
    id: 'growth-declining',
    severity: 'warning',
    impact: 68,
    title: `New people are down ${formatMetric(Math.abs(metric.value), 'percent')} week on week`,
    headline: formatMetric(metric.value, 'percent'),
    what: `${metric.extra?.current ?? 'n/a'} new people this week against ${metric.extra?.previous ?? 'n/a'} last week.`,
    why: 'One week is noisy and this may be nothing. It is worth two minutes of checking because acquisition declines are usually visible here weeks before they show up in any number anybody reports.',
    action: 'Break new people down by channel for both weeks and see whether the drop is one source or all of them. One source is a channel problem. All of them is usually a tracking problem, so check the instrumentation findings below first.',
    evidence: evidence(set, 'growth_rate', 'new_people', 'channel_concentration'),
    confidence: confidenceOf(metric),
    metricIds: ['growth_rate'],
  }
}

// ---------------------------------------------------------------------------
// Can you trust any of the above?
// ---------------------------------------------------------------------------

const silentEventsRule: Rule = (set) => {
  const metric = set.values.silent_events
  if (!metric || !metric.value) return null

  return {
    id: 'silent-events',
    trust: true,
    severity: 'critical',
    impact: 99,
    title: `${metric.value} event${metric.value === 1 ? ' has' : 's have'} stopped arriving`,
    headline: String(metric.value),
    what: `PostHog saw ${metric.value === 1 ? 'this event' : 'these events'} regularly between 8 and 30 days ago and has not seen ${metric.value === 1 ? 'it' : 'them'} at all in the last 7 days: ${metric.extra?.names ?? ''}.`,
    why: 'Instrumentation rots silently. A refactor drops a call site, a rename ships to one surface only, or a consent banner starts blocking the SDK, and every chart built on that event keeps drawing a confident flat line. Any number in this report that depends on one of these is currently wrong.',
    action: 'Search the codebase for each name. If the call site is gone, that was a refactor accident. If it is still there, the code path is unreachable or the SDK is being blocked for those users. Fix this before acting on anything else in this report.',
    evidence: [{ label: 'Events gone quiet', value: String(metric.extra?.names ?? metric.value) }],
    confidence: 'high',
    metricIds: ['silent_events'],
  }
}

const pageviewIntegrityRule: Rule = (set) => {
  const metric = set.values.pageview_integrity
  if (!metric || metric.value === null) return null
  if (metric.confidence === 'low' || metric.value >= 0.75) return null

  return {
    id: 'pageview-integrity',
    trust: true,
    severity: 'critical',
    impact: 97,
    title: 'The SDK is missing the first page load of every session',
    headline: metric.value.toFixed(2),
    what: `${metric.extra?.views ?? 'n/a'} pageviews against ${metric.extra?.leaves ?? 'n/a'} page-leaves in 14 days. These should track each other closely; a ratio well under 1 means leaves are being recorded without a matching view.`,
    why: 'This is the classic `capture_pageview: "history_change"` trap. That mode captures on history changes only, so a full page load - every direct visit and every reload - sends a page-leave with no matching pageview. Every traffic number you have is understated, and PostHog Web Analytics will read close to zero while custom events flow normally.',
    action: 'Set `capture_pageview: false` and send `$pageview` yourself on mount and on every route change, guarded so a re-render cannot double count. `npx openhog doctor` checks this and three related traps against your codebase.',
    evidence: [
      { label: 'Pageviews', value: String(metric.extra?.views ?? 'n/a') },
      { label: 'Page-leaves', value: String(metric.extra?.leaves ?? 'n/a') },
    ],
    confidence: 'high',
    metricIds: ['pageview_integrity'],
  }
}

const cardinalityRule: Rule = (set) => {
  const metric = set.values.high_cardinality_properties
  if (!metric || !metric.value) return null

  return {
    id: 'runaway-properties',
    trust: true,
    severity: 'warning',
    impact: 58,
    title: `${metric.value} propert${metric.value === 1 ? 'y is' : 'ies are'} carrying unbounded values`,
    headline: String(metric.value),
    what: `${metric.value === 1 ? 'This property has' : 'These properties have'} more than 50 distinct values in a single week: ${metric.extra?.worst ?? ''}.`,
    why: 'Almost always a raw id, email address, full URL or free-text search term that should have been bucketed at the call site. It makes every breakdown on that property useless, slows insights down, and costs money that scales with your traffic rather than with your usefulness.',
    action: 'Bucket at the call site rather than filtering later: send `price_bucket: "under_20"` instead of `price: 19.99`, and `query_length_bucket: "medium"` instead of the raw search text. Raw ids belong in the event, never in a breakdown property.',
    evidence: [{ label: 'Worst offenders', value: String(metric.extra?.worst ?? 'n/a') }],
    confidence: 'high',
    metricIds: ['high_cardinality_properties'],
  }
}

// ---------------------------------------------------------------------------
// What you cannot see
// ---------------------------------------------------------------------------

interface BlindSpot {
  role: string
  question: string
  why: string
  suggestion: string
  impact: number
}

const BLIND_SPOTS: BlindSpot[] = [
  {
    role: 'activation',
    question: 'what share of new people ever reach the point of value',
    why: 'Activation is normally the largest recoverable loss in a funnel and the strongest predictor of whether someone retains. Without it you can see that people leave but not where, so every fix is a guess.',
    suggestion:
      'Pick the single action that best predicts someone coming back - the first document created, the first search that led somewhere, the first message sent - and fire one event when it happens.',
    impact: 92,
  },
  {
    role: 'signup_completed',
    question: 'how many visitors become users',
    why: 'Without a signup event, visitors and users are the same population as far as your analytics is concerned, so every conversion number is diluted by people who were never going to convert.',
    suggestion:
      'Fire one event server-side when the account record is actually created, not on button click. Client-side signup events undercount by however many people close the tab mid-request.',
    impact: 88,
  },
  {
    role: 'error',
    question: 'how many people are hitting errors',
    why: 'Logged exceptions are not the same as errors people saw. Plenty of caught errors produce a broken experience with nothing in the logs, and someone who hits one in their first session usually does not come back.',
    suggestion:
      'Fire an event from your error boundary and from every user-facing error toast, with a short stable `error_type` code. Never send the raw message: it is unbounded and often contains personal data.',
    impact: 70,
  },
  {
    role: 'share',
    question: 'whether the product spreads itself',
    why: 'Without share or invite events there is no way to tell organic growth from paid, or to know whether a referral programme is doing anything at all.',
    suggestion: 'Fire an event on the share action itself, not on the menu opening, with a `channel` property from a small fixed set.',
    impact: 55,
  },
  {
    role: 'purchase',
    question: 'which behaviour actually leads to revenue',
    why: 'Without a purchase event, revenue lives in your billing system and behaviour lives here, and nobody can join the two. Every question of the form "do people who do X pay more" is unanswerable.',
    suggestion:
      'Fire it from your payment provider webhook, never from the browser, with a bucketed plan name and the revenue amount.',
    impact: 80,
  },
]

function blindSpotRules(set: MetricSet): Finding[] {
  const relevant = BLIND_SPOTS.filter((spot) => {
    // Activation is only a blind spot when there is no core action to stand in
    // for it. Reporting it as missing while also reporting an activation rate
    // computed from a proxy would contradict itself.
    if (spot.role === 'activation') return !activationEvent(set.context.roles)
    return !set.context.roles[spot.role]
  })
  // A project measuring almost nothing does not need five separate scoldings.
  const limit = Object.keys(set.context.roles).length <= 2 ? 2 : 3

  return relevant.slice(0, limit).map((spot) => ({
    id: `blind-spot-${spot.role}`,
    severity: 'opportunity' as const,
    impact: spot.impact,
    title: `You cannot currently see ${spot.question}`,
    what: `Nothing in this project looks like a "${spot.role.replace(/_/g, ' ')}" event, so every metric that depends on one is missing from this report.`,
    why: spot.why,
    action: spot.suggestion,
    evidence: [],
    confidence: 'high' as const,
    metricIds: [],
  }))
}

// ---------------------------------------------------------------------------
// Things that are going well
// ---------------------------------------------------------------------------

function strengthRules(set: MetricSet): Finding[] {
  const strengths: Finding[] = []
  const candidates: [string, string, string][] = [
    ['retention_w1', 'People come back', 'Retention is the multiplier on everything else, and yours is working. This is the strongest position to be spending on acquisition from.'],
    ['activation_rate', 'New people reach value', 'Most people who sign up get to the thing the product is for. Your onboarding is doing its job.'],
    ['power_user_share', 'You have a real core', 'A meaningful group uses this regularly rather than once. These are the people to interview before building anything new.'],
    ['stickiness', 'It has become a habit', 'People return often enough that this is part of a routine rather than an occasional errand.'],
  ]

  for (const [id, title, why] of candidates) {
    const metric = claimable(set, id)
    if (!metric?.value) continue
    const band = bandFor(id, metric.value, set.context.productKind)
    if (!band || (band.band !== 'good' && band.band !== 'excellent')) continue
    const definition = metricById(id)
    if (!definition) continue

    strengths.push({
      id: `strength-${id}`,
      severity: 'strength',
      impact: band.band === 'excellent' ? 40 : 30,
      title,
      headline: formatMetric(metric.value, definition.unit),
      what: `${definition.name} is ${formatMetric(metric.value, definition.unit)}, which is ${band.comparison}.`,
      why,
      action: 'Protect it. Add this to whatever you check after every release, because a regression here costs more than any feature you could ship is worth.',
      evidence: evidence(set, id),
      confidence: confidenceOf(metric),
      metricIds: [id],
    })
  }

  return strengths.slice(0, 3)
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

const RULES: Rule[] = [
  silentEventsRule,
  pageviewIntegrityRule,
  activationRule,
  leakyBucketRule,
  retentionRule,
  oneVisitRule,
  errorRule,
  timeToValueRule,
  stickinessRule,
  growthRule,
  concentrationRule,
  cardinalityRule,
]

const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  warning: 1,
  opportunity: 2,
  strength: 3,
}

export function deriveFindings(set: MetricSet): Finding[] {
  const findings: Finding[] = []

  for (const rule of RULES) {
    try {
      const finding = rule(set)
      if (finding) findings.push(finding)
    } catch {
      // A broken rule must never take the report down with it.
    }
  }

  findings.push(...blindSpotRules(set))
  findings.push(...strengthRules(set))

  return rankFindings(findings)
}

/**
 * A single number for the top of the report.
 *
 * Composite scores are usually junk, so this one is deliberately simple and
 * fully explained wherever it is shown: it starts at 100 and subtracts for each
 * finding, weighted by severity. It is a summary of the findings below it, not
 * an independent measurement, and it is only shown when enough metrics resolved
 * for it to mean anything.
 */
export function healthScore(findings: Finding[], set: MetricSet): { score: number; basis: string } | null {
  const computed = Object.values(set.values).filter((metric) => metric.value !== null).length
  if (computed < 5) return null

  const base: Record<Severity, number> = { critical: 18, warning: 8, opportunity: 4, strength: 0 }

  // Findings are correlated: low retention, a collapsing curve and a high
  // one-visit share are usually three views of one problem. Deducting the full
  // weight for each drives every troubled project to the same floor, which
  // makes the number useless for telling them apart. Each additional finding of
  // the same severity therefore counts for less than the one before it.
  const deductionFor = (severity: Severity): number => {
    const matching = findings.filter((finding) => finding.severity === severity).length
    let total = 0
    for (let index = 0; index < matching; index += 1) {
      total += base[severity] * 0.65 ** index
    }
    return total
  }

  const criticals = findings.filter((finding) => finding.severity === 'critical').length
  const warnings = findings.filter((finding) => finding.severity === 'warning').length
  const strengths = findings.filter((finding) => finding.severity === 'strength').length

  const deductions = deductionFor('critical') + deductionFor('warning') + deductionFor('opportunity')
  const score = Math.round(Math.max(5, Math.min(100, 100 - deductions + strengths * 4)))

  return {
    score,
    basis: `Starts at 100 and subtracts for each finding below - ${criticals} critical, ${warnings} worth fixing - with each additional finding of the same kind counting for less than the last, because these problems overlap. It summarises the findings rather than measuring anything on its own.`,
  }
}

export function summarise(findings: Finding[]): string {
  const critical = findings.filter((finding) => finding.severity === 'critical')
  if (critical.length) {
    return critical[0]!.title
  }
  const warning = findings.filter((finding) => finding.severity === 'warning')
  if (warning.length) return warning[0]!.title
  const opportunity = findings.filter((finding) => finding.severity === 'opportunity')
  if (opportunity.length) return opportunity[0]!.title
  return 'Nothing alarming turned up in the numbers that could be computed.'
}

export type { ProductKind }
