# Launch copy

Ready to paste. The angle throughout is **"your analytics is quietly lying to you"**,
not "here is a dashboard setup tool." The first is a story people forward; the second
is a product nobody asked about.

Two things to do by hand first:

1. **Upload the social preview.** GitHub → repo → Settings → General → Social preview →
   upload `docs/social-preview.png`. This is what renders when the link is shared on X,
   Slack, LinkedIn or Discord, and without it GitHub serves a generic card. Biggest
   single click-through lever available and it takes thirty seconds.
2. **Optionally publish to npm** so `npx openhog` works: `npm login && npm publish`.
   The name is free. Download counts are their own social proof.

---

## Hacker News

Post as **Show HN**. Tuesday to Thursday, 8-10am Pacific.

**Title** (80 char limit, no emoji, no hype):

```
Show HN: OpenHog – find out what your PostHog data has been hiding from you
```

Alternatives if that one flops:

```
Show HN: Your PostHog is full of data and empty of answers
Show HN: A tool that reads your analytics and tells you what to actually do
```

**First comment** (post immediately, this matters more than the title):

```
I spent a week wiring PostHog into a product properly and found four bugs that were
all green in dev, green in CI, and broken in production:

- CSP directives are separate allowlists. PostHog's asset host was in connect-src but
  not script-src, so events flowed forever and session replay recorded nothing. The
  status just sat at "lazy_loading".
- capture_pageview: 'history_change' skips the first page load. Every direct visit and
  every reload sent $pageleave with no matching $pageview, so Web Analytics read near
  zero while custom events looked fine.
- Sanitising $current_url down to a bare path breaks attribution, because PostHog parses
  that field to work out the domain. Strip the ids, keep the origin.
- Replay started on the first navigation, never on landing, because the SDK is imported
  dynamically. Land-look-leave sessions were exactly the ones never recorded.

None of those are findable locally. Dev serves no CSP, tests never fetch a third-party
asset, and CI has no ad blocker.

So I built the thing I wanted: point it at a PostHog project and it reads your events,
works out which one is your signup and which is your core action whatever you happen to
call them, computes retention/activation/funnels, and returns a ranked list of what to
do, with a benchmark for your kind of product and one concrete next action per finding.

Two rules it does not break: it never makes a claim off a sample too small to support
one, and it never reports "not measured" as zero. If you don't send a signup event you
get "you cannot currently see how many visitors become users", not "your signup rate is
0%".

Verifying it against a real project found two more bugs I would have shipped. An
ARRAY JOIN that ClickHouse rejects outright, and long-window metrics answering
confidently on a project that had only existed for three days: it reported a 30-day
stickiness and a 0% power-user share off 5,534 people, which would have rendered as a
critical finding. Metrics now declare how much history they need.

Zero runtime dependencies, MIT, and everything it generates is plain code and JSON you
own. It reads your data and writes to your own PostHog; nothing goes anywhere else.

Happy to go into any of it. The benchmarks are rules of thumb rather than measurements
and the README says so, so if you have real numbers for a vertical I'd love the PR.
```

**Answering the obvious comments:**

- *"Why not just use PostHog's wizard?"* It guesses event names. If it guesses
  `user_signed_up` and you emit `signup_complete`, you get empty charts and conclude the
  tool is broken. OpenHog resolves roles against what your project actually sends, and
  skips any chart whose events don't exist rather than shipping an empty one.
- *"Benchmarks are made up."* Partly, yes, and the README says so in those words. They're
  widely repeated industry guidance, not measured from a dataset. They're there because
  approximately-right context beats a bare number with none, and every finding says which
  band it used so you can disagree with it.
- *"Sending my API key to a random npm package?"* Zero runtime dependencies, so the whole
  thing is auditable in an afternoon. The key is stored at `~/.openhog/credentials.json`
  with 0600 and only ever sent as an Authorization header to your own PostHog host.
- *"Does it work on self-hosted?"* `openhog selftest` runs every query against your
  deployment and reports which ones it can answer, with PostHog's actual error for any
  it can't.

---

## X / Twitter

Thread. Lead with the screenshot of the report, not the terminal.

```
1/ Your PostHog has been lying to you and it hasn't told you.

Two of your events stopped arriving three weeks ago. Four charts have been
drawing a confident flat line ever since.

I built a thing that finds this in 30 seconds:

npx github:ZakKrevitt/OpenHog explain
```

```
2/ It reads the events you already send. It works out which one is your signup
and which is your core action, whatever you happen to call them.

"User Signed Up", "userSignedUp", "nutzer_registriert", "kyc_passed" all resolve.
```

```
3/ Then it tells you what to DO.

Not "retention is 8.9%". That plus: this is well below typical for a consumer app,
here's why it's the multiplier on everything else, and here is the specific thing to
open tomorrow morning.
```

```
4/ Two rules it never breaks.

No claim off a sample too small to support it.

And it never reports "not measured" as zero. No signup event means "you cannot see
this", not "your signup rate is 0%".
```

```
5/ It also found four production-only PostHog bugs the hard way, in production,
weeks after shipping, with the charts confidently wrong the whole time.

All four are now checked automatically by `openhog doctor`.

MIT, zero dependencies.
github.com/ZakKrevitt/OpenHog
```

---

## Reddit

**r/PostHog, r/analytics, r/SaaS, r/webdev.** No links in the title, be a person, answer
comments. Reddit punishes anything that reads like marketing.

**Title:** `I got tired of PostHog dashboards that look fine and tell me nothing, so I built something that reads the data and says what to do`

**Body:** use the HN comment above, cut to about half, drop the bullet list of traps to
two items.

---

## PostHog's own community

The highest-intent audience there is, and they are friendly to things that make PostHog
more useful. Be explicit that it's third-party and complementary, never a replacement.

- PostHog community Slack, `#feedback` or `#show-and-tell`
- Their forum / GitHub discussions

**Opener:**

```
Built a third-party CLI that reads a PostHog project and returns a ranked list of what
to work on, plus a doctor for the four setup traps that only show up in production
(CSP script-src vs connect-src for the replay recorder being the one that got me).

Not a replacement for anything, it just makes what's already there easier to act on.
It also writes descriptions onto your event definitions so the event list stops being
200 undocumented names. MIT, zero dependencies, reads your project and writes only to
your own.
```

---

## The one-liners

For bios, comments, and anywhere you get one sentence:

- Your PostHog is full of data and empty of answers.
- It reads your analytics and tells you what to actually do.
- Finds the two events that stopped arriving and the four charts that have been lying.
- Analytics that says what to do, not just what happened.

---

## What to measure

Stars are the goal, but the honest leading indicator is **whether people run it**. If
the repo gets traffic and nobody runs the command, the README is doing its job and the
product is not. If people run it and don't star, the reverse.

GitHub → Insights → Traffic gives you views and clones. Clones are the closest thing to
a run count you'll get.
