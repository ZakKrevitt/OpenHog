/**
 * `openhog doctor` — why is nothing arriving?
 *
 * Every check here encodes a failure that is invisible in development. Dev
 * serves no CSP header, the unit suite never fetches a third-party asset, and
 * an ad blocker is not installed in CI, so the whole class of PostHog problems
 * ships green and then reads zero in production.
 *
 * The checks are ordered the way you would debug it by hand: is it configured,
 * can the browser load the script, can the browser reach ingest, did anything
 * arrive, and is what arrived the right shape.
 */

import { join } from 'node:path'
import type { OpenHogConfig, ScanResult, TrackingPlan } from '../types.js'
import { readIfSmall, exists } from '../util/fs.js'
import { PostHogClient, PostHogError } from '../posthog/client.js'

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip'

export interface CheckResult {
  name: string
  status: CheckStatus
  message: string
  /** What to do about it. Always present on warn and fail. */
  fix?: string
  /** Documentation anchor for the long explanation. */
  docs?: string
}

export interface DoctorContext {
  root: string
  config: OpenHogConfig | null
  plan: TrackingPlan | null
  scan: ScanResult | null
  client: PostHogClient | null
  projectId?: number
  publicKey?: string
  /** Skip the live round-trip, which takes ~30s. */
  offline?: boolean
  onProgress?: (message: string) => void
}

// ---------------------------------------------------------------------------
// Static checks
// ---------------------------------------------------------------------------

