/**
 * What are you actually trying to do?
 *
 * Every analytics tool reports the same thirty numbers to everybody. A team
 * three months from running out of money and a team trying to make a working
 * product stickier need completely different things said to them, and neither
 * is served by a ranked list that ignores which one they are.
 *
 * So a goal is asked for once, stored, and then it changes three things:
 *
 *   1. Findings that bear on the goal are ranked above ones that do not. The
 *      same number matters differently depending on what you are trying to move.
 *   2. The goal's own headline metric leads the report, with its trend and its
 *      band, whether or not anything is wrong with it.
 *   3. **Not being able to measure the goal becomes a critical finding.** Saying
 *      "retention is the priority this quarter" and having no way to see it is
 *      the most expensive gap a team can have, and it is invisible to a tool
 *      that never asked.
 *
 * Goals are a fixed set rather than free text because they have to drive logic,
 * not decorate a header. The free-text note rides alongside for the report.
 */

import { rankFindings, type Finding } from './findings.js'

export type Goal =
  | 'acquisition'
  | 'activation'
  | 'retention'
  | 'conversion'
  | 'engagement'
  | 'referral'
  | 'reliability'

export const GOALS: Goal[] = [
  'acquisition',
  'activation',
  'retention',
  'conversion',
  'engagement',
  'referral',
  'reliability',
]

interface GoalDefinition {
  /** How somebody would describe it out loud. */
  label: string
  /** Shown in the picker. */
  hint: string
  /** The single number that says whether the goal is being met. */
  headlineMetric: string
  /** Other metrics that speak to it, in order. */
  supporting: string[]
  /** Finding ids that bear directly on this goal. */
  relevantFindings: string[]
  /**
   * Roles without which the goal cannot be measured at all. If none of these
   * resolve, that is the most important thing to tell this particular team.
   */
  needsRoles: string[]
  /** Why this metric is the one, for the report. */
  because: string
}

export const GOAL_DEFINITIONS: Record<Goal, GoalDefinition> = {
  acquisition: {
    label: 'Get more people in',
    hint: 'growth, channels, top of funnel',
    headlineMetric: 'new_people',
    supporting: ['growth_rate', 'signup_conversion', 'channel_concentration'],
    relevantFindings: ['growth-declining', 'channel-concentration', 'blind-spot-signup_completed'],
    needsRoles: [],
    because: 'New people per week is the only acquisition number that is not a proxy for something else.',
  },
  activation: {
    label: 'Get new people to the point of value',
    hint: 'onboarding, first session, time to value',
    headlineMetric: 'activation_rate',
    supporting: ['time_to_value', 'signup_conversion', 'one_visit_share'],
    relevantFindings: ['activation-low', 'slow-time-to-value', 'one-visit', 'blind-spot-activation'],
    needsRoles: ['activation', 'core_action'],
    because:
      'The share of people who sign up and then reach the thing the product is for is usually the largest recoverable loss in a funnel.',
  },
  retention: {
    label: 'Get people to come back',
    hint: 'habit, stickiness, churn',
    headlineMetric: 'retention_w1',
    supporting: ['retention_w4', 'stickiness', 'power_user_share', 'one_visit_share'],
    relevantFindings: ['retention-low', 'retention-collapsing', 'stickiness-low', 'one-visit'],
    needsRoles: [],
    because:
      'Retention is the multiplier on everything else: without it, acquisition is refilling a bucket that empties.',
  },
  conversion: {
    label: 'Turn usage into revenue',
    hint: 'trials, checkout, paid plans',
    headlineMetric: 'purchase_conversion',
    supporting: ['activation_rate', 'signup_conversion', 'retention_w4'],
    relevantFindings: ['activation-low', 'blind-spot-purchase'],
    needsRoles: ['purchase', 'checkout_started', 'subscription_started'],
    because: 'The share of engaged people who ever pay is the step between a used product and a business.',
  },
  engagement: {
    label: 'Get more out of the people we have',
    hint: 'depth, frequency, feature adoption',
    headlineMetric: 'engagement_depth',
    supporting: ['stickiness', 'power_user_share', 'retention_w1'],
    relevantFindings: ['stickiness-low'],
    needsRoles: ['core_action'],
    because: 'Actions per active person is how you see the product getting more useful to the people who already have it.',
  },
  referral: {
    label: 'Get users to bring users',
    hint: 'sharing, invites, loops',
    headlineMetric: 'new_people',
    supporting: ['growth_rate', 'channel_concentration'],
    relevantFindings: ['channel-concentration', 'blind-spot-share'],
    needsRoles: ['share', 'invite_sent'],
    because: 'Without share and invite events there is no way to tell organic growth from paid.',
  },
  reliability: {
    label: 'Stop breaking things for people',
    hint: 'errors, friction, trust',
    headlineMetric: 'error_exposure',
    supporting: ['retention_w1', 'one_visit_share'],
    relevantFindings: ['errors-widespread', 'blind-spot-error', 'silent-events', 'pageview-integrity'],
    needsRoles: ['error'],
    because:
      'People affected by errors matters more than error count, and someone who hits one in their first session rarely returns.',
  },
}

