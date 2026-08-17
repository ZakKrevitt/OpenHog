/**
 * Does this work on somebody else's naming convention?
 *
 * OpenHog is installed by people whose event taxonomy nobody has seen. Matching
 * raw strings against English snake_case patterns resolved 0 of 9 key roles for
 * Segment-style Title Case - which is one of the most common conventions in
 * PostHog projects - and 0 for kebab-case, German and Spanish. That is a tool
 * that produces an empty report for a large share of the people who try it.
 *
 * These cases pin the coverage so a future pattern edit cannot quietly lose it.
 */

import { describe, expect, it } from 'vitest'
import { resolveRoles, matchableName } from '../src/plan/roles.js'
import type { PlanEvent } from '../src/types.js'

function rolesFor(names: string[]): Record<string, string | null> {
  const events: PlanEvent[] = names.map((name) => ({
    name,
    description: '',
    stage: 'engagement',
    properties: [],
    emitted: true,
    sources: [],
  }))
  const resolved = resolveRoles(events)
  return Object.fromEntries(Object.entries(resolved).map(([role, r]) => [role, r.event]))
}

describe('name normalisation', () => {
  it.each([
    ['User Signed Up', 'user_signed_up'],
    ['userSignedUp', 'user_signed_up'],
    ['user-signed-up', 'user_signed_up'],
    ['user.signed_up', 'user_signed_up'],
    ['user:signed up', 'user_signed_up'],
    ['APIKeyCreated', 'api_key_created'],
    ['already_snake_case', 'already_snake_case'],
  ])('%s becomes %s', (input, expected) => {
    expect(matchableName(input)).toBe(expected)
  })
})

describe('Segment-style Title Case, the most common PostHog convention', () => {
  const roles = rolesFor([
    'User Signed Up',
    'Order Completed',
    'Product Viewed',
    'Cart Checkout Started',
    'Search Performed',
    'Item Shared',
    'Error Occurred',
  ])

  it('resolves signup', () => expect(roles.signup_completed).toBe('User Signed Up'))
  it('resolves purchase', () => expect(roles.purchase).toBe('Order Completed'))
  it('resolves content opened', () => expect(roles.content_opened).toBe('Product Viewed'))
  it('resolves checkout', () => expect(roles.checkout_started).toBe('Cart Checkout Started'))
  it('resolves search', () => expect(roles.search).toBe('Search Performed'))
  it('resolves share', () => expect(roles.share).toBe('Item Shared'))
  it('resolves error', () => expect(roles.error).toBe('Error Occurred'))

  it('keeps the original name, since that is what gets queried', () => {
    // Normalisation is for matching only. Querying `user_signed_up` against a
    // project that sends `User Signed Up` would return nothing.
    expect(roles.signup_completed).toBe('User Signed Up')
    expect(roles.signup_completed).not.toBe('user_signed_up')
  })
})

describe('other separators', () => {
  it('handles camelCase', () => {
    const roles = rolesFor(['userSignedUp', 'orderCompleted', 'productViewed', 'searchPerformed'])
    expect(roles.signup_completed).toBe('userSignedUp')
    expect(roles.purchase).toBe('orderCompleted')
    expect(roles.search).toBe('searchPerformed')
  })

  it('handles kebab-case', () => {
    const roles = rolesFor(['user-signed-up', 'order-completed', 'product-viewed'])
    expect(roles.signup_completed).toBe('user-signed-up')
    expect(roles.purchase).toBe('order-completed')
  })

  it('handles dot notation', () => {
    const roles = rolesFor(['user.signed_up', 'order.completed', 'product.viewed'])
    expect(roles.signup_completed).toBe('user.signed_up')
    expect(roles.purchase).toBe('order.completed')
  })
})

describe('projects not named in English', () => {
  it('resolves German', () => {
    const roles = rolesFor([
      'nutzer_registriert',
      'bestellung_abgeschlossen',
      'suche_gestartet',
      'fehler_aufgetreten',
    ])
    expect(roles.signup_completed).toBe('nutzer_registriert')
    expect(roles.purchase).toBe('bestellung_abgeschlossen')
    expect(roles.search).toBe('suche_gestartet')
    expect(roles.error).toBe('fehler_aufgetreten')
  })

  it('resolves Spanish', () => {
    const roles = rolesFor(['usuario_registrado', 'compra_completada', 'busqueda_realizada'])
    expect(roles.signup_completed).toBe('usuario_registrado')
    expect(roles.purchase).toBe('compra_completada')
    expect(roles.search).toBe('busqueda_realizada')
  })

  it('does not mistake a German failure for a success', () => {
    const roles = rolesFor(['zahlung_fehlgeschlagen', 'bestellung_abgeschlossen'])
    expect(roles.purchase).toBe('bestellung_abgeschlossen')
    expect(roles.error).toBe('zahlung_fehlgeschlagen')
  })
})

describe('the honest limit', () => {
  it('leaves domain jargon unmapped rather than guessing from the name', () => {
    // `kyc_passed` is a fintech signup and `level_completed` is a game's core
    // action, and no vocabulary list will ever cover either. Leaving them
    // unmapped is correct: the agent path and behavioural inference exist for
    // exactly this, and a wrong guess would make findings lie.
    const roles = rolesFor(['kyc_passed', 'first_transfer_sent', 'card_issued'])
    expect(roles.signup_completed).toBeNull()
  })
})
