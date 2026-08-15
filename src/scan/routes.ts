/**
 * Route discovery.
 *
 * Routes matter twice over: they are what `$pageview` breaks down by, and a
 * dynamic segment left un-normalised is the single most common way a PostHog
 * project fills with millions of one-off URLs. Everything here emits `:param`
 * form, and that same list becomes the `normalizeRoute` function in the
 * generated analytics module.
 */

import type { DetectedRoute, Framework } from '../types.js'
import { readIfSmall, relPath } from '../util/fs.js'

/** `[id]`, `[...slug]`, `$userId`, `:id` and `<int:pk>` all become `:param`. */
function normaliseSegment(segment: string): string {
  if (/^\[\[?\.{3}(.+?)\]?\]$/.test(segment)) return ':path*'
  if (/^\[(.+)\]$/.test(segment)) return `:${segment.slice(1, -1).replace(/\W/g, '')}`
  if (/^\$(.+)$/.test(segment)) return `:${segment.slice(1)}`
  if (/^<[^>]+>$/.test(segment)) {
    const inner = segment.slice(1, -1)
    const name = inner.includes(':') ? inner.split(':').pop() : inner
    return `:${(name ?? 'param').replace(/\W/g, '')}`
  }
  if (segment.startsWith(':')) return segment
  return segment
}

function normalisePath(path: string): string {
  const cleaned = path
    .split('/')
    .filter((segment) => segment && !/^\(.*\)$/.test(segment) && !segment.startsWith('@'))
    .map(normaliseSegment)
    .join('/')
  return `/${cleaned}`.replace(/\/+/g, '/').replace(/(.)\/$/, '$1')
}

function fileRoute(root: string, file: string, dirMarker: string, stripFile: RegExp): string | null {
  const rel = relPath(root, file)
  const index = rel.indexOf(dirMarker)
  if (index < 0) return null
  const tail = rel.slice(index + dirMarker.length)
  const withoutFile = tail.replace(stripFile, '')
  return normalisePath(withoutFile)
}

const IGNORED_ROUTE_FILES = /(_app|_document|_error|404|500|\+error|\+server|api\/)/

/**
 * Test, story and type files sit alongside pages in most repos. Treating
 * `ProfilePage.test.tsx` as a route is not only noise: those bogus paths flow
 * into the sensitive-route list and the generated route normaliser, so the
 * exclusion is load-bearing rather than cosmetic.
 */
const NON_ROUTE_FILES = /\.(test|spec|stories|story|d|config|types?|utils?|helpers?)\.[jt]sx?$/

