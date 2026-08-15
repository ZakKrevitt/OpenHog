/**
 * End-to-end: run the real compiled binary against a real HTTP server, in a
 * real repository, and check the files it leaves behind.
 *
 * The unit tests cover each stage in isolation; this is the only thing that
 * proves the stages are wired together, that `--yes` genuinely never blocks on
 * a prompt, and that a first run produces something coherent.
 */

import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeFixture, VITE_CONSUMER_APP, type Fixture } from './fixtures.js'
import { startMockPostHog, type MockServer } from './mockPosthog.js'

const run = promisify(execFile)
const CLI = join(process.cwd(), 'dist', 'cli.js')

describe('openhog init, end to end', () => {
  let fixture: Fixture
  let mock: MockServer
  let stdout: string

  beforeAll(async () => {
    if (!existsSync(CLI)) throw new Error('Run `npm run build` before the integration tests.')
    fixture = makeFixture(VITE_CONSUMER_APP)
    mock = await startMockPostHog()

    const result = await run(
      process.execPath,
      [CLI, 'init', '--yes', '--host', mock.url, '--project', '1', '--cwd', fixture.root],
      {
        env: {
          ...process.env,
          POSTHOG_PERSONAL_API_KEY: 'phx_integration_test',
          NO_COLOR: '1',
        },
        // A hang here means a prompt slipped past the non-interactive guard,
        // which would break every CI and agent use of the tool.
        timeout: 60_000,
      },
    )
    stdout = result.stdout
  }, 90_000)

  afterAll(async () => {
    fixture.cleanup()
    await mock.close()
  })

  it('completes without blocking on a prompt', () => {
    expect(stdout).toContain('Done. Next:')
  })

  it('identifies the product from the repository rather than the folder name', () => {
    expect(stdout).toContain('Lantern')
  })

  it('writes the config and the tracking plan', () => {
    expect(existsSync(join(fixture.root, 'openhog.config.json'))).toBe(true)
    const planPath = join(fixture.root, 'openhog', 'tracking-plan.json')
    expect(existsSync(planPath)).toBe(true)

    const plan = JSON.parse(readFileSync(planPath, 'utf8'))
    expect(plan.product.name).toBe('Lantern')
    expect(plan.events.some((event: { name: string }) => event.name === 'signup_completed')).toBe(true)
    expect(plan.roles.signup_completed).toBe('signup_completed')
  })

  it('never clobbers an analytics module the user already wrote', () => {
    // The fixture ships its own src/analytics.ts. Replacing it silently would
    // be the worst thing this tool could do, so a first run leaves it alone and
    // says so.
    const source = readFileSync(join(fixture.root, 'src', 'analytics.ts'), 'utf8')
    expect(source).toContain('ANALYTICS_EVENT_NAMES')
    expect(source).not.toContain('capture_pageview')
    expect(stdout).toContain('Kept your existing')
  })

  it('creates dashboards in PostHog, with an insight per tile', () => {
    expect(mock.state.dashboards.length).toBeGreaterThan(2)
    expect(mock.state.insights.length).toBeGreaterThan(10)
    for (const insight of mock.state.insights) {
      expect(insight.dashboards.length).toBe(1)
      expect(insight.query).toBeTruthy()
    }
  })

  it('validates every query before creating it', () => {
    const queries = mock.state.requests.filter((request) => request.path.endsWith('/query/'))
    expect(queries.length).toBeGreaterThanOrEqual(mock.state.insights.length)
  })

  it('only ever charts events the codebase actually emits', () => {
    const plan = JSON.parse(readFileSync(join(fixture.root, 'openhog', 'tracking-plan.json'), 'utf8'))
    const emitted = new Set<string>(
      plan.events.filter((event: { emitted: boolean }) => event.emitted).map((event: { name: string }) => event.name),
    )
    emitted.add('$pageview')
    emitted.add('$pageleave')

    for (const insight of mock.state.insights) {
      const series = (insight.query as any)?.source?.series ?? []
      for (const node of series) {
        if (!node.event) continue
        expect(emitted.has(node.event), `${insight.name} charts "${node.event}", which nothing emits`).toBe(true)
      }
    }
  })

  it('writes the walkthrough with real dashboard links', () => {
    const walkthrough = readFileSync(join(fixture.root, 'ANALYTICS.md'), 'utf8')
    expect(walkthrough).toContain('# Analytics for Lantern')
    expect(walkthrough).toContain('The 5-minute version')
    expect(walkthrough).toContain('How to read it')
    expect(walkthrough).toContain(`${mock.url}/project/1/dashboard/`)
  })

  it('writes an .env.example that is safe to commit', () => {
    const example = readFileSync(join(fixture.root, '.env.example'), 'utf8')
    expect(example).toContain('VITE_PUBLIC_POSTHOG_KEY=phc_your_project_key')
    expect(example).not.toContain('phc_test_token')
  })

  it('puts the real key only in the gitignored file', () => {
    const local = readFileSync(join(fixture.root, '.env.local'), 'utf8')
    expect(local).toContain('phc_test_token')
    const gitignore = readFileSync(join(fixture.root, '.gitignore'), 'utf8')
    expect(gitignore).toContain('.env.local')
  })

  it('never sends the personal API key anywhere but the Authorization header', () => {
    for (const request of mock.state.requests) {
      expect(request.path).not.toContain('phx_')
      expect(JSON.stringify(request.body ?? '')).not.toContain('phx_integration_test')
    }
  })
})