export interface GoalContext {
  focus: Goal
  /** Free text, e.g. "ship paid tiers before the raise". Shown, never parsed. */
  note?: string
}

/**
 * Re-rank findings so the ones bearing on the stated goal come first.
 *
 * Severity still wins: a broken instrumentation finding outranks a goal-relevant
 * warning, because a goal measured with bad data is not measured at all. Within
 * a severity, relevance to the goal decides.
 */
export function applyGoal(findings: Finding[], goal: GoalContext | null): Finding[] {
  if (!goal) return findings
  const definition = GOAL_DEFINITIONS[goal.focus]
  if (!definition) return findings

  const relevant = new Set(definition.relevantFindings)
  // Only the headline metric, not the supporting ones. `supporting` exists to
  // give the goal context in the report; treating it as relevance made almost
  // every finding relevant to almost every goal - retention findings led the
  // report under the reliability goal, because retention is context for it -
  // which is the same undifferentiated ranking a goal was meant to replace.
  const metrics = new Set([definition.headlineMetric])

  // Marking rather than inflating the score. Adding to `impact` looked simpler
  // but could not actually reorder anything: the findings a goal cares about
  // are usually already at the top of their severity, so the boost hit the
  // ceiling and changed nothing.
  return rankFindings(
    findings.map((finding) => {
      const bearsOnGoal =
        relevant.has(finding.id) || finding.metricIds.some((metric) => metrics.has(metric))
      return bearsOnGoal ? { ...finding, goalRelevant: true } : finding
    }),
  )
}

/**
 * The finding that only exists because somebody said what they were trying to
 * do: they named a goal and the project cannot measure it.
 */
export function goalBlindSpot(
  goal: GoalContext | null,
  roles: Record<string, string>,
  metricAvailable: (id: string) => boolean,
): Finding | null {
  if (!goal) return null
  const definition = GOAL_DEFINITIONS[goal.focus]
  if (!definition) return null

  const hasRole = definition.needsRoles.length === 0 || definition.needsRoles.some((role) => roles[role])
  if (hasRole && metricAvailable(definition.headlineMetric)) return null

  return {
    id: `goal-unmeasurable-${goal.focus}`,
    severity: 'critical',
    impact: 100,
    title: `You said the priority is ${definition.label.toLowerCase()}, and this project cannot measure it`,
    what: `The number that would tell you whether it is working is ${definition.headlineMetric.replace(/_/g, ' ')}, and it could not be computed${definition.needsRoles.length ? ` because nothing here looks like a ${definition.needsRoles.map((role) => role.replace(/_/g, ' ')).join(' or ')} event` : ''}.`,
    why: `${definition.because} Every other number in this report is describing a product you are not currently trying to change. Working on a goal you cannot see the state of means finding out whether it worked at the end of the quarter rather than next week.`,
    action: definition.needsRoles.length
      ? `Add one event for ${definition.needsRoles[0]!.replace(/_/g, ' ')} and fire it at the moment it genuinely happens, server-side if that is where the truth is. That single event turns this whole report into one about the thing you actually care about.`
      : 'Check the role mapping in the report below. The events needed for this exist in most products, so this is usually a naming mismatch rather than missing instrumentation, and `--role` fixes it in one run.',
    evidence: [],
    confidence: 'high',
    metricIds: [definition.headlineMetric],
    goalRelevant: true,
  }
}

export function goalLabel(goal: Goal): string {
  return GOAL_DEFINITIONS[goal]?.label ?? goal
}
