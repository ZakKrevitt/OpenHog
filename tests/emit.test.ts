/**
 * The generated analytics module is the most important artefact OpenHog
 * produces, and every guard in it exists because its absence broke production
 * somewhere. These tests pin the guards so a future refactor of the template
 * cannot quietly drop one.
 */

import { describe, expect, it } from 'vitest'
import { emitAnalyticsModule, emitWiringSnippet } from '../src/emit/analyticsTs.js'
import { emitWalkthrough } from '../src/emit/walkthrough.js'
import type { TrackingPlan } from '../src/types.js'

const plan: TrackingPlan = {
  version: 1,
  generatedAt: '2026-08-15T00:00:00.000Z',
  generatedBy: 'test',
  product: { name: 'Lantern', description: 'Find live music near you', kind: 'consumer', surfaces: ['web'] },
  events: [
    { name: 'signup_completed', description: 'An account exists', stage: 'activation', properties: [], emitted: true, sources: ['src/auth.ts:12'] },
    { name: 'gig_detail_opened', description: 'A gig was opened', stage: 'engagement', properties: [], emitted: true, sources: ['src/Gig.tsx:40'] },
    { name: 'purchase_completed', description: 'Money changed hands', stage: 'conversion', properties: [], emitted: false, sources: [], suggestedLocations: ['Your Stripe webhook handler.'] },
  ],
  roles: { page_view: '$pageview', signup_completed: 'signup_completed' },
  identity: { distinctIdSource: 'device id', sensitiveRoutes: ['/settings', '/messages'] },
  packs: ['core'],
  routes: ['/', '/gigs/:id', '/artists/:slug'],
}

describe('the generated analytics module', () => {
  const source = emitAnalyticsModule({
    plan,
    publicKeyEnv: 'VITE_PUBLIC_POSTHOG_KEY',
    ingestHost: 'https://us.i.posthog.com',
    envStyle: 'vite',
  })

  it('types the event names from the plan', () => {
    expect(source).toContain("'signup_completed',")
    expect(source).toContain('export type EventName = (typeof EVENT_NAMES)[number]')
  })

  it('only types events the code emits, not the aspirational ones', () => {
    expect(source).not.toContain("'purchase_completed',")
  })

  it('sends $pageview by hand instead of trusting history_change', () => {
    // history_change captures on history changes only, so a full page load sent
    // $pageleave with no matching $pageview and Web Analytics read zero.
    expect(source).toContain('capture_pageview: false')
    expect(source).toContain("capture('$pageview')")
    expect(source).not.toContain("capture_pageview: 'history_change'")
  })

  it('keeps $pageleave, which bounce rate and session duration depend on', () => {
    expect(source).toContain('capture_pageleave: true')
  })

  it('preserves the origin when normalising URLs', () => {
    // Stripping the origin attributes every visit to no domain at all, which
    // reads as zero visitors in Web Analytics while events flow normally.
    expect(source).toContain('url.origin + route')
  })

  it('catches replay up to the landing route after the dynamic import resolves', () => {
    const initBody = source.slice(source.indexOf('export function initAnalytics'))
    expect(initBody).toContain('syncRoute(window.location.pathname)')
  })

  it('turns off everything that would report an interaction nobody named', () => {
    for (const flag of [
      'autocapture: false',
      'capture_heatmaps: false',
      'capture_dead_clicks: false',
      'rageclick: false',
      'disable_web_experiments: true',
    ]) {
      expect(source, `${flag} must be set`).toContain(flag)
    }
  })

  it('bounds the pre-init queue so analytics can never leak memory', () => {
    expect(source).toContain('MAX_QUEUED_EVENTS')
    expect(source).toContain('queue.shift()')
  })

  it('generates a route normaliser from the real routes', () => {
    expect(source).toContain("return '/gigs/:id'")
    expect(source).toContain("return '/artists/:slug'")
  })

  it('carries the sensitive routes through to replay gating', () => {
    expect(source).toContain("'/settings',")
    expect(source).toContain("'/messages',")
    expect(source).toContain('isSensitiveRoute')
  })

  it('is inert without a key', () => {
    expect(source).toContain('if (!key || typeof window === \'undefined\')')
  })

  it('never throws into the host application', () => {
    // Every capture path is wrapped. A dropped event is always cheaper than a
    // broken render.
    const captures = source.split('capture(').length - 1
    expect(captures).toBeGreaterThan(1)
    expect(source).toContain('} catch {')
  })

  it('uses the right env accessor per framework', () => {
    expect(source).toContain('import.meta.env.VITE_PUBLIC_POSTHOG_KEY')
    const nextSource = emitAnalyticsModule({
      plan,
      publicKeyEnv: 'NEXT_PUBLIC_POSTHOG_KEY',
      ingestHost: 'https://us.i.posthog.com',
      envStyle: 'next',
    })
    expect(nextSource).toContain('process.env.NEXT_PUBLIC_POSTHOG_KEY')
  })

  it('marks the block it regenerates so hand edits below it survive', () => {
    expect(source).toContain('/* --- openhog:events:start --- */')
    expect(source).toContain('/* --- openhog:events:end --- */')
  })
})