export function detectRoutes(root: string, files: string[], frameworks: Framework[]): DetectedRoute[] {
  const routes = new Map<string, DetectedRoute>()
  const add = (path: string, file: string) => {
    if (!path || routes.has(path)) return
    routes.set(path, { path, file: relPath(root, file), role: roleForPath(path) })
  }

  // `src/pages/` is a file-based router in Next, Nuxt and Astro, and a plain
  // components directory in every Vite app ever generated. Reading it as routes
  // without checking the framework turns `src/pages/SettingsPage.tsx` into a
  // route called `/SettingsPage`, which then poisons the route normaliser and
  // the sensitive-route list downstream.
  const pagesIsRouter =
    frameworks.includes('nextjs') || frameworks.includes('nuxt') || frameworks.includes('astro')

  for (const file of files) {
    const rel = relPath(root, file)
    if (IGNORED_ROUTE_FILES.test(rel)) continue
    if (NON_ROUTE_FILES.test(rel)) continue

    // Next.js app router: app/dashboard/[id]/page.tsx → /dashboard/:id
    // The `(^|/)` matters: at the repo root the path is `app/dashboard/page.tsx`
    // with no leading slash, so a pattern anchored on `/app/` found only the
    // root page and silently returned a one-route app.
    if (/(^|\/)app\/.*page\.(tsx|jsx|ts|js)$/.test(rel)) {
      const path = fileRoute(root, file, 'app/', /\/?page\.(tsx|jsx|ts|js)$/)
      if (path) add(path, file)
      continue
    }
    // Next.js pages router
    if (frameworks.includes('nextjs') && (/\/pages\/.*\.(tsx|jsx)$/.test(rel) || /^pages\/.*\.(tsx|jsx)$/.test(rel))) {
      const path = fileRoute(root, file, 'pages/', /(\/index)?\.(tsx|jsx)$/)
      if (path) add(path, file)
      continue
    }
    // SvelteKit
    if (/\+page\.svelte$/.test(rel)) {
      const path = fileRoute(root, file, 'routes/', /\/?\+page\.svelte$/)
      if (path) add(path, file)
      continue
    }
    // Nuxt
    if (frameworks.includes('nuxt') && /\/pages\/.*\.vue$/.test(rel)) {
      const path = fileRoute(root, file, 'pages/', /(\/index)?\.vue$/)
      if (path) add(path, file)
      continue
    }
    // Astro
    if (pagesIsRouter && /\/pages\/.*\.(astro|mdx?)$/.test(rel)) {
      const path = fileRoute(root, file, 'pages/', /(\/index)?\.(astro|mdx?)$/)
      if (path) add(path, file)
      continue
    }
    // Remix flat routes: app/routes/dashboard.settings.tsx → /dashboard/settings
    if (frameworks.includes('remix') && /\/routes\/.*\.(tsx|jsx)$/.test(rel)) {
      const name = rel.split('/routes/')[1]?.replace(/\.(tsx|jsx)$/, '') ?? ''
      const path = normalisePath(name.replace(/^_index$/, '').split('.').join('/'))
      add(path, file)
      continue
    }
  }

  // Declared routers (React Router, Vue Router, Angular). These live in code
  // rather than in the filesystem, so the only way to see them is to read the
  // route table itself.
  for (const file of files) {
    if (!/\.(tsx|jsx|ts|js|vue)$/.test(file)) continue
    if (NON_ROUTE_FILES.test(file)) continue
    const content = readIfSmall(file)
    if (!content) continue
    if (!/(createBrowserRouter|<Route|RouteObject|routes\s*[:=]|RouterModule)/.test(content)) continue
    for (const match of content.matchAll(/<Route\s[^>]*path=["'`]([^"'`]+)["'`]/g)) {
      add(normalisePath(match[1] ?? ''), file)
    }
    for (const match of content.matchAll(/\bpath:\s*["'`]([^"'`]+)["'`]/g)) {
      const value = match[1] ?? ''
      if (value === '*' || value.startsWith('http')) continue
      add(normalisePath(value), file)
    }
  }

  return [...routes.values()]
    .filter((route) => {
      if (route.path.length >= 80) return false
      // Catch-alls carry no information and would normalise everything to '/*'.
      if (route.path === '/*' || route.path === '/') return route.path === '/'
      // A single PascalCase segment is a component name that leaked in from a
      // components directory, not a URL anyone ever visits.
      const segments = route.path.split('/').filter(Boolean)
      if (segments.length === 1 && /^[A-Z][a-zA-Z]*$/.test(segments[0]!)) return false
      return true
    })
    .sort((a, b) => a.path.localeCompare(b.path))
    .slice(0, 200)
}

/**
 * A coarse guess at what a page is for. Used to name suggested events and to
 * pick which routes belong in a funnel, so it only needs to be right about the
 * handful of paths that are the same across every product on earth.
 */
export function roleForPath(path: string): string | undefined {
  const lower = path.toLowerCase()
  if (lower === '/') return 'landing'
  if (/(sign-?up|register|join|create-account)/.test(lower)) return 'signup'
  if (/(sign-?in|login|log-?in|auth)/.test(lower)) return 'signin'
  if (/(onboard|welcome|getting-started|setup)/.test(lower)) return 'onboarding'
  if (/(pricing|plans|upgrade|billing|subscribe)/.test(lower)) return 'pricing'
  if (/(checkout|cart|payment|order)/.test(lower)) return 'checkout'
  if (/(dashboard|home|app|feed|overview)/.test(lower)) return 'core'
  if (/(settings|account|profile|preferences)/.test(lower)) return 'settings'
  if (/(search|explore|browse|discover)/.test(lower)) return 'discovery'
  if (/(blog|post|article|docs|guide|changelog)/.test(lower)) return 'content'
  if (/(invite|refer|share)/.test(lower)) return 'referral'
  return undefined
}

/**
 * Routes whose replay and autocapture must stay off. Getting this list wrong is
 * a privacy incident rather than a bug, so the match is deliberately broad: a
 * route is sensitive if any part of it looks like it shows someone's own data.
 */
export function sensitiveRoutes(routes: DetectedRoute[]): string[] {
  const patterns =
    /(admin|settings|account|billing|payment|checkout|message|inbox|dm|chat|profile|onboard|password|reset|verify|invite|team|member|user|kyc|upload|document|medical|health)/i
  const found = routes
    .map((route) => route.path)
    .filter((path) => patterns.test(path))
    // Trim to the prefix so `/settings/:tab` and `/settings/billing` collapse.
    .map((path) => {
      const segments = path.split('/').filter(Boolean)
      const firstStatic = segments.findIndex((segment) => segment.startsWith(':'))
      const keep = firstStatic === -1 ? segments : segments.slice(0, firstStatic)
      return `/${keep.join('/')}`
    })
  return [...new Set(found)].filter((path) => path !== '/').sort()
}
