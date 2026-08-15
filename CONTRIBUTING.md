# Contributing

```bash
git clone https://github.com/ZakKrevitt/OpenHog.git
cd OpenHog
npm install
npm run verify     # typecheck + 205 tests + build
```

Node ≥ 20.11. No runtime dependencies - please keep it that way. `npx openhog`
installing in about a second, and being auditable in an afternoon, is part of why
anyone trusts it with an API key.

---

## The four things worth contributing

### 1. A dashboard pack - highest leverage

One file. You know a vertical better than we do, and the metric that matters in it is
probably on none of the general dashboards. **[docs/PACKS.md](./docs/PACKS.md)** is
the full guide.

### 2. A doctor check

Hit a production-only analytics failure? That is a twenty-line addition to
`src/doctor/index.ts` that stops the next person losing a week. Include the
**symptom** (what the user sees), the **cause**, and the **fix** - the fix text is
what people actually read. Add it to [docs/TRAPS.md](./docs/TRAPS.md) too.

### 3. Framework and library detection

`src/scan/detect.ts` for frameworks and routers, `src/scan/events.ts` for analytics
call patterns. If OpenHog missed your stack's routes or your team's `track()`
wrapper, that is a one-line regex and a fixture.

### 4. Role patterns

`src/plan/roles.ts`. If your codebase's spelling of a common action does not resolve,
add it to that role's `include`. Add a test showing three real spellings resolving and
one near-miss that must not.

---

## Testing

```bash
npm test                    # everything
npx vitest                  # watch
npx vitest tests/packs      # one file
```

- **Fixtures are real repositories** written to a temp directory
  (`tests/fixtures.ts`). The scanner's job is reading a real filesystem, so an
  in-memory abstraction would prove nothing.
- **The PostHog mock is a real HTTP server** (`tests/mockPosthog.ts`). The things
  most likely to be wrong are header handling, status-code branching and retries -
  none of which a stubbed `fetch` would catch.
- **`tests/packs.test.ts` runs over every registered pack**, asserting each tile has
  a real interpretation and charts only events the plan says are emitted. A thin pack
  fails CI rather than review.
- **`tests/cli.integration.test.ts` runs the compiled binary** against the mock in a
  real fixture repo. Run `npm run build` first.

Adding a behaviour means adding a test that fails without it.

---

## House style

- Comments explain **why**, never what. If a line is there because its absence broke
  production, say which failure - that is the only thing that stops someone
  "simplifying" it back out.
- Prefer explicit lists over clever regexes. An unmatched framework should be a
  one-line addition, not a puzzle.
- No em dashes in generated user-facing text.
- Interpretation text names the **next action**, not the observation. "If week 1 is
  under 20%, fixing retention beats every other project you could pick" beats "shows
  the retention rate".

---

## Two invariants

Changes that break either of these will not be merged, however convenient:

1. **Never chart an event the code does not emit.** Enforced by `requires` gating and
   by the derived `charts` field. Routing around it defeats the entire point of the
   project.
2. **Never overwrite a file the user wrote.** Especially an existing analytics
   module. Ask, or leave it alone and say so.

---

## Releasing

`npm run verify`, bump `version` in `package.json` and `src/cli.ts`, tag, publish.
`prepublishOnly` runs the full verify, so a broken build cannot be published.
