/**
 * Role resolution: the bridge between a dashboard pack and a real codebase.
 *
 * A pack wants to draw a signup funnel. Your app emits `account_created`. The
 * next app emits `user_registered`, and the one after that emits `signup_done`.
 * A pack written against literal event names is therefore wrong for almost
 * everybody, which is why hosted setup wizards produce dashboards full of empty
 * tiles: they guess a name, the guess misses, and nobody goes back to fix it.
 *
 * So packs are written against *roles* — `signup_completed`, `purchase`,
 * `share` — and this module resolves each role to whatever the repository
 * actually emits. A role that resolves to nothing is not a failure; it means
 * every tile that needed it is skipped, and the walkthrough says which event to
 * add to get that tile back.
 */

import type { PlanEvent } from '../types.js'

export type EventRole =
  | 'page_view'
  | 'signup_started'
  | 'signup_completed'
  | 'signin'
  | 'onboarding_started'
  | 'onboarding_completed'
  | 'activation'
  | 'core_action'
  | 'search'
  | 'content_opened'
  | 'save'
  | 'share'
  | 'invite_sent'
  | 'invite_accepted'
  | 'follow'
  | 'message_sent'
  | 'upload'
  | 'checkout_started'
  | 'purchase'
  | 'subscription_started'
  | 'subscription_cancelled'
  | 'pricing_viewed'
  | 'trial_started'
  | 'ai_generation'
  | 'ai_feedback'
  | 'feature_used'
  | 'notification_opened'
  | 'error'
  | 'empty_state'
  | 'install'
  | 'api_key_created'
  | 'first_success'

interface RoleRule {
  /** Higher wins when several roles match one event. */
  weight: number
  include: RegExp[]
  /**
   * Patterns that indicate the role but are too loose to beat a precise match.
   * `_click$` describes half the events in a typical app, so on its own it must
   * never outrank `_detail_opened$` for the `content_opened` role — otherwise a
   * codebase with both gets its dashboards built on the vaguer of the two.
   */
  weak?: RegExp[]
  exclude?: RegExp[]
  description: string
}

/**
 * Patterns are matched against the event name only. They are intentionally
 * generous on vocabulary and strict on shape: `purchase` must not swallow
 * `purchase_failed`, and `signup_completed` must not swallow `signup_started`.
 */
