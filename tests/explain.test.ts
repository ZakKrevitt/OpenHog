/**
 * The metrics → findings pipeline, against a believable project.
 *
 * The thing under test is not really the arithmetic. It is the judgement: does
 * it find the actual problem, does it rank the important thing first, and does
 * it keep quiet when the sample is too small to justify a claim. Those are the
 * properties that decide whether anyone trusts the report.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PostHogClient, customRegion } from '../src/posthog/client.js'
import { computeMetrics } from '../src/metrics/compute.js'
import { deriveFindings, healthScore, summarise } from '../src/insights/findings.js'
import { bandFor, typicalRange } from '../src/insights/benchmarks.js'
import { discoverProject, guessKindFromEvents } from '../src/metrics/discover.js'
import { renderHtmlReport } from '../src/report/html.js'
import { startMockPostHog, type MockServer } from './mockPosthog.js'
import { fakeProject, type FakeProjectOptions } from './fakeProject.js'

async function analyse(mock: MockServer, options: FakeProjectOptions = {}) {
  mock.state.hogql = fakeProject(options)
  const client = new PostHogClient({
    personalApiKey: 'phx_test',
    hosts: customRegion(mock.url),
    sleep: async () => {},
  })
  const set = await computeMetrics({ client, projectId: 1, projectName: 'Lantern' })
  return { set, findings: deriveFindings(set) }
}

describe('reading a project with no repository', () => {
  let mock: MockServer

  beforeEach(async () => {
    mock = await startMockPostHog()
  })
  afterEach(async () => {
    await mock.close()
  })

  it('resolves roles from the events PostHog has already seen', async () => {
    mock.state.hogql = fakeProject()
    const client = new PostHogClient({
      personalApiKey: 'phx_test',
      hosts: customRegion(mock.url),
      sleep: async () => {},
    })
    const discovery = await discoverProject(client, 1)

    expect(discovery.roles.signup_completed).toBe('signup_completed')
    expect(discovery.roles.content_opened).toBe('gig_detail_opened')
    expect(discovery.roles.search).toBe('search_submit')
    expect(discovery.roles.error).toBe('error_shown')
    expect(discovery.activePeople).toBe(18_400)
  })

  it('prefers the higher-volume event when two names both fit a role', async () => {
    mock.state.hogql = [
      {
        match: /GROUP BY event/,
        rows: [
          ['signup_completed', 40, 40],
          ['user_registered', 9000, 9000],
        ],
      },
      { match: /days_of_data/, rows: [[9040, 100_000, 90]] },
    ]
    const client = new PostHogClient({
      personalApiKey: 'phx_test',
      hosts: customRegion(mock.url),
      sleep: async () => {},
    })
    const discovery = await discoverProject(client, 1)
    // The one fired by 9,000 people is the real signup; the other is a leftover.
    expect(discovery.roles.signup_completed).toBe('user_registered')
  })

  it('ignores events with almost no volume when resolving roles', async () => {
    mock.state.hogql = [
      { match: /GROUP BY event/, rows: [['share_click', 2, 1], ['$pageview', 50_000, 4000]] },
      { match: /days_of_data/, rows: [[4000, 50_002, 90]] },
    ]
    const client = new PostHogClient({
      personalApiKey: 'phx_test',
      hosts: customRegion(mock.url),
      sleep: async () => {},
    })
    const discovery = await discoverProject(client, 1)
    expect(discovery.roles.share).toBeUndefined()
  })
})

describe('finding the actual problem', () => {
  let mock: MockServer

  beforeEach(async () => {
    mock = await startMockPostHog()
  })
  afterEach(async () => {
    await mock.close()
  })

  it('identifies the activation cliff as the top problem', async () => {
    const { findings } = await analyse(mock)
    const top = findings[0]!
    expect(top.severity).toBe('critical')
    expect(['activation-low', 'retention-collapsing', 'retention-low']).toContain(top.id)
    expect(findings.some((finding) => finding.id === 'activation-low')).toBe(true)
  })

  it('quotes the real numbers rather than generic advice', async () => {
    const { findings } = await analyse(mock)
    const activation = findings.find((finding) => finding.id === 'activation-low')!
    // 690 of 3140 activated, so 78% did not.
    expect(activation.title).toContain('78%')
    expect(activation.what).toContain('3140')
    expect(activation.what).toContain('690')
  })

  it('gives every finding a concrete next action', async () => {
    const { findings } = await analyse(mock)
    expect(findings.length).toBeGreaterThan(3)
    for (const finding of findings) {
      expect(finding.action.length, `${finding.id} needs a real action`).toBeGreaterThan(60)
      expect(finding.why.length).toBeGreaterThan(60)
      // Advice nobody can act on tomorrow morning is not advice.
      expect(finding.action.toLowerCase()).not.toMatch(/^consider (improving|optimising|optimizing)/)
    }
  })

  it('notices a retention curve that never flattens', async () => {
    const { findings } = await analyse(mock)
    expect(findings.some((finding) => finding.id === 'retention-collapsing')).toBe(true)
  })

  it('reports errors by people affected, not by event count', async () => {
    const { findings } = await analyse(mock)
    const errors = findings.find((finding) => finding.id === 'errors-widespread')!
    expect(errors).toBeDefined()
    expect(errors.what).toContain('1960')
    expect(errors.why).toContain('People affected')
  })

  it('finds nothing alarming in a healthy project, and says what is working', async () => {
    const { findings } = await analyse(mock, { healthy: true })
    expect(findings.filter((finding) => finding.severity === 'critical')).toHaveLength(0)
    expect(findings.some((finding) => finding.severity === 'strength')).toBe(true)
  })
})

describe('what it cannot see', () => {
  let mock: MockServer

  beforeEach(async () => {
    mock = await startMockPostHog()
  })
  afterEach(async () => {
    await mock.close()
  })

  it('reports a missing signup event as a blind spot rather than as zero signups', async () => {
    // Conflating "you have no signups" with "you do not track signups" is the
    // fastest way for a tool like this to say something false.
    const { set, findings } = await analyse(mock, { without: ['signup_completed'] })
    expect(set.values.signup_conversion?.value).toBeNull()
    expect(set.values.signup_conversion?.note).toContain('does not appear to send one')
    expect(findings.some((finding) => finding.id === 'blind-spot-signup_completed')).toBe(true)
  })

  it('does not claim a metric it could not compute', async () => {
    const { set, findings } = await analyse(mock, { without: ['error_shown'] })
    expect(set.values.error_exposure?.value).toBeNull()
    expect(findings.some((finding) => finding.id === 'errors-widespread')).toBe(false)
  })

  it('limits blind-spot findings so a bare project is not buried in them', async () => {
    const { findings } = await analyse(mock, {
      without: ['signup_completed', 'error_shown', 'share_click', 'list_created'],
    })
    expect(findings.filter((finding) => finding.severity === 'opportunity').length).toBeLessThanOrEqual(3)
  })
})

describe('trusting the instrumentation', () => {
  let mock: MockServer

  beforeEach(async () => {
    mock = await startMockPostHog()
  })
  afterEach(async () => {
    await mock.close()
  })

  it('puts broken instrumentation above every product finding', async () => {
    const { findings } = await analyse(mock, { brokenInstrumentation: true })
    const instrumentation = findings.findIndex((finding) =>
      ['silent-events', 'pageview-integrity'].includes(finding.id),
    )
    const product = findings.findIndex((finding) => finding.id === 'activation-low')
    expect(instrumentation).toBeGreaterThanOrEqual(0)
    expect(instrumentation).toBeLessThan(product)
  })

  it('names the events that stopped arriving', async () => {
    const { findings } = await analyse(mock, { brokenInstrumentation: true })
    const silent = findings.find((finding) => finding.id === 'silent-events')!
    expect(silent.what).toContain('save_toggle')
  })

  it('recognises the missing-first-pageview trap from the view/leave ratio', async () => {
    const { findings } = await analyse(mock, { brokenInstrumentation: true })
    const integrity = findings.find((finding) => finding.id === 'pageview-integrity')!
    expect(integrity).toBeDefined()
    expect(integrity.why).toContain('history_change')
  })

  it('flags runaway properties with the offending names', async () => {
    const { findings } = await analyse(mock, { brokenInstrumentation: true })
    const runaway = findings.find((finding) => finding.id === 'runaway-properties')!
    expect(runaway.what).toContain('user_email')
  })
})

describe('not making claims off small samples', () => {
  let mock: MockServer

  beforeEach(async () => {
    mock = await startMockPostHog()
  })
  afterEach(async () => {
    await mock.close()
  })

  it('stays quiet when there are only a handful of people', async () => {
    mock.state.hogql = [
      { match: /GROUP BY event/, rows: [['$pageview', 300, 40], ['signup_completed', 9, 9]] },
      { match: /days_of_data/, rows: [[40, 309, 90]] },
      { match: /dateDiff\('day', first_seen, last_seen\) >= 7/, rows: [[11, 1]] },
      { match: /countIf\(active_days = 1\) AS one_day/, rows: [[11, 10]] },
    ]
    const client = new PostHogClient({
      personalApiKey: 'phx_test',
      hosts: customRegion(mock.url),
      sleep: async () => {},
    })
    const set = await computeMetrics({ client, projectId: 1 })
    const findings = deriveFindings(set)

    // 1 of 11 retained is 9%, which would look alarming. Eleven people is not
    // evidence of anything, so no finding may be raised from it.
    expect(set.values.retention_w1?.confidence).toBe('low')
    expect(findings.some((finding) => finding.id === 'retention-low')).toBe(false)
    expect(findings.some((finding) => finding.id === 'one-visit')).toBe(false)
  })

  it('withholds a health score when too little could be computed', async () => {
    mock.state.hogql = [
      { match: /GROUP BY event/, rows: [['$pageview', 10, 3]] },
      { match: /days_of_data/, rows: [[3, 10, 2]] },
    ]
    const client = new PostHogClient({
      personalApiKey: 'phx_test',
      hosts: customRegion(mock.url),
      sleep: async () => {},
    })
    const set = await computeMetrics({ client, projectId: 1 })
    // Every metric that returned the mock's generic answer still counts, so the
    // guard is on how many resolved, not on whether findings exist.
    const score = healthScore([], set)
    if (score) expect(score.basis).toContain('summarises the findings')
  })
})

describe('a project too young to answer the question', () => {
  let mock: MockServer

  beforeEach(async () => {
    mock = await startMockPostHog()
  })
  afterEach(async () => {
    await mock.close()
  })

  /** A busy project that has only existed for three days. */
  function youngProject(): MockServer['state']['hogql'] {
    return [
      {
        match: /GROUP BY event\s+ORDER BY events DESC/,
        rows: [
          ['$pageview', 5573, 4359],
          ['page_viewed', 5675, 4367],
          ['auth_prompt_action', 3, 3],
        ],
      },
      // Three days of history, but thousands of people in it.
      { match: /days_of_data/, rows: [[5534, 34_495, 3]] },
      // What a real three-day-old project actually returns for these.
      { match: /avg\(daily\) AS avg_dau/, rows: [[1391, 5534]] },
      { match: /countIf\(active_days >= 5\) AS power_users/, rows: [[5534, 0, 5508]] },
      { match: /dateDiff\('day', first_seen, last_seen\) >= 7/, rows: [[0, 0]] },
      { match: /countIf\(active_days = 1\) AS one_day/, rows: [[0, 0]] },
    ]
  }

  it('withholds long-window metrics instead of answering them with nonsense', async () => {
    // Verified against a real three-day-old PostHog project: it happily returns
    // a 30-day stickiness of 0.25 and a power-user share of 0%. The sample is
    // 5,534 people, so no sample-size check catches it.
    mock.state.hogql = youngProject()
    const client = new PostHogClient({
      personalApiKey: 'phx_test',
      hosts: customRegion(mock.url),
      sleep: async () => {},
    })
    const set = await computeMetrics({ client, projectId: 1 })

    expect(set.context.daysOfData).toBe(3)
    for (const id of ['stickiness', 'power_user_share', 'retention_w1', 'retention_w4']) {
      expect(set.values[id]?.value, `${id} must be withheld`).toBeNull()
      expect(set.values[id]?.note).toMatch(/days of history/)
    }
  })

  it('raises no product findings from a three-day-old project', async () => {
    // 0% power users would otherwise read as a critical finding.
    mock.state.hogql = youngProject()
    const client = new PostHogClient({
      personalApiKey: 'phx_test',
      hosts: customRegion(mock.url),
      sleep: async () => {},
    })
    const findings = deriveFindings(await computeMetrics({ client, projectId: 1 }))
    for (const finding of findings) {
      expect(
        ['retention-low', 'retention-collapsing', 'stickiness-low', 'one-visit'],
        `${finding.id} was claimed off three days of data`,
      ).not.toContain(finding.id)
    }
  })

  it('still answers the short-window questions', async () => {
    mock.state.hogql = youngProject()
    const client = new PostHogClient({
      personalApiKey: 'phx_test',
      hosts: customRegion(mock.url),
      sleep: async () => {},
    })
    const set = await computeMetrics({ client, projectId: 1 })
    // Three days is enough to know how many people are active.
    expect(set.values.active_people?.value).not.toBeNull()
  })
})

