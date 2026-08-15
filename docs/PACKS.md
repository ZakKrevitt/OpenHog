# Writing a dashboard pack

A pack is a set of dashboards for one kind of product. It is **one file**, and it is
the highest-leverage thing you can contribute here: you know your vertical better
than we do, and the metric that matters in it is probably not on any of the general
dashboards.

---

## The one idea

**Packs are written against roles, not event names.**

Your app emits `account_created`. The next person's emits `user_registered`. A pack
written against a literal name is therefore wrong for almost everybody — which is
exactly why hosted setup wizards produce dashboards full of empty tiles.

So you ask for a *role* and OpenHog hands you whatever this codebase calls it:

```ts
const signup = role(plan, 'signup_completed')   // → 'account_created', or null
```

If it returns `null`, every tile that needed it is dropped and the walkthrough tells
the user which chart they'd unlock by adding that event. You don't handle that; the
helpers do.

[The full role list](../src/plan/roles.ts) — 32 of them, each with the vocabulary it
matches.

---

## A complete pack

```ts
// src/packs/fitness.ts
import type { Pack } from '../types.js'
import { funnel, hogql, retention, trends } from '../posthog/queries.js'
import { compact, dashboard, firstRole, role, sql, tile } from './helpers.js'

export const fitnessPack: Pack = {
  id: 'fitness',
  name: 'Fitness',
  description: 'Streaks, programme completion, and the drop-off after week two.',
  appliesTo: ['consumer'],
  events: [],

  build: (plan) => {
    const workout = firstRole(plan, 'core_action', 'activation')
    const signup = role(plan, 'signup_completed')

    return compact([
      dashboard({
        key: 'fitness-habit',
        name: 'Fitness — habit formation',
        description: 'Whether people are building a routine or trying it once.',
        question: 'Do people come back for a second workout?',
        tiles: [
          tile({
            key: 'second-workout',
            name: 'First workout → second workout',
            description: 'How many people who complete one ever complete another.',
            interpretation:
              'The single number that predicts everything else in a fitness product. ' +
              'Under about 40% means the first session is not producing a reason to return — ' +
              'that is a programming problem, not a notifications problem.',
            requires: [workout],
            width: 'half',
            query: funnel({
              series: [{ event: workout! }, { event: workout! }],
              dateFrom: '-60d',
              windowInterval: 14,
            }),
          }),

          tile({
            key: 'streak-lengths',
            name: 'Where streaks break',
            description: 'Distribution of consecutive active days per person.',
            interpretation:
              'The streak length where the histogram falls off a cliff is where your ' +
              'reminder should fire — one day before it, not after.',
            requires: [workout],
            width: 'half',
            query: hogql(sql`
              SELECT
                distinct_id AS person,
                count(DISTINCT toDate(timestamp)) AS active_days
              FROM events
              WHERE event = ${`'${workout}'`}
                AND timestamp > now() - INTERVAL 90 DAY
              GROUP BY person
              ORDER BY active_days DESC
              LIMIT 100
            `),
          }),
        ],
      }),
    ])
  },
}
```

Then one line in [`src/packs/index.ts`](../src/packs/index.ts):

```ts
export const PACKS: Pack[] = [corePack, saasPack, /* … */, fitnessPack]
```

That's the whole contribution.

---

## The helpers

| | |
|---|---|
| `role(plan, 'save')` | the event this repo uses for a role, or `null` |
| `firstRole(plan, 'purchase', 'checkout_started')` | first role that resolves — "purchase, or failing that, checkout" |
| `hasRoles(plan, 'share', 'invite_sent')` | all of them resolve? |
| `tile({...})` | build a tile; returns `null` if any `requires` entry is `null` |
| `dashboard({...})` | assemble surviving tiles; returns `null` below `minTiles` (default 2) |
| `compact([...])` | drop the nulls |
| `sql\`...\`` | de-indent a HogQL template |
| `sqlList(names)` | quote a list for a HogQL `IN` clause |