const RULES: Record<EventRole, RoleRule> = {
  page_view: {
    weight: 1,
    include: [/^\$pageview$/, /^page_?viewed?$/, /^screen_?viewed?$/, /^route_?changed?$/],
    description: 'A page or screen was shown.',
  },
  signup_started: {
    weight: 5,
    include: [
      /^(sign_?up|register|registration|create_account|join)_(started|opened|viewed|begin|clicked|prompt)/,
      /^auth_(prompt|modal|dialog)_(view|open|shown)/,
      /^(sign_?up|register)_(page_)?view/,
    ],
    description: 'Someone reached the point of creating an account.',
  },
  signup_completed: {
    weight: 6,
    include: [
      /^(sign_?up|registration|register)_(completed?|success|succeeded|done|finished)$/,
      /^(user|account|member)_(created|registered|signed_up)$/,
      /^(sign_?up|register)$/,
      /_signed_up$/,
    ],
    exclude: [/fail|error|abandon|start|attempt/],
    description: 'An account now exists that did not before.',
  },
  signin: {
    weight: 4,
    include: [/^(sign_?in|log_?in|login)(_(completed?|success|succeeded))?$/, /^session_started$/],
    exclude: [/fail|error|out/],
    description: 'A returning user authenticated.',
  },
  onboarding_started: {
    weight: 5,
    include: [/^(onboarding|getting_started|setup|welcome)_(started|begin|opened|viewed|step_1)/],
    description: 'The first-run flow began.',
  },
  onboarding_completed: {
    weight: 6,
    include: [
      /^(onboarding|getting_started|setup|welcome)_(completed?|finished|done)$/,
      /^onboarding_step_complete$/,
    ],
    exclude: [/skip|abandon/],
    description: 'The first-run flow finished.',
  },
  activation: {
    weight: 7,
    include: [/^activated?$/, /_activated$/, /^first_(value|success|action|use)/, /^aha_moment$/],
    description: 'The user did the thing that predicts they will come back.',
  },
  core_action: {
    weight: 3,
    include: [/^(create|add|new)_/, /_created$/, /^generate/],
    weak: [/^(project|document|note|task|post|list|plan|workspace|board)_/],
    exclude: [/error|fail|deleted|view|impression/],
    description: 'The main thing the product is for.',
  },
  search: {
    weight: 5,
    include: [/^search(_|$)/, /_search(_submit|_submitted|ed)?$/, /^query_(submitted|sent)$/],
    weak: [/search/, /^filter_(apply|applied|submit)/],
    exclude: [/error|fail|empty|result/],
    description: 'The user looked for something.',
  },
  content_opened: {
    weight: 4,
    include: [
      /_(detail|details)_(opened?|viewed?)$/,
      /^(item|event|product|post|article|listing|profile|card)_(opened?|clicked?|viewed?)$/,
    ],
    weak: [/_click(ed)?$/, /_opened$/],
    exclude: [/impression|error|nav/],
    description: 'The user opened a specific thing.',
  },
  save: {
    weight: 5,
    include: [
      /^(save|bookmark|favorite|favourite|wishlist)_(click|clicked|toggle|toggled|added|completed)$/,
      /_(saved|bookmarked|favorited|liked)$/,
    ],
    weak: [/^(save|bookmark|favorite|favourite|like|wishlist)/],
    // `saved_open` is opening the saved list, which is a browsing action, not
    // the act of saving. Counting it as `save` inverts what the retention tiles
    // claim to measure.
    exclude: [/error|fail|un(save|like)/, /^saved?_(open|opened|view|viewed|list|page|tab)/],
    description: 'The user kept something for later. A strong retention predictor.',
  },
  share: {
    weight: 6,
    include: [/^share/, /_shared?$/, /_share_(click|clicked|completed)$/],
    exclude: [/error|fail/],
    description: 'The user pushed something out of the product.',
  },
  invite_sent: {
    weight: 6,
    include: [/^invite(_|s_)?(sent|shared|created|clicked)/, /^refer(ral)?_(sent|shared|link)/, /_invite_shared$/],
    description: 'The user asked someone else to join.',
  },
  invite_accepted: {
    weight: 6,
    include: [/^invite(_|s_)?(accepted|redeemed|used)/, /^refer(ral)?_(accepted|redeemed|converted)/],
    description: 'Someone joined because of an invite. The other half of the loop.',
  },
  follow: {
    weight: 5,
    include: [/^(follow|friend|connect)(ed)?(_|$)/, /_follow(ed|_changed)$/, /^social_follow/],
    exclude: [/unfollow/],
    description: 'A social edge was created.',
  },
  message_sent: {
    weight: 5,
    include: [/^(message|chat|dm)_(sent|send|submitted)$/, /_message_send$/, /^chat_prompt_sent$/],
    description: 'The user sent a message.',
  },
  upload: {
    weight: 5,
    include: [/^(upload|import|attach)/, /_(uploaded|imported)$/],
    exclude: [/error|fail/],
    description: 'The user brought their own data in. Very high activation signal.',
  },
  checkout_started: {
    weight: 6,
    include: [
      /^(checkout|payment|purchase|order)_(started|begin|opened|initiated)$/,
      /^cart_(checkout|submitted)$/,
      /_checkout_started$/,
    ],
    description: 'The user entered the paying flow.',
  },
  purchase: {
    weight: 7,
    include: [
      /^(purchase|order|payment|transaction)_(completed?|succeeded|success|placed|confirmed)$/,
      /^(purchase|checkout_completed|order_placed)$/,
      /_purchased$/,
    ],
    exclude: [/fail|error|refund|cancel|start/],
    description: 'Money changed hands.',
  },
  subscription_started: {
    weight: 7,
    include: [/^(subscription|plan|sub)_(started|created|activated|upgraded)$/, /^subscribed$/, /_upgraded$/],
    exclude: [/cancel|fail|down/],
    description: 'A recurring plan began.',
  },
  subscription_cancelled: {
    weight: 6,
    include: [/^(subscription|plan|sub)_(cancell?ed|churned|downgraded|ended)$/, /^churned$/],
    description: 'A recurring plan ended.',
  },
  pricing_viewed: {
    weight: 5,
    include: [/^pricing/, /_pricing_(view|viewed|opened)$/, /^(plans|upgrade)_(viewed|opened)$/, /^paywall/],
    description: 'The user looked at what it costs.',
  },
  trial_started: {
    weight: 6,
    include: [/^trial_(started|began|activated)$/, /^free_trial/],
    description: 'A trial clock started.',
  },
  ai_generation: {
    weight: 6,
    include: [
      /^(generation|completion|prompt|ai|llm|model)_(sent|submitted|completed?|requested|run)$/,
      /^generate/,
      /_generated$/,
      /^chat_(message_send|prompt_sent)$/,
    ],
    exclude: [/error|fail/],
    description: 'The model was asked to do something.',
  },
  ai_feedback: {
    weight: 6,
    include: [/^(feedback|rating|thumbs)_/, /_(thumbs_up|thumbs_down|rated|regenerated?)$/, /^regenerate/],
    description: 'The user judged what the model produced.',
  },
  feature_used: {
    weight: 2,
    include: [/^feature_/],
    weak: [/_used$/, /_enabled$/, /_toggled$/],
    description: 'A named feature was exercised.',
  },
  notification_opened: {
    weight: 5,
    include: [/^(notification|push|email)_(opened?|clicked?|tapped)$/, /_notification_open/],
    description: 'A re-engagement message worked.',
  },
  error: {
    weight: 5,
    include: [/error/, /_failed$/, /^failure/, /_fail$/, /^exception/],
    description: 'Something broke in front of the user.',
  },
  empty_state: {
    weight: 4,
    include: [/empty(_state)?/, /no_results/, /zero_state/, /_not_found$/],
    description: 'The user was shown nothing. The most under-measured drop-off there is.',
  },
  install: {
    weight: 5,
    include: [/^(install|pwa_install|app_install)/, /_installed$/, /^app_download/],
    description: 'The product was installed.',
  },
  api_key_created: {
    weight: 6,
    include: [/^(api_key|token|credential)_(created|generated|issued)$/, /_key_created$/],
    description: 'A developer took the step that precedes their first API call.',
  },
  first_success: {
    weight: 7,
    include: [/^first_(api_call|request|success|run|build|deploy)/, /^hello_world/, /_first_success$/],
    description: 'A developer got the thing working once.',
  },
}

