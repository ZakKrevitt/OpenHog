/**
 * A goal has to change what the report says, or it is decoration.
 *
 * These pin the three things it is supposed to do: rank goal-relevant findings
 * first, lead with the goal's own number, and turn "you cannot measure the thing
 * you said you care about" into the most important finding there is.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PostHogClient, customRegion } from '../src/posthog/client.js'
import { computeMetrics } from '../src/metrics/compute.js'
import { deriveFindings } from '../src/insights/findings.js'
import { GOALS, GOAL_DEFINITIONS, applyGoal, goalBlindSpot } from '../src/insights/goals.js'
import { renderHtmlReport } from '../src/report/html.js'
import { startMockPostHog, type MockServer } from './mockPosthog.js'
import { fakeProject } from './fakeProject.js'

describe('the goal catalogue', () => {
  it.each(GOALS)('%s names a headline metric and explains why', (goal) => {
    const definition = GOAL_DEFINITIONS[goal]
    expect(definition.headlineMetric).toBeTruthy()
    expect(definition.label.length).toBeGreaterThan(8)
    expect(definition.because.length).toBeGreaterThan(40)
  })
})

describe('ranking by what you are working on', () => {
  let mock: MockServer

  beforeEach(async () => {
    mock = await startMockPostHog({ hogql: fakeProject() })
  })
  afterEach(async () => {
    await mock.close()
  })

  const analyse = async () => {
    const client = new PostHogClient({
      personalApiKey: 'phx_test',
      hosts: customRegion(mock.url),
      sleep: async () => {},
    })
    const set = await computeMetrics({ client, projectId: 1, projectName: 'Lantern' })
    return { set, findings: deriveFindings(set) }
  }

  it('marks the findings that bear on the goal', async () => {
    const { findings } = await analyse()
    const ranked = applyGoal(findings, { focus: 'retention' })
    const retention = ranked.find((f) => f.id === 'retention-low')
    expect(retention?.goalRelevant).toBe(true)
  })

  it('does not mark unrelated findings', async () => {
    const { findings } = await analyse()
    const ranked = applyGoal(findings, { focus: 'reliability' })
    expect(ranked.find((f) => f.id === 'channel-concentration')?.goalRelevant).toBeFalsy()
  })

  it('changes which finding comes first, depending on the goal', async () => {
    const { findings } = await analyse()
    const forRetention = applyGoal(findings, { focus: 'retention' })
    const forReliability = applyGoal(findings, { focus: 'reliability' })
    // The same project, two goals, two different things to do next.
    expect(forRetention[0]!.id).not.toBe(forReliability[0]!.id)
  })

  it('never lets a goal outrank a broken-instrumentation finding', async () => {
    // A goal measured with bad data is not measured at all, so trust findings
    // stay on top whatever anyone says they are working on.
    mock.state.hogql = fakeProject({ brokenInstrumentation: true })
    const { findings } = await analyse()
    const ranked = applyGoal(findings, { focus: 'retention' })
    expect(['silent-events', 'pageview-integrity']).toContain(ranked[0]!.id)
  })

  it('leaves findings untouched when no goal is set', async () => {
    const { findings } = await analyse()
    expect(applyGoal(findings, null)).toEqual(findings)
  })
})

describe('saying you care about something you cannot see', () => {
  it('is a critical finding', () => {
    const finding = goalBlindSpot({ focus: 'conversion' }, {}, () => false)!
    expect(finding).toBeDefined()
    expect(finding.severity).toBe('critical')
    expect(finding.impact).toBe(100)
    expect(finding.title).toContain('cannot measure it')
    expect(finding.action.length).toBeGreaterThan(60)
  })

  it('names the event that would fix it', () => {
    const finding = goalBlindSpot({ focus: 'reliability' }, {}, () => false)!
    expect(finding.action).toContain('error')
  })

  it('stays quiet when the goal is measurable', () => {
    expect(goalBlindSpot({ focus: 'retention' }, {}, () => true)).toBeNull()
  })

  it('stays quiet when no goal was set', () => {
    expect(goalBlindSpot(null, {}, () => false)).toBeNull()
  })

  it('accepts a role standing in for the goal', () => {
    // `conversion` needs any one of purchase, checkout or subscription.
    expect(
      goalBlindSpot({ focus: 'conversion' }, { checkout_started: 'cart_checkout' }, () => true),
    ).toBeNull()
  })
})

describe('the goal in the report', () => {
  let mock: MockServer

  beforeEach(async () => {
    mock = await startMockPostHog({ hogql: fakeProject() })
  })
  afterEach(async () => {
    await mock.close()
  })

  it('leads with the goal, its number and its typical range', async () => {
    const client = new PostHogClient({
      personalApiKey: 'phx_test',
      hosts: customRegion(mock.url),
      sleep: async () => {},
    })
    const set = await computeMetrics({ client, projectId: 1, projectName: 'Lantern' })
    const findings = applyGoal(deriveFindings(set), { focus: 'retention', note: 'before the raise' })
    const html = renderHtmlReport({ set, findings, goal: { focus: 'retention', note: 'before the raise' } })

    expect(html).toContain('Your goal')
    expect(html).toContain('Get people to come back')
    expect(html).toContain('before the raise')
    // The goal band sits above the findings.
    expect(html.indexOf('Your goal')).toBeLessThan(html.indexOf('What to do about it'))
  })

  it('flags the goal-relevant findings visually', async () => {
    const client = new PostHogClient({
      personalApiKey: 'phx_test',
      hosts: customRegion(mock.url),
      sleep: async () => {},
    })
    const set = await computeMetrics({ client, projectId: 1 })
    const findings = applyGoal(deriveFindings(set), { focus: 'retention' })
    const html = renderHtmlReport({ set, findings, goal: { focus: 'retention' } })
    expect(html).toContain('goaltag')
  })

  it('omits the band entirely when no goal is set', async () => {
    const client = new PostHogClient({
      personalApiKey: 'phx_test',
      hosts: customRegion(mock.url),
      sleep: async () => {},
    })
    const set = await computeMetrics({ client, projectId: 1 })
    const html = renderHtmlReport({ set, findings: deriveFindings(set) })
    expect(html).not.toContain('Your goal')
  })
})
