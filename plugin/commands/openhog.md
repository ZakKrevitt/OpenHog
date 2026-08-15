---
description: Set up, repair, or query product analytics for this repo with OpenHog
argument-hint: "[setup | doctor | check | sync | demo | <a question about your users>]"
---

Use the `openhog` skill.

The user asked: **$ARGUMENTS**

Route it:

- Empty, `setup`, or `init` → full setup. Check `npx openhog auth --check` first;
  if there is no key, get the walk from `npx openhog auth --instructions` and help
  the user create one. Never handle the key value yourself.
- `doctor`, or anything about events not arriving / an empty dashboard →
  `npx openhog doctor`. Run it *before* reading any code.
- `check` → `npx openhog check`, and explain any drift in terms of which chart it
  breaks.
- `sync` → `npx openhog sync` after confirming the tracking plan looks right.
- `demo` → `npx openhog demo`, but warn that it writes real events and is best
  pointed at a scratch project.
- A question about real usage ("how many people signed up last week", "did the new
  onboarding help") → answer it with the `query_analytics` MCP tool. State the time
  window and whether you counted events or people.

If the repo has no `openhog.config.json`, say so and offer setup.
