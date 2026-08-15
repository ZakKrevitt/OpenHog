# Reading the dashboards

`openhog init` writes an `ANALYTICS.md` tailored to your product, with your event
names and links to your dashboards. This is the general version: what each dashboard
is for, and how to read the numbers without fooling yourself.

---

## The weekly routine

Ten minutes, once a week. Everything else is for when a number moves and you need to
know why.

1. **North Star → activation funnel.** Find the steepest single percentage drop.
   That step is your next piece of work. Not the step with the fewest people - the
   step with the biggest fall.
2. **North Star → retention curve.** Read the first column *downwards*. If it reaches
   zero by week 4, you have a leaky bucket and acquisition spend is being poured into
   it.
3. **Instrumentation health → "planned events that have stopped arriving."** Empty is
   the goal. Anything in there means one of the charts you just read is lying.

That is the whole routine.

---

## 1. North Star - activation & retention

**Answers:** are we growing, and do the people we get stick around?

| Tile | Read it as |
|---|---|
| Weekly active people | The headline. Flat WAU with rising signups is a *retention* problem, not a growth one. |
| New people this week | Top of funnel. If it moves and no channel moved, you were mentioned somewhere - check referrers. |
| People who reached value | The number that predicts revenue. If signups rise and this doesn't, onboarding is leaking. |
| Active people over time | Watch the *gap* between the daily and weekly lines. Close together = daily habit. Far apart = occasional use. That ratio should decide whether you send daily notifications at all. |
| Activation funnel | The most actionable chart in the project. Steepest drop first. |
| New-person retention | Read down, not across. |
| Lifecycle | Dormant (below the line) is churn made visible. Consistently bigger than new + resurrecting means you are shrinking while signups look fine. |
| Stickiness | The spike at "1 day" is the tourist bar. Its size against the rest is your first-session failure rate in one picture. |
| Most engaged people | Go and talk to the top ten. Their usage pattern is what onboarding should teach. |

**Retention benchmarks, roughly.** Week 1 under ~20% for a consumer product, or ~40%
for a tool people pay for, means retention beats every other project you could pick.
A curve that *flattens* is a real product. One that hits zero is a leaky bucket.

---

## 2. Acquisition - where people come from

**Answers:** which channels send people who actually stay?

Volume and conversion are deliberately on the same dashboard, because volume alone is
a vanity number.

- **Channel quality** is the table that should decide your budget. 40 visitors at 30%
  beats 4,000 at 0.3%. Sort by rate, not by size.
- **"(none)" is direct and organic combined.** It is normally the biggest bar and it
  tells you least. Judge campaigns against each other, never against direct.
- **Referring domains** is where you find the forum thread or newsletter you did not
  know about. An unfamiliar domain near the top is worth ten minutes of reading.
- **Landing pages** - anything high here is doing acquisition work whether you
  designed it to or not, and deserves the same care as your homepage.
- **Desktop vs mobile** - cross-reference with funnel-by-device. A mobile conversion
  gap is usually the cheapest fix available to you.

**The trap:** small samples swing wildly. A channel with 12 visitors and 50%
conversion is noise. Wait for volume before killing or scaling anything.

---

## 3. The critical path

**Answers:** where exactly do people fall out, and who falls out hardest?

One funnel, then broken apart by the three things that usually explain the drop.

- **By device.** A mobile rate materially below desktop is nearly always layout, not
  intent. Open the mobile replays for the step that drops.
- **By channel.** How you find the source that sends traffic which never converts.
- **Time to convert.** A long tail means people leave and come back to finish - that
  is a case for a reminder email. A tight distribution means single-session decision,
  and reminders will annoy rather than convert.
- **Paths to conversion.** A page here you did not design as part of the path is
  doing persuasion work. Find out what it says and say it earlier.

**The trap:** funnels are ordered and windowed. Someone who does step 3 before step 2
does not count, and neither does someone who takes longer than the window. If a
funnel looks implausibly bad, check the window before rebuilding the product.

---

## 4. Engagement - what people actually do

**Answers:** what is this product being used for, really?

- **Every event, ranked** - the bottom of this table is your delete list. A feature
  used by four people costs you maintenance and menu space forever. The top is what
  onboarding should teach on day one.
- **Actions per active person** - depth. Climbing while active people stay flat is
  usually the healthiest thing on the page: the product is getting more useful to the
  people who already have it.
- **Most-visited pages** - routes here should be normalised (`/items/:id`). If you see
  raw ids, your instrumentation is leaking high-cardinality URLs.
- **Search** - heavy usage usually means weak navigation. People cannot find things by
  browsing.
- **Saves** - one of the strongest retention predictors there is. People come back for
  the thing they saved.
- **When people use it** - decides deploy windows, notification timing and maintenance
  slots. Confirm your project timezone first; a UTC project misplaces every evening
  product by a whole peak.

---

## 5. Friction & health

**Answers:** what is going wrong, for whom, and where?

- **People affected beats error count.** One broken loop firing 900 times for one user
  is a bug report. 900 errors across 400 people is an incident.
- **Empty states** are the most under-measured drop-off in software. Someone who
  searches, gets nothing, and leaves never tells you. The fix is usually a better
  empty state, not a better search box.
- **One-page sessions** - high on a marketing page can be fine (they read it and left
  informed). High on an app page is a failure. Judge each route against its job.
- **Where sessions end** - if the same route keeps appearing at the end of common
  paths, that is where to spend your next hour.
- **Errors by browser** - one browser out of proportion to its traffic share means a
  compatibility bug, not a product bug.

---

## 6. Instrumentation health

**Answers:** can I trust the other five?

The dashboard nobody builds. Analytics rots the way documentation rots, except
silently: a refactor drops a call site and the chart keeps drawing a plausible line
at a lower level.

- **Planned events that have stopped arriving** - every row is a broken chart
  somewhere else. Usual causes in order: a refactor dropped the call, a rename shipped
  to one surface only, a consent banner is blocking the SDK for most users.
- **Events arriving that are not in the plan** - either someone added tracking without
  updating the plan (run `openhog check`), or autocapture is on and you are paying for
  events nobody named.
- **Properties with runaway cardinality** - the tile that stops your bill running away
  and your breakdowns turning into ten-thousand-row lists. Anything holding an id, an
  email, a raw URL or free text should be bucketed at the call site.
- **Event volume** - a step change with no release behind it is nearly always an
  instrumentation bug: an event moved inside a render, or a loop started firing. Catch
  it here, not on an invoice.
- **Which surfaces are reporting** - if you ship web and mobile, both should appear. A
  surface that vanishes has a broken build or an expired key, and it looks like a
  usage drop everywhere else.
- **Pageviews vs page-leaves** - these should track each other. Far more `$pageleave`
  means the SDK is missing the first page load of every session. Your traffic numbers
  are wrong. See [TRAPS.md](./TRAPS.md#first-pageview).

---

## Four ways to fool yourself

**Counting events when you meant people.** "10,000 searches" and "10,000 people
searched" are wildly different products. Every tile here says which it is; when you
report a number onwards, say it too.

**Reading a funnel without its window.** Conversion "dropping" is often a window that
is too short for how people actually decide.

**Comparing periods of different lengths.** Last 30 days against last week is not a
comparison. Use the built-in previous-period toggle.

**Trusting a chart you have not checked the instrumentation for.** Which is what
dashboard 6 is for. Look at it before you make a decision on any of the others.
