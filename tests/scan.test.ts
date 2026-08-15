import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { scan } from '../src/scan/index.js'
import { guessProductKind, isScaffoldTitle } from '../src/scan/product.js'
import { sensitiveRoutes } from '../src/scan/routes.js'
import { BARE_APP, NEXT_SAAS_APP, VITE_CONSUMER_APP, makeFixture, type Fixture } from './fixtures.js'

describe('scanning a Vite consumer app', () => {
  let fixture: Fixture
  let result: ReturnType<typeof scan>

  beforeAll(() => {
    fixture = makeFixture(VITE_CONSUMER_APP)
    result = scan(fixture.root)
  })
  afterAll(() => fixture.cleanup())

  it('reads the product name and description from the README rather than the folder', () => {
    expect(result.product.name).toBe('Lantern')
    expect(result.product.description).toContain('live music')
  })

  it('keeps every source it drew the description from, for the record', () => {
    expect(result.product.evidence.some((line) => line.startsWith('README title'))).toBe(true)
    expect(result.product.evidence.some((line) => line.startsWith('HTML title'))).toBe(true)
  })

  it('detects the framework and surface', () => {
    expect(result.frameworks).toContain('react')
    expect(result.surfaces).toEqual(['web'])
  })

  it('finds events declared in a name array, not just at call sites', () => {
    const names = result.existingEvents.map((event) => event.name)
    expect(names).toContain('signup_completed')
    expect(names).toContain('gig_detail_opened')
    expect(names).toContain('save_clicked')
  })

  it('records where each event is emitted from', () => {
    const save = result.existingEvents.find((event) => event.name === 'save_clicked')
    expect(save).toBeDefined()
    expect(save!.file).toMatch(/\.(ts|tsx)$/)
    expect(save!.line).toBeGreaterThan(0)
  })

  it('normalises dynamic route segments to :params', () => {
    const paths = result.routes.map((route) => route.path)
    expect(paths).toContain('/gigs/:id')
    expect(paths).toContain('/artists/:slug')
  })

  it('does NOT treat src/pages as a router in a plain Vite app', () => {
    // `src/pages/SettingsPage.tsx` is a component here, not a route. Reading it
    // as one produced `/SettingsPage`, which then leaked into the generated
    // route normaliser and the sensitive-route list.
    const paths = result.routes.map((route) => route.path)
    expect(paths).not.toContain('/SettingsPage')
    expect(paths.some((path) => path.includes('.test'))).toBe(false)
  })

  it('flags routes that show personal data as sensitive', () => {
    const sensitive = sensitiveRoutes(result.routes)
    expect(sensitive).toContain('/settings')
    expect(sensitive).toContain('/messages')
    // The prefix, not the parameterised leaf: /messages covers /messages/:id.
    expect(sensitive).not.toContain('/messages/:threadId')
  })

  it('detects the features that decide which events are worth suggesting', () => {
    expect(result.signals.hasAuth).toBe(true)
    expect(result.signals.hasSharing).toBe(true)
  })

  it('finds the CSP file so the doctor can inspect it', () => {
    expect(result.cspFiles).toContain('vercel.json')
  })

  it('picks an entry file to wire init into', () => {
    expect(result.entryFile).toBe('src/main.tsx')
  })
})

describe('scanning a Next.js SaaS', () => {
  let fixture: Fixture
  let result: ReturnType<typeof scan>

  beforeAll(() => {
    fixture = makeFixture(NEXT_SAAS_APP)
    result = scan(fixture.root)
  })
  afterAll(() => fixture.cleanup())

  it('detects Next and drops the redundant react framework', () => {
    expect(result.frameworks).toContain('nextjs')
    expect(result.frameworks).not.toContain('react')
  })

  it('reads app-router routes out of the filesystem', () => {
    const paths = result.routes.map((route) => route.path)
    expect(paths).toContain('/')
    expect(paths).toContain('/dashboard')
    expect(paths).toContain('/expenses/:id')
    expect(paths).toContain('/settings/billing')
  })

  it('assigns roles to well-known paths', () => {
    expect(result.routes.find((route) => route.path === '/pricing')?.role).toBe('pricing')
    expect(result.routes.find((route) => route.path === '/dashboard')?.role).toBe('core')
  })

  it('finds posthog.capture call sites', () => {
    const names = result.existingEvents.map((event) => event.name)
    expect(names).toContain('subscription_started')
    expect(names).toContain('trial_started')
  })

  it('classifies it as saas because of the team and billing vocabulary', () => {
    const guess = guessProductKind(
      result.signals,
      [result.product.name, result.product.description, ...result.product.evidence].join(' '),
    )
    expect(guess.kind).toBe('saas')
  })
})

describe('scanning a bare scaffolded repo', () => {
  let fixture: Fixture

  beforeAll(() => {
    fixture = makeFixture(BARE_APP)
  })
  afterAll(() => fixture.cleanup())

  it('refuses to name the product after the scaffold README', () => {
    const result = scan(fixture.root)
    expect(result.product.name).not.toBe('React + TypeScript + Vite')
    expect(result.product.evidence.some((line) => line.includes('React + TypeScript + Vite'))).toBe(false)
  })

  it('finds no events and does not invent any', () => {
    const result = scan(fixture.root)
    expect(result.existingEvents).toHaveLength(0)
  })
})

describe('scaffold title detection', () => {
  it.each([
    'React + TypeScript + Vite',
    'my-app',
    'Getting Started with Create React App',
    'Next.js App',
    'Project',
  ])('rejects %s', (title) => {
    expect(isScaffoldTitle(title)).toBe(true)
  })

  it.each(['Lantern', 'Ledgerly', 'Dizko', 'Postgres Explorer'])('accepts %s', (title) => {
    expect(isScaffoldTitle(title)).toBe(false)
  })
})