describe('openhog init in a repo with no analytics module', () => {
  let fixture: Fixture
  let mock: MockServer

  beforeAll(async () => {
    const { 'src/analytics.ts': _dropped, ...withoutModule } = VITE_CONSUMER_APP
    fixture = makeFixture(withoutModule)
    mock = await startMockPostHog()
    await run(
      process.execPath,
      [CLI, 'init', '--yes', '--host', mock.url, '--project', '1', '--cwd', fixture.root],
      { env: { ...process.env, POSTHOG_PERSONAL_API_KEY: 'phx_test', NO_COLOR: '1' }, timeout: 60_000 },
    )
  }, 90_000)

  afterAll(async () => {
    fixture.cleanup()
    await mock.close()
  })

  it('writes the module with every production guard in it', () => {
    const source = readFileSync(join(fixture.root, 'src', 'analytics.ts'), 'utf8')
    expect(source).toContain('capture_pageview: false')
    expect(source).toContain('capture_pageleave: true')
    expect(source).toContain('autocapture: false')
    expect(source).toContain('url.origin + route')
    expect(source).toContain('MAX_QUEUED_EVENTS')
  })

  it('normalises the routes it found into the generated module', () => {
    const source = readFileSync(join(fixture.root, 'src', 'analytics.ts'), 'utf8')
    expect(source).toContain("return '/gigs/:id'")
  })
})

describe('openhog check, after init', () => {
  let fixture: Fixture
  let mock: MockServer

  beforeAll(async () => {
    fixture = makeFixture(VITE_CONSUMER_APP)
    mock = await startMockPostHog()
    await run(
      process.execPath,
      [CLI, 'init', '--yes', '--host', mock.url, '--project', '1', '--cwd', fixture.root],
      { env: { ...process.env, POSTHOG_PERSONAL_API_KEY: 'phx_test', NO_COLOR: '1' }, timeout: 60_000 },
    )
  }, 90_000)

  afterAll(async () => {
    fixture.cleanup()
    await mock.close()
  })

  it('exits 0 with no network when nothing is broken', async () => {
    const result = await run(process.execPath, [CLI, 'check', '--cwd', fixture.root], {
      env: { ...process.env, NO_COLOR: '1', POSTHOG_PERSONAL_API_KEY: '' },
      timeout: 30_000,
    })
    // Unimplemented suggestions are information, not failure.
    expect(result.stdout).toMatch(/Nothing broken|agree/)
  })

  it('exits 1 when an emitted event disappears', async () => {
    const planPath = join(fixture.root, 'openhog', 'tracking-plan.json')
    const plan = JSON.parse(readFileSync(planPath, 'utf8'))
    plan.events.push({
      name: 'event_that_no_longer_exists',
      description: '',
      stage: 'engagement',
      properties: [],
      emitted: true,
      sources: ['src/Gone.tsx:1'],
    })
    const { writeFileSync } = await import('node:fs')
    writeFileSync(planPath, JSON.stringify(plan, null, 2))

    await expect(
      run(process.execPath, [CLI, 'check', '--cwd', fixture.root], {
        env: { ...process.env, NO_COLOR: '1' },
        timeout: 30_000,
      }),
    ).rejects.toMatchObject({ code: 1 })
  })
})

describe('the CLI surface', () => {
  it('prints help rather than treating a flag as a command', async () => {
    const result = await run(process.execPath, [CLI, '--help'], { timeout: 20_000 })
    expect(result.stdout).toContain('USAGE')
    expect(result.stdout).not.toContain('Unknown command')
  })

  it('reports a version', async () => {
    const result = await run(process.execPath, [CLI, '--version'], { timeout: 20_000 })
    expect(result.stdout).toMatch(/openhog \d+\.\d+\.\d+/)
  })

  it('explains itself when there is no key and no TTY, instead of hanging', async () => {
    const fixture = makeFixture(VITE_CONSUMER_APP)
    await expect(
      run(process.execPath, [CLI, 'init', '--yes', '--cwd', fixture.root], {
        env: { ...process.env, POSTHOG_PERSONAL_API_KEY: '', NO_COLOR: '1' },
        timeout: 30_000,
      }),
    ).rejects.toMatchObject({ code: 1 })
    fixture.cleanup()
  })
})