/** Env var present in any of the usual dotenv files, or in the environment. */
function findEnvValue(root: string, name: string): { value: string; where: string } | null {
  if (process.env[name]) return { value: process.env[name]!, where: 'process environment' }
  const candidates = [
    '.env',
    '.env.local',
    '.env.production',
    '.env.production.local',
    'web/.env',
    'web/.env.local',
    'apps/web/.env.local',
  ]
  for (const candidate of candidates) {
    const content = readIfSmall(join(root, candidate))
    if (!content) continue
    const match = content.match(new RegExp(`^\\s*${name}\\s*=\\s*(.+)$`, 'm'))
    if (match?.[1]) {
      return { value: match[1].trim().replace(/^["']|["']$/g, ''), where: candidate }
    }
  }
  return null
}

export function checkPublicKey(context: DoctorContext): CheckResult {
  const name = context.config?.posthog.publicKeyEnv ?? 'VITE_PUBLIC_POSTHOG_KEY'
  const found = findEnvValue(context.root, name)
  if (!found) {
    return {
      name: 'Project key',
      status: 'fail',
      message: `${name} is not set anywhere OpenHog can see.`,
      fix: `Add ${name}=phc_... to your .env file and to your hosting provider's environment variables. Without it the SDK is inert by design, which looks exactly like "analytics is broken".`,
    }
  }
  if (!found.value.startsWith('phc_')) {
    return {
      name: 'Project key',
      status: 'fail',
      message: `${name} is set in ${found.where} but does not start with phc_.`,
      fix: 'A personal API key (phx_) cannot be used by the browser SDK. Copy the Project API key from PostHog → Settings → Project.',
    }
  }
  return {
    name: 'Project key',
    status: 'pass',
    message: `${name} found in ${found.where}.`,
  }
}

/**
 * Pull candidate CSP strings out of a config file.
 *
 * A CSP lives inside a quoted string in vercel.json, inside a template literal
 * in next.config.js, and bare on a line in `_headers` or nginx.conf. Extracting
 * quoted runs and whole lines covers all three without needing a parser per
 * format.
 */
function extractPolicies(content: string): string[] {
  const candidates: string[] = []
  for (const pattern of [/"([^"]{30,})"/g, /'([^']{30,})'/g, /`([^`]{30,})`/g]) {
    for (const match of content.matchAll(pattern)) {
      if (match[1]) candidates.push(match[1])
    }
  }
  for (const line of content.split('\n')) {
    if (line.length > 30) candidates.push(line)
  }

  // A real policy declares at least two directives. Without this floor, the
  // single-quote extractor happily returns the text *between* two `'self'`
  // tokens — a fragment like "…posthog.com; connect-src " that reads as a
  // policy whose connect-src is empty, and reports a passing CSP as broken.
  return candidates.filter((candidate) => {
    const directives = candidate.match(/(?:^|;)\s*[a-z][a-z-]*-src\s/g) ?? []
    return directives.length >= 2
  })
}

/**
 * Read one directive out of a policy. Returns null when the directive is absent
 * (which is meaningfully different from present-but-empty).
 *
 * The value must be allowed to contain single quotes: `'self'`, `'none'` and
 * `'unsafe-inline'` are ordinary CSP syntax, and excluding them truncated every
 * directive to the empty string, which made the whole check silently pass.
 */
function cspDirective(policy: string, name: string): string | null {
  const match = policy.match(new RegExp(`(?:^|;)\\s*${name}\\s+([^;"]*)`))
  return match?.[1]?.trim() ?? null
}

/**
 * The CSP check. Directives are separate allowlists, so a host reachable under
 * `connect-src` is NOT thereby loadable as a script. That half-allowed state is
 * what silently disables session replay: ingest answers, the recorder bundle is
 * blocked, and `$recording_status` sticks at `lazy_loading` forever.
 */
export function checkContentSecurityPolicy(context: DoctorContext): CheckResult {
  const files = context.scan?.cspFiles ?? []
  if (!files.length) {
    return {
      name: 'Content-Security-Policy',
      status: 'skip',
      message: 'No CSP found in the repo. If you set one at the CDN or proxy instead, check it by hand.',
      fix: 'PostHog needs its ingest host in connect-src AND its asset host in script-src.',
    }
  }

  const ingestHost = context.config?.posthog.ingestHost ?? 'https://us.i.posthog.com'
  const assetHost = context.config?.posthog.assetHost ?? 'https://us-assets.i.posthog.com'
  const problems: string[] = []
  let inspectedAny = false

  for (const file of files) {
    const content = readIfSmall(join(context.root, file))
    if (!content) continue

    for (const policy of extractPolicies(content)) {
      const connectSrc = cspDirective(policy, 'connect-src')
      const scriptSrc = cspDirective(policy, 'script-src')
      if (connectSrc === null && scriptSrc === null) continue
      inspectedAny = true

      if (connectSrc !== null && !connectSrc.includes(new URL(ingestHost).host)) {
        problems.push(`${file}: connect-src is missing ${ingestHost} — no events can be sent at all.`)
      }
      if (scriptSrc !== null && !scriptSrc.includes(new URL(assetHost).host)) {
        problems.push(
          `${file}: script-src is missing ${assetHost} — events will flow but session replay can never load its recorder.`,
        )
      }
      if (connectSrc !== null && !connectSrc.includes(new URL(assetHost).host)) {
        problems.push(`${file}: connect-src is missing ${assetHost} — replay and toolbar assets are blocked.`)
      }
    }
  }

  if (!inspectedAny) {
    return {
      name: 'Content-Security-Policy',
      status: 'skip',
      message: `Found ${files.join(', ')} but could not read a policy out of it. Check by hand.`,
      fix: `connect-src needs ${ingestHost} and ${assetHost}; script-src needs ${assetHost}.`,
    }
  }

  if (!problems.length) {
    return {
      name: 'Content-Security-Policy',
      status: 'pass',
      message: `PostHog hosts are allowed in ${files.join(', ')}.`,
    }
  }
  return {
    name: 'Content-Security-Policy',
    status: 'fail',
    message: problems.join('\n    '),
    fix: `Add to your CSP:\n      connect-src ... ${ingestHost} ${assetHost}\n      script-src  ... ${assetHost}\n    Dev serves no CSP header, so this failure only ever appears in production.`,
    docs: 'TRAPS.md#csp',
  }
}

/** Read the analytics module for the three client-side traps. */
export function checkClientConfiguration(context: DoctorContext): CheckResult[] {
  const modulePath = context.config?.paths?.analyticsModule
  const content = modulePath ? readIfSmall(join(context.root, modulePath)) : null

  if (!content) {
    // Fall back to any file that initialises posthog.
    return [
      {
        name: 'Client configuration',
        status: 'skip',
        message: 'No generated analytics module found, so the client config could not be inspected.',
        fix: 'Run `openhog init` to generate one, or check your own posthog.init() call against docs/TRAPS.md.',
      },
    ]
  }

  const results: CheckResult[] = []

  if (/capture_pageview:\s*['"]history_change['"]/.test(content)) {
    results.push({
      name: 'Pageview capture',
      status: 'fail',
      message: "capture_pageview is set to 'history_change', which skips the first page load.",
      fix: 'It captures on history changes only, so every direct visit and every reload sends $pageleave with no matching $pageview and Web Analytics reads near zero. Set capture_pageview: false and send $pageview by hand on route change.',
      docs: 'TRAPS.md#first-pageview',
    })
  } else if (/capture_pageview:\s*false/.test(content) && /capture\(['"]\$pageview['"]\)/.test(content)) {
    results.push({
      name: 'Pageview capture',
      status: 'pass',
      message: '$pageview is sent by hand, covering the landing route and every navigation.',
    })
  } else if (!/\$pageview/.test(content)) {
    results.push({
      name: 'Pageview capture',
      status: 'warn',
      message: 'No $pageview handling found. Web Analytics and bounce rate depend on it.',
      fix: 'Send $pageview on mount and on every route change.',
    })
  } else {
    results.push({ name: 'Pageview capture', status: 'pass', message: '$pageview is being sent.' })
  }

  if (/sanitize_properties/.test(content)) {
    if (/url\.origin/.test(content)) {
      results.push({
        name: 'URL sanitisation',
        status: 'pass',
        message: 'URLs are normalised and the origin is preserved.',
      })
    } else {
      results.push({
        name: 'URL sanitisation',
        status: 'warn',
        message: 'sanitize_properties rewrites URLs but may be stripping the origin.',
        fix: 'Web Analytics parses $current_url to attribute a visit to a domain. A bare path attributes to nothing, so the product reads zero visitors while events flow normally. Strip ids and query strings; keep the origin.',
        docs: 'TRAPS.md#url-origin',
      })
    }
  } else {
    results.push({
      name: 'URL sanitisation',
      status: 'warn',
      message: 'No sanitize_properties hook. Raw URLs with ids in them will become property values.',
      fix: 'Normalise $current_url, $pathname and $referrer through a route normaliser before they leave the browser.',
    })
  }

  if (/autocapture:\s*false/.test(content)) {
    results.push({
      name: 'Autocapture',
      status: 'pass',
      message: 'Autocapture is off, so only events you named are sent.',
    })
  } else {
    results.push({
      name: 'Autocapture',
      status: 'warn',
      message: 'Autocapture appears to be on.',
      fix: 'It records every click and input on the page. That inflates your bill, fills breakdowns with noise, and can capture text you never intended to collect. Set autocapture: false unless you specifically want it.',
    })
  }

  if (/startSessionRecording|session_recording/.test(content)) {
    if (/window\.location\.pathname\)/.test(content) && /\.then\(/.test(content)) {
      results.push({
        name: 'Replay start',
        status: 'pass',
        message: 'Replay catches up to the landing route after the SDK loads.',
      })
    } else {
      results.push({
        name: 'Replay start',
        status: 'warn',
        message: 'Replay may only start on the first in-app navigation, never on the landing route.',
        fix: 'The SDK is imported dynamically, so the first route effect runs while the instance is still null. Call your route sync again once the import resolves, or land-look-leave sessions are exactly the ones never recorded.',
        docs: 'TRAPS.md#replay-race',
      })
    }
  }

  return results
}

/** Service workers cache the JS bundle, so a deploy does not reach a browser. */
export function checkServiceWorker(context: DoctorContext): CheckResult {
  const hasServiceWorker = ['public/sw.js', 'public/service-worker.js', 'src/sw.ts', 'public/serviceWorker.js']
    .some((candidate) => exists(join(context.root, candidate)))
  if (!hasServiceWorker) {
    return { name: 'Service worker', status: 'skip', message: 'No service worker found.' }
  }
  return {
    name: 'Service worker',
    status: 'warn',
    message: 'This app registers a service worker, which caches your JS bundle.',
    fix: 'After deploying an analytics change, a returning browser keeps running the old bundle until the cache version changes. Unregister the service worker and clear caches before concluding a fix did not work.',
    docs: 'TRAPS.md#service-worker',
  }
}

// ---------------------------------------------------------------------------
// Live checks
// ---------------------------------------------------------------------------

export async function checkProjectSettings(context: DoctorContext): Promise<CheckResult[]> {
  if (!context.client || !context.projectId) {
    return [{ name: 'Project settings', status: 'skip', message: 'Not connected to PostHog.' }]
  }
  try {
    const project = await context.client.getProject(context.projectId)
    const results: CheckResult[] = []
    const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone

    if (!project.timezone || project.timezone === 'UTC') {
      results.push({
        name: 'Project timezone',
        status: 'warn',
        message: `Project timezone is ${project.timezone ?? 'unset'}; this machine is ${localZone}.`,
        fix: `Set it to the timezone your users live in (Settings → Project). Under UTC an evening product has every night split across two calendar days, which corrupts every daily metric and every "by hour" chart.`,
      })
    } else {
      results.push({
        name: 'Project timezone',
        status: 'pass',
        message: `Project timezone is ${project.timezone}.`,
      })
    }

    if (project.week_start_day === 0) {
      results.push({
        name: 'Week start',
        status: 'warn',
        message: 'Weeks start on Sunday.',
        fix: 'If your team thinks in Monday-to-Sunday weeks, change it in Settings → Project. Weekly retention cohorts are grouped by this, so changing it later re-shapes historical charts.',
      })
    } else {
      results.push({ name: 'Week start', status: 'pass', message: 'Weeks start on Monday.' })
    }
    return results
  } catch (error) {
    return [
      {
        name: 'Project settings',
        status: 'fail',
        message: error instanceof PostHogError ? error.message : String(error),
        fix: error instanceof PostHogError ? error.hint : undefined,
      },
    ]
  }
}

/**
 * The end-to-end proof: send an event through the public ingest endpoint and
 * poll until it comes back out of the query API. This is the check that
 * distinguishes "my code is wrong" from "my key is wrong".
 */
export async function checkLiveIngest(context: DoctorContext): Promise<CheckResult> {
  if (context.offline) {
    return { name: 'Live round-trip', status: 'skip', message: 'Skipped (--offline).' }
  }
  if (!context.client || !context.projectId || !context.publicKey) {
    return {
      name: 'Live round-trip',
      status: 'skip',
      message: 'Needs both a personal API key and a project key (phc_).',
    }
  }

  const marker = `openhog_doctor_${Math.random().toString(36).slice(2, 10)}`
  const progress = context.onProgress ?? (() => {})

  try {
    await context.client.capture(context.publicKey, {
      event: 'openhog_doctor_ping',
      distinctId: marker,
      properties: { marker, source: 'openhog doctor' },
    })
  } catch (error) {
    return {
      name: 'Live round-trip',
      status: 'fail',
      message: `Ingest rejected the test event: ${error instanceof Error ? error.message : String(error)}`,
      fix: 'The project key or the region host is wrong. A key from a US project sent to the EU host fails exactly like this.',
    }
  }

  // Ingestion is asynchronous. 30 seconds is generous for cloud and usually
  // enough for a self-hosted instance under light load.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 3000))
    progress(`waiting for the test event to land (${(attempt + 1) * 3}s)`)
    try {
      const response = await context.client.query<{ results?: unknown[][] }>(context.projectId, {
        kind: 'HogQLQuery',
        query: `SELECT count() FROM events WHERE event = 'openhog_doctor_ping' AND properties.marker = '${marker}' AND timestamp > now() - INTERVAL 1 HOUR`,
      })
      const count = Number(response.results?.[0]?.[0] ?? 0)
      if (count > 0) {
        return {
          name: 'Live round-trip',
          status: 'pass',
          message: `Test event arrived in ${(attempt + 1) * 3}s. Ingestion works end to end.`,
        }
      }
    } catch {
      // Query API can 400 while the events table is warming. Keep polling.
    }
  }

  return {
    name: 'Live round-trip',
    status: 'fail',
    message: 'The test event was accepted by ingest but never appeared in queries within 30s.',
    fix: 'Usually ingestion lag on a busy project — re-run in a minute. If it persists, check that the project key belongs to the project id you are querying.',
  }
}

/** Are the events the plan promises actually arriving? */
export async function checkEventsArriving(context: DoctorContext): Promise<CheckResult> {
  if (!context.client || !context.projectId || !context.plan) {
    return { name: 'Events arriving', status: 'skip', message: 'Needs a connection and a tracking plan.' }
  }
  const planned = context.plan.events.filter((event) => event.emitted).map((event) => event.name)
  if (!planned.length) {
    return { name: 'Events arriving', status: 'skip', message: 'The plan has no emitted events yet.' }
  }

  try {
    const definitions = await context.client.listEventDefinitions(context.projectId)
    const seen = new Set(definitions.map((definition) => definition.name))
    const missing = planned.filter((name) => !seen.has(name))

    if (!missing.length) {
      return {
        name: 'Events arriving',
        status: 'pass',
        message: `All ${planned.length} planned events have been seen by PostHog.`,
      }
    }
    if (missing.length === planned.length) {
      return {
        name: 'Events arriving',
        status: 'fail',
        message: 'None of your planned events have ever reached PostHog.',
        fix: 'The SDK is not initialising in production. Work through the CSP, project key and live round-trip checks above — one of them is the cause.',
      }
    }
    return {
      name: 'Events arriving',
      status: 'warn',
      message: `${missing.length} of ${planned.length} planned events have never been seen: ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? '…' : ''}`,
      fix: 'Either the call site is unreachable, or the code path is genuinely rare. Check the ones you expect to be common first.',
    }
  } catch (error) {
    return {
      name: 'Events arriving',
      status: 'skip',
      message: `Could not read event definitions: ${error instanceof Error ? error.message : String(error)}`,
      fix: 'Needs the event_definition:read scope on your personal API key.',
    }
  }
}

/** Ad blockers stop about a fifth of traffic reporting. Suggest a proxy. */
export function checkAdBlockerExposure(context: DoctorContext): CheckResult {
  const host = context.config?.posthog.ingestHost ?? 'https://us.i.posthog.com'
  if (!/posthog\.com/.test(host)) {
    return {
      name: 'Ad-blocker exposure',
      status: 'pass',
      message: `Events go to ${host}, which is not a known-blocked domain.`,
    }
  }
  return {
    name: 'Ad-blocker exposure',
    status: 'warn',
    message: `Events go directly to ${host}, which most ad blockers block.`,
    fix: 'Typically 15-30% of traffic never reports, and it is not a random 15-30% — technical and privacy-conscious users are heavily over-represented, so your numbers are skewed as well as low. Serve PostHog through a reverse proxy on your own domain (a rewrite in vercel.json or next.config.js) and point the SDK at that path.',
    docs: 'TRAPS.md#ad-blockers',
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export async function runDoctor(context: DoctorContext): Promise<CheckResult[]> {
  const results: CheckResult[] = []

  results.push(checkPublicKey(context))
  results.push(checkContentSecurityPolicy(context))
  results.push(...checkClientConfiguration(context))
  results.push(checkAdBlockerExposure(context))
  results.push(checkServiceWorker(context))
  results.push(...(await checkProjectSettings(context)))
  results.push(await checkEventsArriving(context))
  results.push(await checkLiveIngest(context))

  return results
}

export function doctorExitCode(results: CheckResult[]): number {
  return results.some((result) => result.status === 'fail') ? 1 : 0
}