describe('wiring snippets', () => {
  it('uses the router hook each framework actually has', () => {
    expect(emitWiringSnippet('nextjs', './analytics')).toContain('usePathname')
    expect(emitWiringSnippet('react', './analytics')).toContain('useLocation')
    expect(emitWiringSnippet('sveltekit', './analytics')).toContain('$app/stores')
    expect(emitWiringSnippet('vue', './analytics')).toContain('useRoute')
  })

  it('falls back to something that still works for an unknown framework', () => {
    expect(emitWiringSnippet('mystery', './analytics')).toContain('initAnalytics()')
  })
})

describe('the walkthrough', () => {
  const markdown = emitWalkthrough({
    plan,
    dashboards: [
      {
        key: 'north-star',
        name: '1. North Star - activation & retention',
        description: 'The daily check.',
        question: 'Are we growing?',
        tiles: [
          {
            key: 'wau',
            name: 'Weekly active people',
            description: 'Unique people in 7 days.',
            interpretation: 'A flat line with rising signups is a retention problem.',
            requires: ['$pageview'],
            charts: ['$pageview'],
            width: 'third',
            query: {},
          },
        ],
      },
    ],
    created: [
      {
        id: 7,
        name: '1. North Star - activation & retention',
        url: 'https://us.posthog.com/project/1/dashboard/7',
        tiles: [],
        skipped: [],
      },
    ],
    skipped: [{ dashboard: 'Consumer - viral loops', tile: 'Shares', reason: 'no share event' }],
    projectUrl: 'https://us.posthog.com/project/1',
    analyticsModulePath: 'src/analytics.ts',
  })

  it('leads with a routine somebody can actually follow', () => {
    expect(markdown).toContain('The 5-minute version')
  })

  it('explains what each chart means AND what to do about it', () => {
    expect(markdown).toContain('Weekly active people')
    expect(markdown).toContain('How to read it')
    expect(markdown).toContain('retention problem')
  })

  it('links the real dashboard', () => {
    expect(markdown).toContain('https://us.posthog.com/project/1/dashboard/7')
  })

  it('says what is missing and what it would unlock', () => {
    expect(markdown).toContain('What is missing')
    expect(markdown).toContain('purchase_completed')
    expect(markdown).toContain('Consumer - viral loops')
  })

  it('publishes the role map so a wrong guess can be corrected', () => {
    expect(markdown).toContain('How the dashboards found your events')
    expect(markdown).toContain('tracking-plan.json')
  })

  it('documents the production traps and the privacy posture', () => {
    expect(markdown).toContain('only appear in production')
    expect(markdown).toContain('script-src')
    expect(markdown).toContain('Autocapture is off')
    expect(markdown).toContain('/settings')
  })

  it('never emits three blank lines in a row', () => {
    expect(markdown).not.toMatch(/\n{3,}/)
  })
})
