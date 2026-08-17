/**
 * `openhog describe` writes into somebody else's production analytics account,
 * where the audience is their whole organisation and the change outlives the
 * person who ran it. Every safety property is therefore pinned here rather than
 * left to the reviewer's memory.
 */

import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildDescriptions, isVacuous, toApply } from '../src/describe/descriptions.js'
import { PostHogClient, customRegion } from '../src/posthog/client.js'
import { startMockPostHog, type MockServer } from './mockPosthog.js'
import { makeFixture, type Fixture } from './fixtures.js'
import { writeJson } from '../src/util/fs.js'
import type { TrackingPlan } from '../src/types.js'

const run = promisify(execFile)
const CLI = join(process.cwd(), 'dist', 'cli.js')

const plan: TrackingPlan = {
  version: 1,
  generatedAt: '2026-08-17T00:00:00.000Z',
  generatedBy: 'test',
  product: { name: 'Lantern', description: '', kind: 'consumer', surfaces: ['web'] },
  events: [
    {
      name: 'save_toggle',
      description: 'Someone kept a gig for later. The strongest retention predictor in this product.',
      stage: 'engagement',
      properties: [],
      emitted: true,
      sources: ['src/Save.tsx:12'],
    },
  ],
  roles: {},
  identity: { distinctIdSource: '', sensitiveRoutes: [] },
  packs: ['core'],
}

describe('choosing what to write', () => {
  const events = [
    { event: 'save_toggle', events: 12_800, people: 2_900 },
    { event: 'signup_completed', events: 3_140, people: 3_140 },
    { event: 'obscure_thing', events: 900, people: 300 },
    { event: '$pageview', events: 400_000, people: 18_000 },
    { event: 'barely_used', events: 4, people: 3 },
  ]

  it('prefers the tracking plan, which a human wrote', () => {
    const [first] = buildDescriptions({
      plan,
      roles: {},
      events,
      existing: new Map(),
    })
    expect(first?.event).toBe('save_toggle')
    expect(first?.source).toBe('plan')
    expect(first?.description).toContain('retention predictor')
  })

  it('falls back to what role the event plays', () => {
    const proposals = buildDescriptions({
      plan: null,
      roles: { signup_completed: 'signup_completed' },
      events,
      existing: new Map(),
    })
    const signup = proposals.find((p) => p.event === 'signup_completed')!
    expect(signup.source).toBe('role')
    expect(signup.description).toContain('signup_completed')
    expect(signup.tags).toContain('role:signup_completed')
  })

  it('says so when a role was guessed rather than read from the name', () => {
    const proposals = buildDescriptions({
      plan: null,
      roles: { signup_completed: 'signup_completed' },
      events,
      existing: new Map(),
      inferredRoles: ['signup_completed'],
    })
    expect(proposals.find((p) => p.event === 'signup_completed')!.description).toContain(
      'worth confirming',
    )
  })

  it('describes an unknown event by its shape rather than inventing a meaning', () => {
    const proposals = buildDescriptions({ plan: null, roles: {}, events, existing: new Map() })
    const obscure = proposals.find((p) => p.event === 'obscure_thing')!
    expect(obscure.source).toBe('behaviour')
    expect(obscure.description).toContain('300 people')
    // It must not claim to know what the event means.
    expect(obscure.description).toContain('could not tell what it means')
  })

  it('never touches PostHog\'s own $ events', () => {
    const proposals = buildDescriptions({ plan: null, roles: {}, events, existing: new Map() })
    expect(proposals.some((p) => p.event.startsWith('$'))).toBe(false)
  })

  it('stays quiet about events almost nobody triggers', () => {
    const proposals = buildDescriptions({ plan: null, roles: {}, events, existing: new Map() })
    expect(proposals.some((p) => p.event === 'barely_used')).toBe(false)
  })

  it('rejects a description that just restates the event name', () => {
    expect(isVacuous('save_toggle', 'Save toggle.')).toBe(true)
    expect(isVacuous('save_toggle', 'Someone kept a gig for later, which predicts retention.')).toBe(false)
  })
})

describe('not trampling other people', () => {
  const events = [{ event: 'save_toggle', events: 100, people: 100 }]

  it('leaves a description somebody already wrote alone', () => {
    const proposals = buildDescriptions({
      plan,
      roles: {},
      events,
      existing: new Map([['save_toggle', 'Our own carefully written note']]),
    })
    const { apply, keptExisting } = toApply(proposals)
    expect(apply).toHaveLength(0)
    expect(keptExisting).toHaveLength(1)
  })

  it('replaces it only when explicitly asked', () => {
    const proposals = buildDescriptions({
      plan,
      roles: {},
      events,
      existing: new Map([['save_toggle', 'Our own carefully written note']]),
    })
    expect(toApply(proposals, { overwrite: true }).apply).toHaveLength(1)
  })

  it('is idempotent: a second run changes nothing', () => {
    const proposals = buildDescriptions({ plan, roles: {}, events, existing: new Map() })
    const written = proposals[0]!.description
    const second = buildDescriptions({
      plan,
      roles: {},
      events,
      existing: new Map([['save_toggle', written]]),
    })
    expect(toApply(second).apply).toHaveLength(0)
  })
})

