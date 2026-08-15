<div align="center">

# 🦔 OpenHog

**Point it at your repo. Get PostHog dashboards that are actually about your product.**

```bash
npx openhog init
```

*Reads your code · writes a tracking plan · hardens your instrumentation · builds the dashboards · explains what every chart means*

[![npm](https://img.shields.io/npm/v/openhog?color=%23f54e00)](https://www.npmjs.com/package/openhog)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](./package.json)

</div>

---

## The problem

You install PostHog. You get an empty project and a blank dashboard canvas.

So you click through the setup wizard, and it makes you a dashboard built on `user_signed_up`, `event_saved` and `account_registered` — none of which your app emits, because your app calls them `signup_complete`, `save_toggle` and `user_created`.

Six empty charts. You conclude the tool is broken, close the tab, and six months later you are still guessing.

**OpenHog reads your codebase first.** Every chart it builds references an event your code actually sends, verified by static analysis and then validated against your project's own query API before it is created.

---

## What one command does

```bash
npx openhog init
```

1. **Reads your product.** README, package description, meta tags, landing-page headlines, routes, dependencies, existing analytics call sites. It works out what you've built and what kind of thing it is.
2. **Walks you through a PostHog key.** Opens the right page, names the exact four scopes, takes the paste without echoing it, proves it works, and stores it outside your repo at `0600`.
3. **Writes a tracking plan** — `openhog/tracking-plan.json`. Every event you already emit, with where it fires. Plus the ones worth adding, each with a suggested location, and *only* for features your code actually has.
4. **Writes a hardened analytics module** (if you want one) with five production traps already closed. See [the traps](#four-failures-that-only-appear-in-production).
5. **Builds the dashboards.** Six core ones plus a pack for your product type. Every tile's query is run against your project before it is created, so a tile that can't work is reported, not shipped.
6. **Writes `ANALYTICS.md`** — what each chart means, what to do when it moves, and what's missing from the picture and why.

---

## Not "an event exists somewhere" — *your* event

Dashboard packs are written against **roles**, not literal names. OpenHog resolves each role against your codebase:

```
signup_completed         → account_created        (yours)
content_opened           → event_detail_opened    (yours)
search                   → search_submit          (yours)
share                    → share_click            (yours)
checkout_started         → ticketing_checkout_started
```

A role that resolves to nothing means every tile needing it is **skipped**, and `ANALYTICS.md` tells you which charts you'd unlock by adding it. A smaller honest dashboard beats a bigger one that's lying.

Got a mapping wrong? Fix that one line in the tracking plan and re-run `openhog sync`. Every chart that used it is corrected.

---

## `openhog doctor` — why is nothing arriving?

The command you'll actually share with people.

```bash
npx openhog doctor
```

```
✓ Project key            VITE_PUBLIC_POSTHOG_KEY found in .env.local
✗ Content-Security-Policy
    vercel.json: script-src is missing https://us-assets.i.posthog.com — events
    will flow but session replay can never load its recorder.
    fix: Dev serves no CSP header, so this failure only ever appears in production.
✗ Pageview capture
    capture_pageview is set to 'history_change', which skips the first page load.
    fix: Every direct visit and every reload sends $pageleave with no matching
    $pageview and Web Analytics reads near zero.
! Ad-blocker exposure
    Events go directly to us.i.posthog.com, which most ad blockers block.
    fix: Typically 15-30% of traffic never reports — and it is not a random
    15-30%. Serve PostHog through a reverse proxy on your own domain.
✓ Project timezone       Europe/Berlin
✓ Live round-trip        Test event arrived in 6s. Ingestion works end to end.
```

It sends a real event through the public ingest endpoint and polls until it comes back out of the query API — the check that tells "my code is wrong" apart from "my key is wrong."

---

## Four failures that only appear in production

Every one of these has shipped silently in a real product. Dev serves no CSP, unit tests never fetch a third-party asset, and CI has no ad blocker — so all four are green locally and broken live. The generated module closes all of them; `openhog doctor` checks them.

| | The trap |
|---|---|
| **1** | **CSP directives are separate allowlists.** A host reachable under `connect-src` is *not* thereby loadable as a script. PostHog's asset host serves the replay recorder as a script. Miss it in `script-src` and events flow forever while `$recording_status` sits at `lazy_loading` and you get zero recordings. |
| **2** | **`capture_pageview: 'history_change'` skips the first load.** It captures on history changes only, so a full page load sends `$pageleave` with no matching `$pageview`. Every direct visit and every reload goes uncounted, and Web Analytics reads near zero. |
| **3** | **Sanitising `$current_url` to a bare path breaks Web Analytics.** It parses that field to attribute a visit to a domain, so stripping the origin attributes every visit to nothing. Strip the ids and query string; keep the origin. |
| **4** | **Replay starts on the first navigation, not on landing.** The SDK is imported dynamically, so the first route effect runs before the instance exists. Land-look-leave sessions — the ones most worth watching — are exactly the ones never recorded. |

Full write-up in [docs/TRAPS.md](./docs/TRAPS.md).

---

## The dashboards

Six for everyone, plus a pack for what you've built.

| | Answers |
|---|---|
| **1. North Star** | Are we growing, and do the people we get stick around? |
| **2. Acquisition** | Which channels send people who actually stay? |
| **3. The critical path** | Where exactly do people fall out, and who falls out hardest? |
| **4. Engagement** | What is this product being used for, really? |
| **5. Friction & health** | What is going wrong, for whom, and where? |
| **6. Instrumentation health** | **Can I trust the other five?** |

That last one is the dashboard nobody builds. It watches for planned events that stopped arriving, properties quietly exploding in cardinality, surfaces that went silent, and `$pageview`/`$pageleave` divergence. Analytics rots the way documentation rots, except the chart keeps drawing a plausible line.

Then, by product type:

**SaaS** trial→paid, churn warning list, feature adoption, expansion · **Consumer** viral loops, k-factor, habit formation, session depth · **Marketplace** liquidity, zero-result searches, supply/demand balance · **Ecommerce** cart funnel, abandonment by device, repeat rate · **AI app** generation volume, keep-rate as a quality proxy, cost per user, retention after first generation · **Dev tool** time-to-first-success, docs behaviour, the people who signed up and never got it working · **Content** reading depth, return readers, reader→subscriber

Every tile carries a plain-English "how to read it" that ships into PostHog's own description field *and* into `ANALYTICS.md`:

> **New-person retention** — Read the first column down, not across. If week 1 is under ~20% for a consumer product or ~40% for a tool people pay for, fixing retention beats every other project you could pick.

---

## The rest of the commands

```bash
npx openhog doctor     # why is nothing arriving?
npx openhog check      # has the code drifted from the plan? exits 1. good in a hook
npx openhog sync       # rebuild dashboards after editing the plan
npx openhog demo       # seed realistic synthetic data so the dashboards aren't empty
npx openhog plan       # print the tracking plan as a readable summary
npx openhog mcp        # MCP server: let your AI agent query your analytics
```

### `openhog check` — catch instrumentation drift in review

No network, no API key, sub-second on a large repo:

```bash
npx openhog check --strict
```

```
✗ Events the plan expects that the code no longer emits (1)
    share_click
      The plan says this is emitted, but no call site was found. Previously at
      src/components/Share.tsx:34. Any dashboard tile using it is now drawing a
      flat line.

✗ Dashboard roles that no longer resolve (1)
    share
      No event resolves to the "share" role any more. Every dashboard tile built
      on it will disappear on the next sync.
```

Drop it in `.husky/pre-push` and a refactor can never silently kill a chart again.

### `openhog demo` — dashboards that aren't empty

Synthetic data with the properties real data has and fake data usually doesn't: a funnel that loses people at every step, retention that decays *to a floor* rather than to zero, weekly seasonality, and channels whose conversion rates genuinely differ.

```bash
npx openhog demo --people 800 --days 90
```

Everything is tagged `is_demo_data: true` with `openhog_demo_*` person ids. Use a scratch project.

### `openhog mcp` — your agent can read the analytics it just set up

```jsonc
// .mcp.json
{ "mcpServers": { "openhog": { "command": "npx", "args": ["openhog", "mcp"] } } }
```

Then your agent can ask *"what happened to signups after Tuesday's deploy?"*, run HogQL, check for instrumentation drift after a refactor, and read the tracking plan before adding a new event so it matches your vocabulary instead of inventing a synonym.

There's also a **Claude Code plugin** in [`plugin/`](./plugin) — `/openhog` in your agent, including a browser-assisted walkthrough for getting the API key.

---

## Privacy by default

Analytics tools default to hoovering. This one doesn't.

- **Autocapture is off.** Only events someone deliberately named are sent. A new button can't start reporting itself.
- **URLs are normalised in the browser.** `/list/sh4r3c0d3` leaves as `/list/:shareCode`. Ids and share codes never become property values.
- **`respect_dnt` is on.** Person profiles are created for identified users only.
- **Session replay is off unless you turn it on**, and even then never runs on routes that show someone's own data — settings, billing, inbox, admin — detected from your route table and written into the generated module for you to review.
- **The cardinality audit** catches the raw email or id that slipped into a property three sprints ago.

---

## Ejectable by design

Everything OpenHog writes is plain code and plain JSON that you own:

- `openhog/tracking-plan.json` — diffable, reviewable in a PR, hand-editable
- `src/analytics.ts` — a normal module with no dependency on OpenHog
- `ANALYTICS.md` — normal markdown
- Your dashboards live in *your* PostHog project

Delete OpenHog and nothing stops working. **It never overwrites an analytics module you already wrote** — it says so and leaves it alone.

**Zero runtime dependencies.** `npx openhog` installs in about a second, and you can audit the whole thing in an afternoon. A tool that asks for an API key should be that auditable.

---

## Install

```bash
npx openhog init          # no install needed
npm i -D openhog          # or keep it around for `check` in a hook
```

Node ≥ 20.11. Works with PostHog Cloud US, Cloud EU, and self-hosted (`--host https://posthog.internal`).

**Frameworks:** Next.js (app + pages), React/Vite, Vue, Nuxt, Svelte/SvelteKit, Astro, Remix, Solid, Angular, React Native/Expo, plus Django, FastAPI, Flask, Rails, Express and Swift/Kotlin surfaces for detection.

---

## Contributing

The highest-leverage contribution is a **dashboard pack** for a vertical you know better than we do. It's one file:

```ts
export const fitnessPack: Pack = {
  id: 'fitness',
  appliesTo: ['consumer'],
  build: (plan) => compact([
    dashboard({
      key: 'streaks',
      question: 'Are people building a habit?',
      tiles: [
        tile({
          key: 'workout-streak',
          name: 'Workout streaks',
          description: 'Consecutive days with a completed workout.',
          interpretation: 'The streak length where drop-off spikes is where your reminder should fire.',
          requires: [role(plan, 'core_action')],
          query: trends({ series: [{ event: role(plan, 'core_action')! }] }),
        }),
      ],
    }),
  ]),
}
```

Ask for roles, not event names, and it works on every codebase in that vertical. See [docs/PACKS.md](./docs/PACKS.md).

Also wanted: more framework detectors, more analytics-library call patterns, and doctor checks for failures you've hit.

---

## Prior art & thanks

Built on lessons from instrumenting a real production app, where all four traps above were found the hard way — in production, weeks after shipping, with the charts confidently drawing the wrong number the whole time.

PostHog is a genuinely good product. This is a third-party tool, not affiliated with PostHog Inc.

MIT © [Zak Krevitt](https://github.com/ZakKrevitt)
