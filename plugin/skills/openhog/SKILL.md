---
name: openhog
description: Set up, repair or reason about product analytics in this repository. Use when the user asks to add analytics, set up PostHog, work out why events are not arriving, build or fix dashboards, add a tracking event, or answer a question about what real users did ("how many people signed up last week", "did the new onboarding help"). Also use before adding any analytics call, so the new event matches the vocabulary already in the codebase.
---

# OpenHog

Product analytics for this repository: a tracking plan derived from the code, a
hardened PostHog client, dashboards built only on events that actually exist, and
a walkthrough explaining what each chart means.

## Decide what the user is asking for

| They want | Do this |
|---|---|
| Analytics set up from scratch | [Full setup](#full-setup) |
| To know why nothing is arriving | [Diagnose](#diagnose) — run this before reading any code |
| To add one event | [Add an event](#add-an-event) |
| An answer about real usage | [Query](#query-the-data) via the MCP tools |
| Dashboards rebuilt after changes | `npx openhog sync` |
| To know if a refactor broke tracking | `npx openhog check` |

If the repo has no `openhog.config.json`, only the full setup applies.

---

## Full setup

`openhog init` is interactive. Inside an agent there is no TTY, so run it with
`--yes` and supply the key through the environment.

### 1. The API key is the only step you cannot do alone

OpenHog needs a PostHog **personal API key** (`phx_…`). It is minted in PostHog's
UI and must come from the user.

Check whether one already exists before asking:

```bash
npx openhog auth --check
```

If that succeeds, skip to step 2.

If it fails, get the exact walk as structured steps:

```bash
npx openhog auth --instructions --region us   # or --region eu
```

Then, in order of preference:

**a. If you have browser control** (`mcp__claude-in-chrome__*` or the Browser
pane) and the user agrees: navigate to the settings page from those instructions
and walk them through creating the key on screen. Point at the scopes to tick —
`project:read`, `insight:write`, `dashboard:write`, `query:read`.

**Never read, transcribe, screenshot, or store the key value itself.** Navigate
and point; the user copies it. Ask them to paste it into their terminal as an
environment variable, or to run `npx openhog auth` themselves once.

**b. Otherwise**, show the user the URL and the four scopes and ask them to
create the key and run `npx openhog auth` in their terminal. It is one command
and stores the key at `~/.openhog/credentials.json` with `0600` permissions, so
you never need to see it again.

Do not ask the user to paste the key into the chat.

### 2. Run it

```bash
npx openhog init --yes
```

Add `--region eu` for PostHog Cloud EU, or `--host https://posthog.internal` for
self-hosted.

It will scan the repo, pick a product kind, write `openhog/tracking-plan.json`
and `openhog.config.json`, offer to write an analytics module, create the
dashboards, and write `ANALYTICS.md`.

### 3. Read the output and act on it

Three things in the output need your attention:

- **The product kind it chose.** It prints its reasoning. If the guess is wrong
  for a repo you have just been reading, re-run with `--kind consumer` (or
  whichever fits). The kind decides which dashboards exist.
- **The role map.** Check `npx openhog plan` and confirm each role resolved to
  the right event. You have read this codebase; you are better placed than the
  resolver. A wrong mapping is fixed by editing one line in
  `openhog/tracking-plan.json` and running `npx openhog sync`.
- **Tiles that failed validation**, if any. Report them to the user.

### 4. Wire up the analytics module

If OpenHog wrote one, it prints a framework-specific snippet. Apply it to the
app entry point yourself. If the repo already had an analytics module, OpenHog
leaves it alone — run the diagnosis below against it instead.

### 5. Tell the user what they have

Link the dashboards, point at `ANALYTICS.md`, and name the highest-value
unimplemented event from the plan.

---

## Diagnose

When analytics "isn't working", run this **before** reading any code. It checks
the failures that are invisible in development.

```bash
npx openhog doctor
```

`--offline` skips the 30-second live round-trip. `--json` is easier to read
programmatically.

The four traps it looks for, all production-only:

1. **CSP directives are separate allowlists.** PostHog's asset host serves the
   replay recorder as a *script*. In `connect-src` but not `script-src` means
   events flow forever and replay records nothing.
2. **`capture_pageview: 'history_change'` skips the first page load.** Every
   direct visit and reload sends `$pageleave` with no `$pageview`; Web Analytics
   reads near zero.
3. **Sanitising `$current_url` to a bare path** removes the domain Web Analytics
   attributes visits to.
4. **Replay starting on the first navigation** rather than on landing, because
   the SDK is imported dynamically.

Fix what it reports, then re-run. Do not conclude a client-side fix failed until
the service worker has been unregistered and the caches cleared — it serves the
old bundle after a deploy.

---

## Add an event

Read the plan first so the new event matches the existing vocabulary instead of
inventing a synonym:

```bash
npx openhog plan
```

Then:

1. Add the name to `EVENT_NAMES` in the analytics module (between the
   `openhog:events` markers). The type is derived from that array, so a typo at
   a call site becomes a compile error.
2. Call `track(name, properties)` at the point the thing actually happened —
   after the server confirms, not on button click.
3. **Bucket anything unbounded.** `price_bucket: 'under_20'`, not
   `price: 19.99`. `query_length_bucket: 'medium'`, not the raw search text.
   Raw ids, emails and URLs must never become property values.
4. `npx openhog check` to confirm the plan and code agree.
5. `npx openhog sync` to pick up any dashboard tiles the new event unlocks.

Never add an event to a route in `SENSITIVE_ROUTES` without saying so explicitly
to the user.

---

## Query the data

The `openhog` MCP server exposes these. Prefer them over guessing:

- `get_tracking_plan` — what this product measures and what each event means.
  **Read this before writing any analytics code.**
- `query_analytics` — run HogQL against the `events` table. Always bound the
  time range. The API applies a 100-row default limit unless you pass `LIMIT`.
- `check_instrumentation_drift` — run after any refactor that touched analytics.
- `diagnose_analytics` — the doctor, structured.
- `list_dashboards`, `get_event_definitions`.

Useful HogQL shapes:

```sql
-- what happened after Tuesday's deploy
SELECT toDate(timestamp) AS day, count() AS events, count(DISTINCT distinct_id) AS people
FROM events WHERE event = 'signup_completed' AND timestamp > now() - INTERVAL 14 DAY
GROUP BY day ORDER BY day

-- which events exist at all
SELECT event, count() AS n FROM events
WHERE timestamp > now() - INTERVAL 7 DAY GROUP BY event ORDER BY n DESC LIMIT 50
```

When reporting numbers back, say the time window and whether it counts events or
people. Those two are routinely confused and the difference usually changes the
conclusion.

---

## Rules

- **Never chart an event the code does not emit.** This is the guarantee the
  whole tool exists to provide. If a dashboard needs an event that does not
  exist, add the instrumentation first.
- **Never put a personal API key (`phx_`) in a file in the repo**, in an
  `.env.example`, or in chat. The project key (`phc_`) is public by design and
  belongs in `.env.local` and the hosting provider's environment.
- **Do not turn autocapture on.** It records every click and input, inflates the
  bill, and can capture text nobody intended to collect.
- **Treat `SENSITIVE_ROUTES` as a privacy boundary**, not a config list. Add to
  it when a route starts showing someone else's personal data.
- Analytics code must never throw into the application. A dropped event is
  always cheaper than a broken render.