describe('the command, end to end', () => {
  let fixture: Fixture
  let mock: MockServer

  beforeEach(async () => {
    fixture = makeFixture({ 'package.json': '{"name":"lantern"}' })
    writeJson(join(fixture.root, 'openhog', 'tracking-plan.json'), plan)
    mock = await startMockPostHog({
      hogql: [
        {
          match: /GROUP BY event/,
          rows: [
            ['save_toggle', 12_800, 2_900],
            ['mystery_event', 900, 300],
            // 1.5 per person falls between both inference rules - too repeated
            // to be a once-per-person milestone, too rare to be the habitual
            // action - so nothing claims it and only its shape can be described.
            ['zzz_unclaimed', 150, 100],
          ],
        },
        { match: /days_of_data/, rows: [[3000, 20_000, 120]] },
      ],
      eventDefinitions: [
        { id: 'def-save', name: 'save_toggle', description: null, tags: [] },
        { id: 'def-mystery', name: 'mystery_event', description: null, tags: [] },
        { id: 'def-zzz', name: 'zzz_unclaimed', description: null, tags: [] },
      ],
    })
  })

  afterEach(async () => {
    fixture.cleanup()
    await mock.close()
  })

  const cli = (...args: string[]) =>
    run(process.execPath, [CLI, 'describe', '--host', mock.url, '--project', '1', '--cwd', fixture.root, ...args], {
      env: { ...process.env, POSTHOG_PERSONAL_API_KEY: 'phx_test', NO_COLOR: '1' },
      timeout: 60_000,
    })

  it('writes nothing without --write', async () => {
    const result = await cli()
    expect(result.stdout).toContain('This was a preview. Nothing was written.')
    expect(mock.state.eventDefinitions!.every((d) => !d.description)).toBe(true)
  }, 90_000)

  it('shows what it would write, and where each description came from', async () => {
    const result = await cli()
    expect(result.stdout).toContain('save_toggle')
    expect(result.stdout).toContain('from your tracking plan')
    expect(result.stdout).toContain('from how it behaves')
  }, 90_000)

  it('writes them when told to, and says where to look', async () => {
    const result = await cli('--write', '--yes')
    const save = mock.state.eventDefinitions!.find((d) => d.name === 'save_toggle')!
    expect(save.description).toContain('retention predictor')
    expect(save.tags).toContain('openhog')
    expect(result.stdout).toContain('now live in PostHog')
    expect(result.stdout).toContain('data-management/events')
  }, 90_000)

  it('saves every previous value before touching anything', async () => {
    await cli('--write', '--yes')
    const rollback = join(fixture.root, 'openhog-describe-rollback.json')
    expect(existsSync(rollback)).toBe(true)
    const saved = JSON.parse(readFileSync(rollback, 'utf8'))
    expect(saved.previous.some((p: { event: string }) => p.event === 'save_toggle')).toBe(true)
    expect(saved.projectId).toBe(1)
  }, 90_000)

  it('stops after one event when the write does not persist', async () => {
    // The worst failure mode: PostHog answers 200 and nothing changes. Without
    // the read-back the run would report success for every event.
    mock.state.swallowDefinitionWrites = true
    await expect(cli('--write', '--yes')).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('nothing else was attempted'),
    })
    // Exactly one event was touched, and it did not persist, so the project is
    // effectively unchanged.
    expect(mock.state.eventDefinitions!.every((d) => !d.description)).toBe(true)
  }, 90_000)

  it('does nothing on a second run', async () => {
    await cli('--write', '--yes')
    const result = await cli()
    expect(result.stdout).toMatch(/already has the right description|Nothing to do/)
  }, 90_000)
})

describe('the client call', () => {
  let mock: MockServer

  beforeEach(async () => {
    mock = await startMockPostHog({
      eventDefinitions: [{ id: 'def-1', name: 'signup_completed', description: null, tags: ['existing'] }],
    })
  })
  afterEach(async () => {
    await mock.close()
  })

  it('patches description and tags, keeping tags the project already had', async () => {
    const client = new PostHogClient({
      personalApiKey: 'phx_test',
      hosts: customRegion(mock.url),
      sleep: async () => {},
    })
    await client.updateEventDefinition(1, 'def-1', {
      description: 'An account now exists.',
      tags: ['existing', 'openhog'],
    })
    const definition = await client.getEventDefinition(1, 'def-1')
    expect(definition.description).toBe('An account now exists.')
    expect(definition.tags).toEqual(['existing', 'openhog'])
  })
})