export interface RoleResolution {
  role: EventRole
  event: string | null
  /** Every emitted event that matched, best first. Shown when a guess is wrong. */
  candidates: string[]
  description: string
}

function scoreEvent(name: string, rule: RoleRule): number {
  if (rule.exclude?.some((pattern) => pattern.test(name))) return 0
  let best = 0
  const score = (patterns: RegExp[] | undefined, base: number, anchorBonus: number) => {
    for (const pattern of patterns ?? []) {
      if (!pattern.test(name)) continue
      // An anchored pattern is a much stronger claim than a substring one.
      const anchored = pattern.source.startsWith('^') && pattern.source.endsWith('$')
      best = Math.max(best, base + (anchored ? anchorBonus : 0))
    }
  }
  score(rule.include, rule.weight, 3)
  // A weak match always loses to any strong match on the same role, but still
  // beats nothing at all — a codebase with only `item_click` should get its
  // content charts rather than none.
  score(rule.weak, Math.max(1, rule.weight - 3), 1)
  return best
}

/**
 * Resolve every role against the events the repo actually emits.
 *
 * Only emitted events are eligible. A pack event that was merely *suggested*
 * must not resolve a role, or the resulting dashboard would reference a name
 * nothing sends, which is the exact failure this whole module exists to stop.
 */
export function resolveRoles(events: PlanEvent[]): Record<EventRole, RoleResolution> {
  const emitted = events.filter((event) => event.emitted).map((event) => event.name)
  const result = {} as Record<EventRole, RoleResolution>

  for (const [role, rule] of Object.entries(RULES) as [EventRole, RoleRule][]) {
    const scored = emitted
      .map((name) => ({ name, score: scoreEvent(name, rule) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.name.length - b.name.length)

    result[role] = {
      role,
      event: scored[0]?.name ?? null,
      candidates: scored.map((entry) => entry.name).slice(0, 5),
      description: rule.description,
    }
  }

  // `$pageview` is always available: the analytics module OpenHog generates
  // sends it by hand on every route change, and a project with the SDK
  // installed at all has it.
  if (!result.page_view.event) {
    result.page_view = { ...result.page_view, event: '$pageview', candidates: ['$pageview'] }
  }

  return result
}

/** Flattened form stored in the tracking plan, so the mapping is reviewable. */
export function roleMap(resolutions: Record<EventRole, RoleResolution>): Record<string, string> {
  const map: Record<string, string> = {}
  for (const [role, resolution] of Object.entries(resolutions)) {
    if (resolution.event) map[role] = resolution.event
  }
  return map
}

export const ROLE_DESCRIPTIONS: Record<EventRole, string> = Object.fromEntries(
  (Object.entries(RULES) as [EventRole, RoleRule][]).map(([role, rule]) => [role, rule.description]),
) as Record<EventRole, string>

export const ALL_ROLES = Object.keys(RULES) as EventRole[]
