# The traps

Failures that are green in development, green in CI, and broken in production.

They share a shape: **the thing that would have caught them does not exist locally.**
Dev servers send no CSP header. Unit suites never fetch a third-party asset. CI has
no ad blocker installed. So the whole class ships, and the charts keep drawing a
plausible-looking line at the wrong level for weeks.

`openhog doctor` checks every one of these. The module `openhog init` generates has
them all closed already.

---

<a id="csp"></a>
## 1. CSP directives are separate allowlists

**Symptom.** Events arrive normally. Session replay records nothing, ever.
`posthog.get_session_replay_url()` returns nothing and `$recording_status` sits at
`lazy_loading` forever.

**Cause.** A Content-Security-Policy is not one list, it is one list per directive.
A host reachable under `connect-src` is *not* thereby loadable as a script.

PostHog uses two hosts:

| Host | What it does | Directive it needs |
|---|---|---|
| `us.i.posthog.com` | receives events | `connect-src` |
| `us-assets.i.posthog.com` | serves lazily-loaded bundles, including `recorder.js` | **`script-src`** *and* `connect-src` |

With the asset host in `connect-src` only, `posthog-js` can POST events forever and
can never fetch the recorder. Half-allowed, and the half that is missing is silent.

**Fix.**

```
connect-src ... https://us.i.posthog.com https://us-assets.i.posthog.com;
script-src  ... https://us-assets.i.posthog.com;
```

EU: `eu.i.posthog.com` and `eu-assets.i.posthog.com`.

**Generalise it.** Any third-party that lazy-loads a bundle needs `script-src`, not
just `connect-src`. The failure mode is always the same: the feature sits in a
permanent loading state and nothing logs an error you'd notice.

**Pin it in a test.** This is worth a unit test against your config file, because
the failure is invisible everywhere else:

```ts
it('lets PostHog both receive events and serve its lazy-loaded bundles', () => {
  expect(directive('connect-src')).toContain('https://us.i.posthog.com')
  expect(directive('connect-src')).toContain('https://us-assets.i.posthog.com')
  // Missing here is what silently disabled session replay in production.
  expect(directive('script-src')).toContain('https://us-assets.i.posthog.com')
})
```

---

<a id="first-pageview"></a>
## 2. `capture_pageview: 'history_change'` skips the first load

**Symptom.** Web Analytics reports near-zero visitors while custom events flow
normally. Bounce rate is nonsense. `$pageleave` count wildly exceeds `$pageview`.

**Cause.** The mode does what it says: it captures on *history changes*. A full page
load is not a history change. So every direct visit, every reload, and every entry
from an external link produced a `$pageleave` at the end with no matching
`$pageview` at the start.

**Fix.** Send it yourself, once per route, from the same place you already handle
navigation:

```ts
capture_pageview: false,
capture_pageleave: true,   // leave this to the SDK: it must fire during unload
```

```ts
export function syncRoute(pathname: string) {
  if (lastPageviewRoute !== pathname) {
    lastPageviewRoute = pathname
    client.capture('$pageview')
  }
}
```

The guard matters - see trap 4, where init calls `syncRoute` again to catch up.

**Check it.** The **Instrumentation health** dashboard plots `$pageview` against
`$pageleave`. They should track each other closely. Divergence means your traffic
numbers are wrong.

---

<a id="url-origin"></a>
## 3. Sanitising `$current_url` to a bare path breaks Web Analytics

**Symptom.** Custom events are fine. Web Analytics shows zero visitors and no
top-pages data, even though `$pageview` events are clearly arriving.

**Cause.** Stripping ids out of URLs is correct - `/list/sh4r3c0d3` is high
cardinality and often sensitive. But going all the way to a bare path removes the
**origin**, and Web Analytics parses `$current_url` to attribute a visit to a
domain. No domain, no attribution, nothing to report.

**Fix.** Strip the ids and the query string. Keep the origin.

```ts
function normalizeUrlProperty(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null
  const RELATIVE_BASE = 'https://openhog.invalid'
  try {
    const url = new URL(value, RELATIVE_BASE)
    const route = normalizeRoute(url.pathname)
    // Keep the origin: it was never the sensitive part.
    return url.origin === RELATIVE_BASE ? route : url.origin + route
  } catch {
    return normalizeRoute(value.split(/[?#]/)[0] || '/')
  }
}
```

Apply it to all six URL-bearing properties: `$current_url`, `$initial_current_url`,
`$pathname`, `$initial_pathname`, `$referrer`, `$initial_referrer`.

---

