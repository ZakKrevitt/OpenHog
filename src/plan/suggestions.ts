/**
 * Events worth adding, given what the repository already does.
 *
 * A suggestion is only made when the repo shows evidence of the underlying
 * feature. Proposing `checkout_started` to a product with no payment code is
 * how tracking plans become 200 lines of aspiration that nobody implements, and
 * the first thing an engineer does with a plan like that is stop reading it.
 *
 * Suggestions are never marked `emitted`, so they can never back a dashboard
 * tile. They exist to be implemented, and `openhog check` counts how many still
 * are not.
 */

import type { PlanEvent, PlanProperty, ProductKind, ScanResult, Stage } from '../types.js'

const surfaceProperty: PlanProperty = {
  name: 'surface',
  type: 'string',
  description: 'Which part of the product this happened in. Keep the value set small and fixed.',
  required: true,
}

const sourceProperty: PlanProperty = {
  name: 'source',
  type: 'string',
  description: 'What triggered it: a button, a deep link, a notification, a keyboard shortcut.',
}

function suggestion(
  name: string,
  stage: Stage,
  description: string,
  properties: PlanProperty[],
  where: string[],
): PlanEvent {
  return {
    name,
    description,
    stage,
    properties: [surfaceProperty, ...properties],
    emitted: false,
    sources: [],
    suggestedLocations: where,
    origin: 'pack',
  }
}

interface SuggestionRule {
  /** Only suggest when this returns true. */
  when: (scan: ScanResult, kind: ProductKind) => boolean
  event: PlanEvent
}