Query builders in [`src/posthog/queries.ts`](../src/posthog/queries.ts): `trends`,
`funnel`, `retention`, `stickiness`, `lifecycle`, `paths`, `hogql`, `bigNumber`.

---

## What makes a tile good

### 1. `interpretation` is the whole point

`description` says what the number *is*. `interpretation` says **what to do when it
moves**. It ships into PostHog's own tile description and into the user's
`ANALYTICS.md`, and it is the difference between a dashboard people read and a
dashboard people scroll past.

Weak:

> Shows the retention rate over time.

Strong:

> Read the first column down, not across. If week 1 is under ~20% for a consumer
> product or ~40% for a tool people pay for, fixing retention beats every other
> project you could pick. A curve that flattens is a real product; one that hits zero
> by week 4 is a leaky bucket.

Write the sentence you'd say to a founder looking at it over their shoulder. Give a
number if you have one. Name the *next action*, not the observation.

### 2. Declare everything you use in `requires`

```ts
requires: [workout, signup],   // a null here removes the tile. that is correct.
```

A tile that charts an event nothing emits is the failure this whole project exists to
prevent. `requires` is how that's enforced — don't route around it.

### 3. Widths and heights

`third` (4 cols) for single numbers · `half` (6) for most charts · `full` (12) for
tables, path diagrams, and anything with a legend. Height is inferred from the query
type; you don't set it.

### 4. HogQL is validated but not universal

Every tile's query is executed against the user's project before it's created, so a
bad query is reported and skipped rather than shipped. That's a safety net, not a
licence: self-hosted PostHog can lag Cloud on HogQL functions. Prefer a builder where
one exists, and reach for `hogql()` when the question is genuinely a query — "which
properties have runaway cardinality", "who has gone quiet".

Columns available on `events`: `event`, `timestamp`, `distinct_id`, `properties` (a
JSON map — `properties.$pathname`), `$session_id`, `person_id`.

---

## Testing your pack

```ts
it('builds nothing when the required events are missing', () => {
  const plan = planWith()   // pageviews only
  expect(buildDashboards(plan, [fitnessPack])).toHaveLength(0)
})

it('only charts events the plan says are emitted', () => {
  const plan = planWith('workout_completed')
  const required = buildDashboards(plan, [fitnessPack])
    .flatMap((d) => d.tiles.flatMap((t) => t.requires))
  const emitted = new Set(plan.events.filter((e) => e.emitted).map((e) => e.name))
  for (const event of required) expect(emitted.has(event)).toBe(true)
})
```

`npm test` also runs a suite over *every* registered pack asserting each tile has a
real `interpretation` and each dashboard a real `question`, so a thin contribution
fails CI rather than review.

---

## Adding a role

If your vertical's key action has no role, add one to
[`src/plan/roles.ts`](../src/plan/roles.ts):

```ts
workout_completed: {
  weight: 6,
  include: [/^workout_(completed?|finished|logged)$/, /^(session|training)_completed$/],
  weak: [/workout/],
  exclude: [/started|abandoned|cancelled/],
  description: 'A training session was finished.',
},
```

- `include` — precise patterns. Anchored ones (`^…$`) get a bonus.
- `weak` — patterns too loose to beat a precise match, but better than nothing.
  `_click$` belongs here.
- `exclude` — kills the match outright. Always exclude `started` from a `completed`
  role and vice versa.

Add a case to `tests/roles.test.ts` showing three real-world spellings resolving, and
one near-miss that must *not*.

---

## Packs we'd love

Health & fitness · fintech and banking · education and courses · gaming · booking and
reservations · B2B sales tools · community and forums · crypto/web3 · IoT and hardware
· healthcare (with a privacy-first posture) · job boards · real estate · logistics

If you've built in one of these, you know the number that actually matters in it.
That number is probably not on any dashboard above.

---

## Submitting

1. Fork, branch, add `src/packs/<id>.ts`, register it in `src/packs/index.ts`
2. `npm run verify` (typecheck + tests + build)
3. PR with a screenshot of the dashboard against a `openhog demo`-seeded project

Say what you've built in that vertical and why these are the right questions. That
context is worth more than the code.
