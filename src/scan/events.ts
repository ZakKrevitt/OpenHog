/**
 * Find analytics events the repo already emits.
 *
 * This is what makes the "no invented events" guarantee enforceable. A tile is
 * only built if every event it needs turned up here, so a dashboard can never
 * reference a name the code does not send. That is the exact failure mode of
 * every hosted setup wizard: it writes a beautiful dashboard against
 * `user_signed_up` while the app emits `signup_complete`, and the customer sees
 * six empty charts and concludes the tool is broken.
 */

import type { DetectedEventCall } from '../types.js'
import { readIfSmall, relPath } from '../util/fs.js'

/**
 * Each pattern must capture the event name in group 1. Kept as an explicit list
 * rather than one mega-regex so an unmatched library is a one-line addition.
 */
const CALL_PATTERNS: { via: string; pattern: RegExp }[] = [
  { via: 'posthog.capture', pattern: /posthog\s*\.\s*capture\s*\(\s*['"`]([^'"`]+)['"`]/g },
  { via: 'posthog.capture', pattern: /capturePostHogEvent\s*\(\s*['"`]([^'"`]+)['"`]/g },
  { via: 'analytics.track', pattern: /analytics\s*\.\s*track\s*\(\s*['"`]([^'"`]+)['"`]/g },
  { via: 'trackEvent', pattern: /\btrackEvent\s*\(\s*['"`]([^'"`]+)['"`]/g },
  { via: 'track', pattern: /(?<![.\w])track\s*\(\s*['"`]([^'"`]+)['"`]/g },
  { via: 'logEvent', pattern: /\blogEvent\s*\(\s*['"`]([^'"`]+)['"`]/g },
  { via: 'mixpanel.track', pattern: /mixpanel\s*\.\s*track\s*\(\s*['"`]([^'"`]+)['"`]/g },
  { via: 'amplitude', pattern: /amplitude\s*\.\s*(?:track|logEvent)\s*\(\s*['"`]([^'"`]+)['"`]/g },
  { via: 'segment', pattern: /segment\s*\.\s*track\s*\(\s*['"`]([^'"`]+)['"`]/g },
  { via: 'gtag', pattern: /gtag\s*\(\s*['"`]event['"`]\s*,\s*['"`]([^'"`]+)['"`]/g },
  { via: 'plausible', pattern: /plausible\s*\(\s*['"`]([^'"`]+)['"`]/g },
  { via: 'va.track', pattern: /\bva\s*\.\s*track\s*\(\s*['"`]([^'"`]+)['"`]/g },
  // Python / Swift / Kotlin server- and client-side SDKs.
  { via: 'posthog.capture (py)', pattern: /posthog\.capture\([^,]+,\s*['"]([^'"]+)['"]/g },
  { via: 'PostHogSDK.capture', pattern: /PostHogSDK\.shared\.capture\(\s*"([^"]+)"/g },
  { via: 'capture (swift)', pattern: /\.capture\(\s*"([^"]+)"/g },
]

/**
 * `export const ANALYTICS_EVENT_NAMES = [...] as const` and friends. A repo that
 * keeps its event vocabulary in one array is the best case for us, because the
 * call sites then pass a variable and the call patterns above find nothing.
 *
 * The identifier must end in NAMES/EVENTS, not merely contain "event". Matching
 * anything event-shaped swallows domain vocabulary: `EVENT_TYPES = ['art',
 * 'music']` in an events product turned every genre into an analytics event.
 */
const NAME_ARRAY =
  /(?:const|let|var)\s+(\w*(?:ANALYTICS|TRACK|EVENT|Analytics|Track|Event)\w*(?:_?NAMES?|Names?)|\w*(?:ANALYTICS|Analytics)_?(?:EVENTS?|Events?))\s*(?::[^=]+)?=\s*\[([\s\S]{0,20000}?)\]\s*(?:as const)?/g

const PLAUSIBLE_EVENT_NAME = /^[a-z][a-z0-9]*(?:[_.-][a-z0-9]+){0,5}$/

/** Reject the strings that are obviously not event names. */
function isPlausibleEventName(name: string): boolean {
  if (name.length < 3 || name.length > 60) return false
  if (name.startsWith('$')) return false
  if (/^https?:/.test(name)) return false
  if (name.includes(' ')) return false
  if (name.includes('/')) return false
  return PLAUSIBLE_EVENT_NAME.test(name)
}

function lineNumber(content: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < content.length; i += 1) {
    if (content[i] === '\n') line += 1
  }
  return line
}

export function detectEventCalls(root: string, files: string[]): DetectedEventCall[] {
  const found = new Map<string, DetectedEventCall>()

  for (const file of files) {
    const content = readIfSmall(file)
    if (!content) continue
    // Cheap pre-filter: most files mention none of these words at all.
    if (!/(capture|track|logEvent|gtag|plausible|EVENT_NAMES|analytics)/i.test(content)) continue
    const rel = relPath(root, file)

    for (const { via, pattern } of CALL_PATTERNS) {
      pattern.lastIndex = 0
      for (const match of content.matchAll(pattern)) {
        const name = match[1]
        if (!name || !isPlausibleEventName(name)) continue
        const key = `${name}`
        if (found.has(key)) continue
        found.set(key, { name, file: rel, line: lineNumber(content, match.index ?? 0), via })
      }
    }

    NAME_ARRAY.lastIndex = 0
    for (const match of content.matchAll(NAME_ARRAY)) {
      const body = match[2] ?? ''
      const declaredAt = lineNumber(content, match.index ?? 0)
      for (const literal of body.matchAll(/['"`]([^'"`\n]+)['"`]/g)) {
        const name = literal[1]
        if (!name || !isPlausibleEventName(name)) continue
        if (found.has(name)) continue
        found.set(name, { name, file: rel, line: declaredAt, via: `${match[1] ?? 'event array'}` })
      }
    }
  }

  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** Analytics libraries present in package.json or imported anywhere. */
export function detectAnalyticsLibraries(files: string[]): string[] {
  const libraries = new Set<string>()
  const markers: [RegExp, string][] = [
    [/posthog-js|posthog-node|posthog_python|PostHog\b/, 'posthog'],
    [/@vercel\/analytics/, 'vercel-analytics'],
    [/mixpanel/, 'mixpanel'],
    [/@amplitude|amplitude-js/, 'amplitude'],
    [/@segment|analytics-node/, 'segment'],
    [/plausible/, 'plausible'],
    [/gtag|googletagmanager|react-ga/, 'google-analytics'],
    [/@sentry/, 'sentry'],
    [/heap\.io|heapanalytics/, 'heap'],
  ]
  for (const file of files.slice(0, 4000)) {
    const content = readIfSmall(file, 200 * 1024)
    if (!content) continue
    for (const [pattern, name] of markers) {
      if (pattern.test(content)) libraries.add(name)
    }
  }
  return [...libraries]
}