const RULES: SuggestionRule[] = [
  {
    when: (scan) => scan.signals.hasAuth,
    event: suggestion(
      'signup_completed',
      'activation',
      'A new account now exists. The single most important event in any product with accounts.',
      [
        { name: 'method', type: 'enum', values: ['email', 'google', 'apple', 'github', 'sso'], description: 'How they signed up.' },
        { name: 'invited_by_referral', type: 'boolean', description: 'Whether they arrived through an invite. Splits organic from viral growth.' },
      ],
      ['Wherever the account record is created - after the server confirms it, not on button click.'],
    ),
  },
  {
    when: (scan) => scan.signals.hasAuth,
    event: suggestion(
      'signup_started',
      'acquisition',
      'Someone reached the point of creating an account. Without this you cannot tell a traffic problem from a form problem.',
      [{ ...sourceProperty, description: 'What prompted the signup: a CTA, a gated action, a share link.' }],
      ['The signup page or modal mount, and any gated-action prompt.'],
    ),
  },
  {
    when: (scan) => scan.signals.hasOnboarding,
    event: suggestion(
      'onboarding_completed',
      'activation',
      'The first-run flow finished. Pairs with signup_completed to expose the gap where most products lose people.',
      [
        { name: 'steps_completed', type: 'number', description: 'How far they got. Lets you find the step that loses people.' },
        { name: 'skipped', type: 'boolean', description: 'Whether they skipped rather than completed.' },
      ],
      ['The final onboarding step, and the skip control.'],
    ),
  },
  {
    when: (scan) => scan.signals.hasPayments || scan.signals.hasSubscriptions,
    event: suggestion(
      'checkout_started',
      'conversion',
      'Someone entered the paying flow. The denominator for abandonment.',
      [
        { name: 'plan', type: 'string', description: 'Which plan or product. Keep to a fixed set of names, never a raw id.' },
        { name: 'price_bucket', type: 'enum', values: ['free', 'low', 'mid', 'high'], description: 'Bucketed price. Never send the raw amount as a breakdown property.', bucketed: true },
      ],
      ['The checkout page mount, or the call that creates a payment session.'],
    ),
  },
  {
    when: (scan) => scan.signals.hasPayments || scan.signals.hasSubscriptions,
    event: suggestion(
      'purchase_completed',
      'conversion',
      'Money changed hands. Fire it server-side from the payment webhook, never from the browser.',
      [
        { name: 'plan', type: 'string', description: 'Which plan or product.' },
        { name: 'revenue', type: 'number', description: 'Amount, in a single currency. PostHog can total this.' },
        { name: 'currency', type: 'string', description: 'ISO code.' },
        { name: 'is_first_purchase', type: 'boolean', description: 'Separates new customers from repeat ones without a join.' },
      ],
      ['Your payment provider webhook handler. A browser-side purchase event undercounts by however many people close the tab.'],
    ),
  },
  {
    when: (scan) => scan.signals.hasSearch,
    event: suggestion(
      'search_submitted',
      'engagement',
      'Someone looked for something.',
      [
        { name: 'result_count_bucket', type: 'enum', values: ['0', '1-5', '6-20', '21+'], description: 'Bucketed result count. Zero-result searches are your product roadmap.', bucketed: true },
        { name: 'query_length_bucket', type: 'enum', values: ['short', 'medium', 'long'], description: 'Bucketed query length. Never send the raw query: it is high cardinality and frequently personal.', bucketed: true },
      ],
      ['The search submit handler, after results come back so the count is known.'],
    ),
  },
  {
    when: (scan) => scan.signals.hasSearch,
    event: suggestion(
      'search_empty',
      'health',
      'A search returned nothing. The most under-measured drop-off in software.',
      [{ name: 'query_length_bucket', type: 'enum', values: ['short', 'medium', 'long'], description: 'Bucketed length.', bucketed: true }],
      ['The zero-results branch of the search results component.'],
    ),
  },
  {
    when: (scan) => scan.signals.hasSharing,
    event: suggestion(
      'share_clicked',
      'referral',
      'Something was pushed out of the product. The input to every viral loop.',
      [
        { name: 'channel', type: 'enum', values: ['copy_link', 'native', 'email', 'whatsapp', 'x', 'other'], description: 'Where it went.' },
        { name: 'object_type', type: 'string', description: 'What was shared, as a type name - never the id.' },
      ],
      ['Every share control. Fire on the share action, not on the menu opening.'],
    ),
  },
  {
    when: (scan) => scan.signals.hasSharing,
    event: suggestion(
      'invite_accepted',
      'referral',
      'Someone joined because of a share or invite. Without this you can measure invites sent but never the loop.',
      [{ name: 'channel', type: 'string', description: 'Which channel the invite came through.' }],
      ['The invite landing route, once the new account exists.'],
    ),
  },
  {
    when: (scan) => scan.signals.hasLlm,
    event: suggestion(
      'generation_completed',
      'engagement',
      'The model produced something. Your usage metric and your cost driver.',
      [
        { name: 'model', type: 'string', description: 'Which model. Lets you compare quality and cost after a switch.' },
        { name: 'latency_bucket', type: 'enum', values: ['fast', 'ok', 'slow', 'very_slow'], description: 'Bucketed latency.', bucketed: true },
        { name: 'outcome', type: 'enum', values: ['success', 'refused', 'error', 'cancelled'], description: 'How it ended.' },
      ],
      ['Where the model response resolves, including the error and cancellation branches.'],
    ),
  },
  {
    when: (scan) => scan.signals.hasLlm,
    event: suggestion(
      'generation_feedback',
      'engagement',
      'The person judged the output. The closest thing to a quality metric you get for free.',
      [{ name: 'rating', type: 'enum', values: ['up', 'down', 'regenerate', 'copied', 'saved'], description: 'What they did with it. Copying and saving count as approval.' }],
      ['Thumb controls, the regenerate button, and the copy button.'],
    ),
  },
  {
    when: (scan) => scan.signals.hasUploads,
    event: suggestion(
      'upload_completed',
      'activation',
      'The person brought their own data in. In most tools this is the strongest activation signal there is.',
      [
        { name: 'file_type', type: 'string', description: 'Extension or MIME category. Never the filename.' },
        { name: 'size_bucket', type: 'enum', values: ['small', 'medium', 'large'], description: 'Bucketed size.', bucketed: true },
      ],
      ['The upload success handler.'],
    ),
  },
  {
    when: (scan) => scan.signals.hasNotifications,
    event: suggestion(
      'notification_opened',
      'retention',
      'A push or email brought someone back. Without it you cannot tell whether re-engagement works.',
      [{ name: 'notification_type', type: 'string', description: 'Which notification, from a fixed set.' }],
      ['The deep-link handler, reading the campaign from the URL.'],
    ),
  },
  {
    when: () => true,
    event: suggestion(
      'error_shown',
      'health',
      'The person was shown an error. Not the same as a logged exception: this is what they actually saw.',
      [
        { name: 'error_type', type: 'string', description: 'A short stable code. Never the raw message, which is unbounded and can contain personal data.' },
        { name: 'recoverable', type: 'boolean', description: 'Whether they could carry on.' },
      ],
      ['Your error boundary and every user-facing error toast.'],
    ),
  },
  {
    when: (scan) => scan.signals.hasWaitlist,
    event: suggestion(
      'waitlist_joined',
      'acquisition',
      'Someone asked to be told when it is ready.',
      [{ ...sourceProperty }],
      ['The waitlist form submit handler.'],
    ),
  },
  {
    when: (_scan, kind) => kind === 'devtool',
    event: suggestion(
      'first_success',
      'activation',
      'The developer got it working once. For a developer tool this is the only activation metric that matters.',
      [
        { name: 'method', type: 'string', description: 'Which path they took: quickstart, copy-paste, example repo.' },
        { name: 'attempts_bucket', type: 'enum', values: ['1', '2-3', '4+'], description: 'How many tries it took.', bucketed: true },
      ],
      ['The first successful API call, build or run, server-side where possible.'],
    ),
  },
]

export function suggestEvents(scan: ScanResult, kind: ProductKind, alreadyEmitted: Set<string>): PlanEvent[] {
  const suggested: PlanEvent[] = []
  for (const rule of RULES) {
    if (!rule.when(scan, kind)) continue
    // Do not suggest something the repo plainly already does under a different
    // name. The role resolver is the authority on that, but a direct substring
    // hit is cheap and catches the obvious cases.
    const stem = rule.event.name.split('_')[0] ?? rule.event.name
    const covered = [...alreadyEmitted].some((name) => name.includes(stem) && stem.length > 4)
    if (covered) continue
    suggested.push(rule.event)
  }
  return suggested
}
