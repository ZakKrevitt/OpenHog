import { describe, expect, it } from 'vitest'
import { resolveRoles, roleMap } from '../src/plan/roles.js'
import type { PlanEvent } from '../src/types.js'

function events(...names: string[]): PlanEvent[] {
  return names.map((name) => ({
    name,
    description: '',
    stage: 'engagement' as const,
    properties: [],
    emitted: true,
    sources: [],
  }))
}

describe('role resolution', () => {
  it('maps a signup event whatever the codebase calls it', () => {
    for (const name of ['signup_completed', 'user_registered', 'account_created', 'registration_success']) {
      const roles = resolveRoles(events(name))
      expect(roles.signup_completed.event, `${name} should resolve signup_completed`).toBe(name)
    }
  })

  it('never resolves a role to an event that is only suggested', () => {
    // This is the whole "no invented events" guarantee. A suggested event
    // backing a role would put a chart of a nonexistent name on a dashboard.
    const suggested: PlanEvent[] = [
      { name: 'purchase_completed', description: '', stage: 'conversion', properties: [], emitted: false, sources: [] },
    ]
    const roles = resolveRoles(suggested)
    expect(roles.purchase.event).toBeNull()
  })

  it('does not confuse a started event with a completed one', () => {
    const roles = resolveRoles(events('signup_started', 'signup_completed'))
    expect(roles.signup_started.event).toBe('signup_started')
    expect(roles.signup_completed.event).toBe('signup_completed')
  })

  it('excludes failures from the success role', () => {
    const roles = resolveRoles(events('purchase_failed', 'purchase_completed'))
    expect(roles.purchase.event).toBe('purchase_completed')
  })

  it('prefers a precise match over a loose one', () => {
    // `_click$` matches half the events in a typical app; it must not beat an
    // explicit detail-opened event just because the name is shorter.
    const roles = resolveRoles(events('rsvp_click', 'event_detail_opened'))
    expect(roles.content_opened.event).toBe('event_detail_opened')
  })

  it('still resolves from a loose match when nothing precise exists', () => {
    const roles = resolveRoles(events('rsvp_click'))
    expect(roles.content_opened.event).toBe('rsvp_click')
  })

  it('prefers a real search event over a filter event', () => {
    const roles = resolveRoles(events('filter_apply', 'search_submit'))
    expect(roles.search.event).toBe('search_submit')
  })

  it('does not treat opening the saved list as saving', () => {
    const roles = resolveRoles(events('saved_open', 'save_toggle'))
    expect(roles.save.event).toBe('save_toggle')
  })

  it('always has a pageview role, because the generated module sends one', () => {
    const roles = resolveRoles([])
    expect(roles.page_view.event).toBe('$pageview')
  })

  it('reports the runners-up so a wrong guess can be corrected', () => {
    const roles = resolveRoles(events('share_click', 'share_completed', 'item_shared'))
    expect(roles.share.candidates.length).toBeGreaterThan(1)
  })

  it('produces a flat map with only the resolved roles', () => {
    const map = roleMap(resolveRoles(events('signup_completed')))
    expect(map.signup_completed).toBe('signup_completed')
    expect(map.purchase).toBeUndefined()
  })
})