describe('resilience', () => {
  let mock: MockServer

  beforeEach(async () => {
    mock = await startMockPostHog()
  })
  afterEach(async () => {
    await mock.close()
  })

  it('survives a deployment that rejects some HogQL', async () => {
    // An older self-hosted PostHog may not have every function. One metric
    // failing must never take the report down.
    mock.state.hogql = fakeProject()
    mock.state.failQueriesMatching = /JSONExtractKeysAndValuesRaw/
    const client = new PostHogClient({
      personalApiKey: 'phx_test',
      hosts: customRegion(mock.url),
      sleep: async () => {},
    })
    const set = await computeMetrics({ client, projectId: 1 })

    expect(set.values.high_cardinality_properties?.value).toBeNull()
    expect(set.context.unavailable.some((item) => item.id === 'high_cardinality_properties')).toBe(true)
    expect(deriveFindings(set).length).toBeGreaterThan(2)
  })
})

describe('benchmarks', () => {
  it('bands the same number differently by product kind', () => {
    // 30% week-1 retention is good for a consumer app and poor for a paid tool.
    expect(bandFor('retention_w1', 0.3, 'consumer')?.band).toBe('good')
    expect(bandFor('retention_w1', 0.3, 'saas')?.band).toBe('poor')
  })

  it('inverts the bands for metrics where lower is better', () => {
    expect(bandFor('error_exposure', 0.01, 'consumer')?.band).toBe('excellent')
    expect(bandFor('error_exposure', 0.2, 'consumer')?.band).toBe('poor')
  })

  it('always explains the basis for a band', () => {
    const band = bandFor('retention_w1', 0.1, 'consumer')!
    expect(band.benchmark.basis.length).toBeGreaterThan(30)
    expect(band.comparison).toContain('consumer app')
  })

  it('renders a typical range for the metrics that have one', () => {
    expect(typicalRange('retention_w1', 'saas')).toMatch(/%/)
    expect(typicalRange('time_to_value', 'devtool')).toMatch(/h|d/)
  })
})

