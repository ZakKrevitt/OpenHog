# Roadmap

What is built, and what would make this spread. Ordered by leverage, not by effort.

---

## Shipped in 0.1

- **Codebase scan** - framework, routes, product description, feature signals, and
  existing analytics call sites across 20+ frameworks
- **Role resolution** - dashboard packs written against semantic roles, resolved to
  whatever this codebase happens to call things
- **Tracking plan** as reviewable, hand-editable JSON that survives regeneration
- **Hardened analytics module** with all four production traps closed
- **8 dashboard packs**, 20+ dashboards, every tile carrying a "how to read it"
- **Query validation** - every tile is executed against the project before it is
  created, so a broken tile is reported rather than shipped
- **`openhog doctor`** - CSP, keys, SDK config, project settings, live round-trip
- **`openhog check`** - drift detection, no network, hook-ready
- **`openhog demo`** - synthetic data with realistic funnel and retention shape
- **`ANALYTICS.md` generation** - the walkthrough, tailored to the dashboards built
- **MCP server** and **Claude Code plugin**
- Zero runtime dependencies

---

## The distribution ideas

### 1. `openhog doctor` as a standalone thing

The doctor is the most shareable artefact here. "Why is my PostHog empty" is asked
constantly, and the answer is nearly always one of six things nobody has written
down together.

- **A web version.** Paste a URL, it loads the page headlessly and checks the CSP,
  the SDK config, whether `$pageview` fires on first load, and whether ingest is
  reachable. No install, no key, shareable link, one screenshot per finding. This is
  the top of the funnel for everything else.
- **A GitHub App** that comments on PRs touching analytics code with what will break.
- Every new check is a twenty-line PR and a tweet.

### 2. The gallery

A page of every dashboard in every pack, rendered from `openhog demo` data. People
share screenshots of dashboards. They do not share screenshots of CLIs.

Pair it with a **live playground**: a public scratch PostHog project, pre-seeded,
where anyone can click through the real dashboards before installing anything.

### 3. Pack contributions as the growth loop

A pack is one file and it is the thing domain experts can contribute without
learning the codebase. Each merged pack brings its author's audience.

To make it happen: a `openhog pack new <id>` scaffolder, a pack gallery with author
credit, and a "packs wanted" issue list. The vertical list in
[docs/PACKS.md](./docs/PACKS.md) is the backlog.

### 4. The README badge

```markdown
[![Instrumented with OpenHog](https://img.shields.io/badge/analytics-OpenHog-f54e00)](https://github.com/ZakKrevitt/OpenHog)
```

Better: a **dynamic badge** driven by `openhog check` - events tracked, roles
resolved, drift status. A badge that shows a real number is a badge people keep.

### 5. Reverse-proxy setup as a first-class command

`openhog proxy` writes the rewrite config for Vercel, Next, Netlify, Cloudflare or
nginx, points the SDK at it, and updates the CSP. Recovering 15–30% of lost traffic
in one command is a headline in its own right, and it closes the CSP trap as a side
effect.

### 6. Weekly digest

`openhog digest` renders last week's numbers as markdown with the interpretations
already attached, ready to paste into Slack or a standup. The dashboards get looked
at once; a digest arrives whether or not anyone remembers.

### 7. Anonymous benchmarks (opt-in, aggregate only)

"Your week-1 retention is 23%. The median consumer product that has run OpenHog is
19%." A data network effect that gets better with adoption and gives people a reason
to come back.

Only if it can be done without collecting anything identifying - bucketed metrics,
no event names, no URLs, explicit opt-in, and the aggregation code public. If that
cannot be guaranteed, it does not ship.

### 8. Migration importers

`openhog import --from mixpanel|amplitude|segment|ga4` reads an existing tracking
plan and maps it onto roles. Switching costs are the main reason people stay on
tools they dislike; removing that is worth more than any feature.

### 9. Framework starter integrations

A `create-next-app` template, an Astro integration, a Vite plugin - analytics
correct from the first commit rather than bolted on at month six.

---

## Product depth

- **`openhog eject`** - inline everything, remove the dependency, prove there is no
  lock-in
- **Server-side plan generation** for Python, Go, Ruby and Swift call sites (the
  scanner sees these files; the emitters do not yet write for them)
- **Cohort and feature-flag awareness** - dashboards split by flag when experiments
  are running
- **Revenue** - LTV, payback and cohort revenue where a payment provider is detected
- **Alerting** - `openhog watch` on the instrumentation-health tiles, so a broken
  event pages someone within a day instead of at the quarterly review
- **Annotations from git** - write a PostHog annotation on every deploy so a chart
  step-change lines up with a commit
- **`openhog fix`** - apply the doctor's fixes as an actual patch, not prose
- **A/B test scaffolding** that stays honest about statistical power

---

## Deliberately not doing

- **Becoming a PostHog competitor.** This makes PostHog easier to use. It does not
  store, query or serve analytics data.
- **A hosted service.** The moment there is a server, there is a reason to distrust
  the tool with an API key. It stays a local CLI.
- **Sending telemetry by default.** A tool that reads your codebase does not get to
  phone home.
- **Feature flags.** Flags need bundled defaults and a fetch failure that degrades to
  known behaviour. That is a different problem and it does not belong in a tool whose
  job is measurement.

---

Have a better idea, or want to take one of these?
[Open an issue](https://github.com/ZakKrevitt/OpenHog/issues).