<a id="replay-race"></a>
## 4. Replay starts on the first navigation, never on landing

**Symptom.** Recordings exist, but every one starts mid-session. Nobody's arrival is
ever recorded. Sessions where someone landed, looked, and left - the ones most worth
watching - do not exist at all.

**Cause.** The SDK is imported dynamically so it lands in its own chunk. Your route
effect runs on mount, while the import is still in flight and the instance is still
`null`, so the call that would have started recording did nothing. Recording only
begins on the *next* route change - and a bouncing visitor never has one.

**Fix.** Catch up after the import resolves:

```ts
loading = import('posthog-js').then((mod) => {
  client = mod.default
  client.init(key, config)
  flushQueue()
  // The route effect already ran while `client` was null.
  if (typeof window !== 'undefined') syncRoute(window.location.pathname)
})
```

This also recovers the landing `$pageview` from trap 2. One line, two bugs.

---

<a id="ad-blockers"></a>
## 5. Ad blockers are eating 15–30% of your traffic

Not production-only, but production-*shaped*: you don't have uBlock Origin on in the
browser you test with, and your CI certainly doesn't.

**Symptom.** Numbers are consistently, unexplainably lower than server logs. The gap
is worst on your most technical pages.

**Cause.** `*.i.posthog.com` is on every major blocklist.

**Why it's worse than it sounds.** It isn't a random 15–30%. Technical and
privacy-conscious users are heavily over-represented among blockers, so a developer
tool loses far more than a consumer app - and every segment comparison you draw is
skewed, not merely undercounted.

**Fix.** Reverse-proxy PostHog through your own domain.

```jsonc
// vercel.json
{
  "rewrites": [
    { "source": "/ingest/static/:path*", "destination": "https://us-assets.i.posthog.com/static/:path*" },
    { "source": "/ingest/:path*",        "destination": "https://us.i.posthog.com/:path*" }
  ]
}
```

```ts
posthog.init(key, { api_host: '/ingest', ui_host: 'https://us.posthog.com' })
```

Then your CSP only needs `'self'`, which closes trap 1 too.

---

<a id="service-worker"></a>
## 6. The service worker is serving the old bundle

**Symptom.** You fix an analytics bug, deploy, load the site, and the bug is still
there. You conclude the fix is wrong. It isn't.

**Cause.** Your service worker cached the JS chunks. A returning browser keeps
running the old bundle until the cache version changes.

**Fix.** Before believing *any* client-side verification after a deploy: unregister
the service worker, clear storage, hard reload. And bump your cache version as part
of the deploy.

Related: a service worker that calls `respondWith` above its cross-origin bypass
will also break PostHog requests outright.

---

<a id="timezone"></a>
## 7. Project timezone and week start

**Symptom.** Daily numbers look subtly wrong. A nightlife or entertainment product
sees its peak split across two calendar days. Weekly cohorts don't line up with how
the team talks about weeks.

**Cause.** A new PostHog project is UTC with weeks starting Sunday.

**Fix.** Settings → Project. Set the timezone to where your users are and the week
start to match how your team plans. Do it early: weekly retention cohorts are grouped
by this, so changing it later re-shapes historical charts.

---

<a id="cardinality"></a>
## 8. One property is quietly eating your bill

**Symptom.** Breakdowns become ten-thousand-row lists. Insights get slow. The bill
climbs with no traffic change.

**Cause.** Something unbounded got sent as a property: a raw search query, a UUID, a
full URL, a timestamp, a price.

**Fix.** Bucket at the call site.

| Instead of | Send |
|---|---|
| `price: 19.99` | `price_bucket: 'under_20'` |
| `query: 'techno berlin friday'` | `query_length_bucket: 'medium'` |
| `event_id: '9f2c...'` | nothing - it belongs in the event, not the breakdown |
| `latency_ms: 4193` | `latency_bucket: 'slow'` |
| `url: 'https://x.com/list/abc'` | `route: '/list/:shareCode'` |

The **Instrumentation health** dashboard has a tile that lists every property with
more than 50 distinct values in a week. Check it monthly; it catches the one that
slipped in three sprints ago.

---

## Running the checks

```bash
npx openhog doctor              # all of the above, against your repo and project
npx openhog doctor --offline    # static checks only, no network, ~1s
npx openhog doctor --json       # machine-readable, for CI
```

Found a production-only failure that isn't here?
[Open an issue](https://github.com/ZakKrevitt/OpenHog/issues) - a new doctor check is
usually a twenty-line PR and it stops the next person losing a week.