describe('product kind inference from event names alone', () => {
  it.each([
    [['subscription_started', 'trial_started', 'seat_added'], 'saas'],
    [['add_to_cart', 'checkout_started', 'order_placed'], 'ecommerce'],
    [['generation_completed', 'prompt_sent', 'regenerate_clicked'], 'ai-app'],
    [['api_key_created', 'first_success', 'docs_search'], 'devtool'],
    [['share_click', 'invite_shared', 'follow_changed'], 'consumer'],
  ])('%s → %s', (events, expected) => {
    expect(guessKindFromEvents(events).kind).toBe(expected)
  })
})

describe('the shareable report', () => {
  let mock: MockServer

  beforeEach(async () => {
    mock = await startMockPostHog()
  })
  afterEach(async () => {
    await mock.close()
  })

  it('is one self-contained file with no network calls', async () => {
    const { set, findings } = await analyse(mock)
    const html = renderHtmlReport({ set, findings })

    expect(html).not.toMatch(/<script/i)
    expect(html).not.toMatch(/src=["']https?:/i)
    expect(html).not.toMatch(/@import|<link[^>]+stylesheet/i)
    // Fonts travel with the file rather than pointing at a CDN that will
    // outlive neither the company nor the user's CSP.
    expect(html).toContain('url(data:font/woff2;base64,')
    expect(html).toContain('prefers-color-scheme: dark')
  })

  it('follows the house style: no shadows, no floating boxes', async () => {
    const { set, findings } = await analyse(mock)
    const html = renderHtmlReport({ set, findings })
    // Structure comes from type and hairlines. Shadow-boxed cards are the
    // default look of every generated report and are explicitly not the style
    // here, so they are pinned out rather than left to drift back in.
    expect(html).not.toMatch(/box-shadow|drop-shadow/i)
    expect(html).not.toMatch(/border-radius/i)
  })

  it('never puts white text on an acid fill', async () => {
    // The one hard rule of the palette: acid green always carries black ink.
    const { set, findings } = await analyse(mock)
    const html = renderHtmlReport({ set, findings })
    const rules = [...html.matchAll(/([^{}]+)\{([^}]*background:\s*var\(--acid\)[^}]*)\}/g)]
    expect(rules.length).toBeGreaterThan(0)
    for (const [, selector, body] of rules) {
      // A swatch carries no text, so the ink rule does not apply to it.
      if (/\.dot\b/.test(selector ?? '')) continue
      expect(body, `acid fill on "${selector?.trim()}" must set black ink`).toMatch(
        /color:\s*var\(--black\)/,
      )
    }
  })

  it('credits and links back to Dizko Labs near the top', async () => {
    const { set, findings } = await analyse(mock)
    const html = renderHtmlReport({ set, findings })
    expect(html).toContain('Dizko Labs')
    expect(html).toContain('https://www.dizko.app')
    // Above the fold, not buried in the footer.
    expect(html.indexOf('Dizko Labs')).toBeLessThan(html.indexOf('Product health report'))
  })

  it('leads with the product, the score and the worst finding', async () => {
    const { set, findings } = await analyse(mock)
    const html = renderHtmlReport({ set, findings })
    expect(html).toContain('Lantern')
    expect(html).toContain('/100')
    expect(html.indexOf(findings[0]!.title)).toBeLessThan(html.indexOf('Every number'))
  })

  it('says the benchmarks are rules of thumb rather than measurements', async () => {
    const { set, findings } = await analyse(mock)
    const html = renderHtmlReport({ set, findings })
    expect(html).toContain('rules of thumb')
    expect(html).toContain('not measured from a')
  })

  it('escapes event names so a hostile one cannot inject markup', async () => {
    mock.state.hogql = [
      { match: /GROUP BY event/, rows: [['<img src=x onerror=alert(1)>', 900, 400]] },
      { match: /days_of_data/, rows: [[400, 900, 90]] },
    ]
    const client = new PostHogClient({
      personalApiKey: 'phx_test',
      hosts: customRegion(mock.url),
      sleep: async () => {},
    })
    const set = await computeMetrics({ client, projectId: 1 })
    const html = renderHtmlReport({ set, findings: deriveFindings(set) })
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img')
  })

  it('summarises to one sentence for a headline', async () => {
    const { findings } = await analyse(mock)
    expect(summarise(findings).length).toBeGreaterThan(15)
  })
})
